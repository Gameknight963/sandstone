import { ctx, convert_url } from "../context.mjs";
import * as loader from "../loader.mjs";
import { serialize_request } from "../polyfill/request.mjs";

async function submit(form, submitter) {
  const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? ctx.location.href;
  const method = (submitter?.getAttribute("formmethod") || form.method || "get").toLowerCase();
  if (method === "dialog") return;
  const url = new URL(convert_url(action || ctx.location.href, ctx.document.baseURI));
  const data = submitter ? new FormData(form, submitter) : new FormData(form);
  const params = new URLSearchParams();
  for (const [key, value] of data) params.append(key, typeof value === "string" ? value : value.name);
  if (method === "get") {
    url.search = params.toString();
    return loader.navigate(loader.frame_id, url.href);
  }
  const enctype = submitter?.getAttribute("formenctype") || form.enctype;
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

export function rewrite_form(form) {
  form.submit = () => { submit(form).catch(console.error); };
}

// Run after form-level handlers so frameworks can cancel their own submissions.
if (typeof window !== "undefined") window.addEventListener("submit", event => {
  if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
  if (event.target.method === "dialog") return;
  event.preventDefault();
  submit(event.target, event.submitter).catch(console.error);
});
