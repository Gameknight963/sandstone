import { getPublicSuffix } from "tough-cookie";
import {parse_referrer_policy, request_referrer, request_origin} from '../referrer.mjs';
import {cookie_header} from './cookie_policy.mjs';

export function same_site(a, b) {
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
  const mode = options.mode || (context.navigation ? 'navigate' : 'no-cors');
  const destination = options.destination;
  let policy = parse_referrer_policy(options.referrerPolicy || context.referrerPolicy);
  let referrer = options.referrer === '' ? '' : options.referrer && options.referrer !== 'about:client' ? options.referrer : context.url || '';
  let tainted = false, crossSiteRedirect = !same_site(top,url), cors = false;
  delete options.mode;
  delete options.referrer;
  delete options.referrerPolicy;
  delete options.destination;
  let redirected = false;
  for (let hop = 0; hop <= 20; hop++) {
    const headers = new Headers(options.headers);
    headers.delete("cookie");
    headers.delete('origin');headers.delete('referer');
    if (mode === 'same-origin' && source.origin !== url.origin) throw new TypeError('Cross-origin request with same-origin mode');
    if (mode === 'cors' && source.origin !== url.origin) cors = true;
    const credentials = options.credentials || "include";
    const allowed = credentials === "include" || (credentials === "same-origin" && url.origin === source.origin && !cors);
    const safe_method = /^(GET|HEAD)$/i.test(options.method || "GET");
    const sameSiteContext = same_site(top, source) && same_site(top, url) && !crossSiteRedirect ? "strict" : context.navigation && !context.nested && safe_method ? "lax" : "none";
    // Font loads send their document Origin even for a same-origin URL.
    const origin = request_origin(source.href,url.href,{method:options.method,mode,policy,tainted,cors: cors || destination === 'font'});
    if (origin !== null) headers.set('origin',origin);
    referrer = request_referrer(referrer,url.href,policy);
    if (referrer) headers.set('referer',referrer);
    if (allowed) {
      const cookies = cookie_header(data.cookies,url.href,{sameSiteContext,allowUnsafe:context.navigation&&!context.nested&&!safe_method});
      if (cookies) headers.set("cookie", cookies);
    }
    const response = await transport(url.href, {...options, headers: Object.fromEntries(headers), redirect: "manual"});
    if (allowed) {
      const raw = response.raw_headers || [...response.headers];
      const setCookies = response.headers.getSetCookie?.() || [];
      for (const [key, value] of raw) {
        if (key.toLowerCase() === "set-cookie") setCookies.push(value);
      }
      for (const value of new Set(setCookies)) data.setCookie(url.href, value,true,{crossSite:sameSiteContext==='none',topLevel:context.navigation&&!context.nested});
    }
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status) || redirect === "manual") {
      // libcurl's response metadata is non-configurable; wrap instead of mutating it.
      const output = new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
      Object.defineProperties(output, {
        url: {value: url.href}, redirected: {value: redirected},
        raw_headers: {value: response.raw_headers || [...response.headers]},
        request_referrer: {value:referrer}
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
      if (source.origin !== url.origin) tainted = true;
      if (!same_site(top,next)) crossSiteRedirect = true;
      const nextHeaders = new Headers(options.headers);
      for (const key of ["authorization", "proxy-authorization", "cookie"]) nextHeaders.delete(key);
      options.headers = Object.fromEntries(nextHeaders);
    }
    policy = parse_referrer_policy(response.headers.get('referrer-policy'),policy);
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
