import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorage } from "../src/frame/polyfill/storage.mjs";
import { serialize_request } from "../src/frame/polyfill/request.mjs";
import { SiteDataStore } from "../src/host/site_data.mjs";
import { fetch_with_cookies } from "../src/host/request.mjs";
import { data_to_array } from "../src/util.mjs";
import { rewrite_source } from "../src/frame/rewrite/javascript.mjs";

function memory_storage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}

test("Storage supports strict assignments, empty values, enumeration and deletion", () => {
  let saved;
  const storage = new FakeStorage([["initial", "1"]], entries => saved = entries);
  storage.empty = "";
  storage.numeric = 42;
  assert.equal(storage.getItem("empty"), "");
  assert.equal(storage.numeric, "42");
  assert.equal(storage.length, 3);
  assert.deepEqual(Object.keys(storage), ["initial", "empty", "numeric"]);
  assert.equal(storage.key(1), "empty");
  assert.equal(storage.key(20), null);
  delete storage.initial;
  assert.equal(storage.getItem("initial"), null);
  assert.deepEqual(saved, [["empty", ""], ["numeric", "42"]]);
  storage.clear();
  assert.equal(storage.length, 0);
  assert.equal(Object.prototype.toString.call(storage), "[object Storage]");
});

test("Request serialization preserves multipart boundary and does not mutate init", async () => {
  const body = new FormData();
  body.append("field", "value");
  body.append("file", new Blob(["file contents"]), "test.txt");
  const init = {method: "POST", body, headers: {"X-Test": "yes"}};
  const request = await serialize_request("/upload", init, "https://example.com/page");
  assert.equal(request.url, "https://example.com/upload");
  assert.match(request.options.headers["content-type"], /^multipart\/form-data; boundary=/);
  const boundary = request.options.headers["content-type"].split("boundary=")[1];
  assert.match(new TextDecoder().decode(request.options.body), new RegExp(boundary));
  assert.equal(init.body, body);
  assert.deepEqual(init.headers, {"X-Test": "yes"});
});

test("Request inputs retain method, credentials and explicit empty bodies", async () => {
  const input = new Request("https://example.com/api", {method: "POST", body: "old", credentials: "omit"});
  const request = await serialize_request(input, {body: ""}, "https://other.test/");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body.byteLength, 0);
  assert.equal(request.options.credentials, "omit");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(serialize_request("/", {signal: controller.signal}, "https://example.com/"), {name: "AbortError"});
});

test("Request serialization works when the browser exposes no FormData body stream", async () => {
  const NativeRequest = globalThis.Request;
  globalThis.Request = class extends NativeRequest { get body() { return null; } };
  try {
    const data = new FormData();
    data.set("field", "value");
    const request = await serialize_request("https://example.com/upload", {method: "POST", body: data});
    assert.match(new TextDecoder().decode(request.options.body), /name="field"/);
  } finally { globalThis.Request = NativeRequest; }
});

test("Cookies obey domains, paths, HttpOnly and script write restrictions", () => {
  const data = new SiteDataStore();
  data.setCookie("https://example.com/login", "session=secret; Secure; HttpOnly; Path=/");
  data.setCookie("https://example.com/login", "theme=dark; Path=/");
  data.setCookie("https://example.com/login", "private=1; Path=/account");
  data.setCookie("https://example.com/", "bad=1; Domain=other.test");
  data.setCookie("https://example.com/", "session=stolen; Path=/", false);
  assert.match(data.cookies.getCookieStringSync("https://example.com/"), /session=secret/);
  assert.doesNotMatch(data.cookies.getCookieStringSync("https://example.com/"), /private|bad/);
  const visible = data.documentCookies("https://example.com/");
  assert.equal(visible.cookies.some(cookie => cookie.httpOnly), false);
  assert.equal(visible.cookies.some(cookie => cookie.key === "session"), false);
  assert.equal(data.documentCookies("https://other.test/").cookies.length, 0);
});

test("Site data persists durable cookies and isolated localStorage, and clears without resurrection", () => {
  const storage = memory_storage();
  storage.setItem("proxy_local_storage", JSON.stringify({"https://legacy.test": [["key", "old"]]}));
  const data = new SiteDataStore(storage);
  data.setCookie("https://example.com/", "session=1; Path=/");
  data.setCookie("https://example.com/", "durable=1; Path=/; Max-Age=3600");
  data.setLocal("https://example.com", [["key", "secure"]]);
  data.setLocal("http://example.com", [["key", "insecure"]]);
  data.setLocal("https://other.test", [["key", "other"]]);
  const reloaded = new SiteDataStore(storage);
  assert.equal(reloaded.persistent, true);
  assert.match(reloaded.cookies.getCookieStringSync("https://example.com/"), /durable=1/);
  assert.doesNotMatch(reloaded.cookies.getCookieStringSync("https://example.com/"), /session=1/);
  assert.equal(reloaded.local["https://example.com"][0][1], "secure");
  reloaded.clear("example.com");
  reloaded.clear("legacy.test");
  const cleared = new SiteDataStore(storage);
  assert.equal(cleared.local["https://legacy.test"], undefined);
  assert.equal(cleared.local["https://example.com"], undefined);
  assert.equal(cleared.local["http://example.com"], undefined);
  assert.equal(cleared.local["https://other.test"][0][1], "other");
  assert.equal(cleared.cookies.getCookieStringSync("https://example.com/"), "");
});

test("Denied browser storage retains a functioning in-memory session", () => {
  const denied = {getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }};
  const data = new SiteDataStore(denied);
  data.setLocal("https://example.com", [["x", "1"]]);
  data.setCookie("https://example.com/", "x=1");
  assert.equal(data.persistent, false);
  assert.equal(data.local["https://example.com"][0][1], "1");
  assert.equal(data.cookies.getCookieStringSync("https://example.com/"), "x=1");
});

test("Redirects apply cookies between hops and convert POST to GET", async () => {
  const data = new SiteDataStore();
  const seen = [];
  const transport = async (url, init) => {
    seen.push({url, ...init});
    if (seen.length === 1) return new Response(null, {status: 302, headers: {location: "/home", "set-cookie": "login=yes; Path=/; HttpOnly"}});
    const response = new Response("logged in");
    Object.defineProperty(response, "url", {value: url});
    return response;
  };
  const response = await fetch_with_cookies(transport, data, "https://example.com/login", {
    method: "POST", body: "user=test", headers: {"Content-Type": "application/x-www-form-urlencoded"}
  }, {navigation: true});
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].body, undefined);
  assert.equal(seen[1].headers.cookie, "login=yes");
  assert.equal(seen[1].headers["content-type"], undefined);
  assert.equal(response.redirected, true);
  assert.equal(await response.text(), "logged in");
});

test("Credential omission and cross-origin redirects do not leak cookies or authorization", async () => {
  const data = new SiteDataStore();
  data.setCookie("https://example.com/", "login=yes; Path=/");
  const seen = [];
  const transport = async (url, init) => {
    seen.push(init);
    return seen.length === 1 ? new Response(null, {status: 307, headers: {location: "https://other.test/"}}) : new Response("done");
  };
  await fetch_with_cookies(transport, data, "https://example.com/", {
    credentials: "omit", headers: {Authorization: "secret"}
  });
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[1].headers.authorization, undefined);
});

test("Typed-array subviews send only their own byte range", () => {
  const bytes = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  assert.deepEqual([...data_to_array(new Uint16Array(bytes.buffer, 2, 2))], [2, 0, 3, 0]);
});

test("JavaScript rewriting covers shorthand, computed keys and assignments without changing local bindings", () => {
  const globals = ["window", "location", "fetch", "localStorage", "document"];
  const source = `
    const result = {localStorage, url: location, [document.title]: window};
    location = '/next';
    function local(fetch = () => 1) { return fetch(); }
    function hoisted() { const first = location; var location = 'local'; return first; }
    try {} catch (document) { document.title = 'local'; }
    { let window = 'local'; result.local = window; }
    result.computed = obj[location];
    result.property = obj.location;
  `;
  const rewritten = rewrite_source(source, globals);
  assert.match(rewritten, /localStorage: __ctx__\.localStorage/);
  assert.match(rewritten, /url: __ctx__\.location/);
  assert.match(rewritten, /\[__ctx__\.document\.title\]: __ctx__\.window/);
  assert.match(rewritten, /__ctx__\.location = '\/next'/);
  assert.match(rewritten, /return fetch\(\)/);
  assert.match(rewritten, /const first = location; var location/);
  assert.match(rewritten, /catch \(document\) \{ document\.title/);
  assert.match(rewritten, /result\.local = window/);
  assert.match(rewritten, /obj\[__ctx__\.location\]/);
  assert.match(rewritten, /obj\.location/);
  // Parse the rewritten output, checking that shorthand expansion remains valid JavaScript.
  rewrite_source(rewritten, []);
});

test("Destructuring declarations, default values and function expressions retain lexical scope", () => {
  const source = `
    const {fetch: localFetch, key = location} = config;
    const fn = function window() { return window; };
    const arrow = ({document}, ...location) => document.title + location.length;
    const local = localFetch;
  `;
  const rewritten = rewrite_source(source, ["window", "document", "location", "fetch"]);
  assert.match(rewritten, /key = __ctx__\.location/);
  assert.match(rewritten, /function window\(\) \{ return window/);
  assert.match(rewritten, /document\.title \+ location\.length/);
  rewrite_source(rewritten, []);
});
