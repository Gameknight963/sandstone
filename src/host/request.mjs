import { getPublicSuffix } from "tough-cookie";

function same_site(a, b) {
  const domain = hostname => getPublicSuffix(hostname, {ignoreError: true}) || hostname;
  return a.protocol === b.protocol && domain(a.hostname) === domain(b.hostname);
}

// Redirects must pass through the cookie jar at every hop, including login flows.
export async function fetch_with_cookies(transport, data, input, init = {}, context = {}) {
  let url = new URL(input);
  const source = new URL(context.url || url);
  const top = new URL(context.top_url || source);
  const options = {...init, headers: Object.fromEntries(new Headers(init.headers))};
  const redirect = options.redirect || "follow";
  let redirected = false;
  for (let hop = 0; hop <= 20; hop++) {
    const headers = new Headers(options.headers);
    headers.delete("cookie");
    const credentials = options.credentials || "include";
    const allowed = credentials === "include" || (credentials === "same-origin" && url.origin === source.origin);
    const safe_method = /^(GET|HEAD)$/i.test(options.method || "GET");
    const sameSiteContext = same_site(top, url) ? "strict" : context.navigation && safe_method ? "lax" : "none";
    if (allowed) {
      const cookies = data.cookies.getCookieStringSync(url.href, {sameSiteContext});
      if (cookies) headers.set("cookie", cookies);
    }
    const response = await transport(url.href, {...options, headers: Object.fromEntries(headers), redirect: "manual"});
    if (allowed) {
      const raw = response.raw_headers || [...response.headers];
      const setCookies = response.headers.getSetCookie?.() || [];
      for (const [key, value] of raw) {
        if (key.toLowerCase() === "set-cookie") setCookies.push(value);
      }
      for (const value of new Set(setCookies)) data.setCookie(url.href, value);
    }
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status) || redirect === "manual") {
      // libcurl's response metadata is non-configurable; wrap instead of mutating it.
      const output = new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
      Object.defineProperties(output, {
        url: {value: url.href}, redirected: {value: redirected},
        raw_headers: {value: response.raw_headers || [...response.headers]}
      });
      return output;
    }
    if (redirect === "error") {
      await response.body?.cancel();
      throw new TypeError("Redirect disallowed");
    }
    if (hop === 20) {
      await response.body?.cancel();
      throw new TypeError("Too many redirects");
    }
    const next = new URL(location, url);
    if (!/^https?:$/.test(next.protocol)) throw new TypeError("Invalid redirect URL");
    if (next.origin !== url.origin) {
      const nextHeaders = new Headers(options.headers);
      for (const key of ["authorization", "proxy-authorization", "cookie"]) nextHeaders.delete(key);
      options.headers = Object.fromEntries(nextHeaders);
    }
    if ((response.status === 303 && !/^(GET|HEAD)$/i.test(options.method || "GET")) ||
        ([301, 302].includes(response.status) && /^POST$/i.test(options.method || "GET"))) {
      options.method = "GET";
      delete options.body;
      const nextHeaders = new Headers(options.headers);
      for (const key of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) nextHeaders.delete(key);
      options.headers = Object.fromEntries(nextHeaders);
    }
    await response.body?.cancel();
    url = next;
    redirected = true;
  }
}
