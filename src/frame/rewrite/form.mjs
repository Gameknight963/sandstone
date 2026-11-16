import { ctx, convert_url } from "../context.mjs";
import * as loader from "../loader.mjs";
import { serialize_request } from "../polyfill/request.mjs";

const form_prototype = globalThis.HTMLFormElement?.prototype;
const method_descriptor = form_prototype && Object.getOwnPropertyDescriptor(form_prototype, "method");
const enctype_descriptor = form_prototype && Object.getOwnPropertyDescriptor(form_prototype, "enctype");
const attribute = (element, name) => element ? Element.prototype.getAttribute.call(element, name) : null;

function method_for(form, submitter) {
  return attribute(submitter, "formmethod") !== null ? submitter.formMethod || "get" : method_descriptor.get.call(form);
}

async function submit(form, submitter) {
  const action = attribute(submitter, "formaction") ?? attribute(form, "action") ?? ctx.location.href;
  const method = method_for(form, submitter);
  if (method === "dialog") return;
  const url = new URL(convert_url(action || ctx.location.href, ctx.document.baseURI));
  const data = submitter ? new FormData(form, submitter) : new FormData(form);
  const params = new URLSearchParams();
  for (const [key, value] of data) params.append(key, typeof value === "string" ? value : value.name);
  if (method === "get") {
    url.search = params.toString();
    return loader.navigate(loader.frame_id, url.href);
  }
  const enctype = attribute(submitter, "formenctype") !== null ? submitter.formEnctype || "application/x-www-form-urlencoded" : enctype_descriptor.get.call(form);
  let body = data;
  let headers;
  if (enctype === "application/x-www-form-urlencoded") body = params;
  else if (enctype === "text/plain") {
    body = [...params].map(([key, value]) => `${key}=${value}\r\n`).join("");
    headers = {"Content-Type": "text/plain"};
  }
  const request = await serialize_request(url.href, {method: "POST", body, headers}, ctx.location.href);
  return loader.navigate(loader.frame_id, url.href, true, {
    method: "POST", headers: request.options.headers, body: request.options.body
  });
}

if (form_prototype) {
  // Named controls may mask form.submit, form.method and form.enctype. Keep that
  // native behavior and intercept the prototype API instead of assigning an own
  // submit property, which HTMLFormElement's named-property setter can reject.
  form_prototype.submit = function submit_form() {
    if (!(this instanceof HTMLFormElement)) throw new TypeError("Invalid form receiver");
    submit(this).catch(console.error);
  };
}

// Run after form-level handlers so frameworks can cancel their own submissions.
if (typeof window !== "undefined") window.addEventListener("submit", event => {
  if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
  if (method_for(event.target, event.submitter) === "dialog") return;
  event.preventDefault();
  submit(event.target, event.submitter).catch(console.error);
});
