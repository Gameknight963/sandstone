import { ctx, convert_url } from "../context.mjs";
import { serialize_request } from "../polyfill/request.mjs";
import {navigate_target,navigation_target} from '../navigation_targets.mjs';
import {document_states} from '../document_identity.mjs';
import {navigation_activation} from '../user_activation.mjs';

const form_prototype = globalThis.HTMLFormElement?.prototype;
const method_descriptor = form_prototype && Object.getOwnPropertyDescriptor(form_prototype, "method");
const enctype_descriptor = form_prototype && Object.getOwnPropertyDescriptor(form_prototype, "enctype");
const attribute = (element, name) => element ? Element.prototype.getAttribute.call(element, name) : null;
const constructing=new WeakSet();
const connected=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const button_form=globalThis.HTMLButtonElement&&Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype,'form').get;
const input_form=globalThis.HTMLInputElement&&Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'form').get;
const button_value=globalThis.HTMLButtonElement&&Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype,'value').get;
const input_value=globalThis.HTMLInputElement&&Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get;
const close_dialog=globalThis.HTMLDialogElement?.prototype.close;
const submitters=document_states('form-submitters');
export function configure_form_submissions(){submitters.set(globalThis.document,submit);}
function submitter_property(submitter,button,input){
  try{return button.call(submitter);}catch{return input.call(submitter);}
}

function method_for(form, submitter) {
  return attribute(submitter, "formmethod") !== null ? submitter.formMethod || "get" : method_descriptor.get.call(form);
}

export async function submit(form, submitter) {
  const document_owner=owner.call(form);
  if(document_owner!==document)return submitters.get(document_owner)?.(form,submitter);
  if(!connected.call(form)||constructing.has(form))return;
  const action = attribute(submitter, "formaction") ?? attribute(form, "action") ?? ctx.location.href;
  const method = method_for(form, submitter);
  const target=navigation_target(form,attribute(submitter,'formtarget'));
  const navigation = /(?:^|\s)noreferrer(?:\s|$)/i.test(attribute(form,'rel') || '') ? {referrerPolicy:'no-referrer'} : {};
  if (method === "dialog") {
    const dialog=Element.prototype.closest.call(form,'dialog');
    if(dialog){
      close_dialog.call(dialog,submitter?submitter_property(submitter,button_value,input_value):'');
    }
    return;
  }
  const url = new URL(convert_url(action || ctx.location.href, ctx.document.baseURI));
  const associated=submitter&&submitter_property(submitter,button_form,input_form)===form;
  let data;constructing.add(form);
  try{data=associated?new FormData(form,submitter):new FormData(form);}finally{constructing.delete(form);}
  if(!connected.call(form)||owner.call(form)!==document)return;
  navigation.activation=navigation_activation();
  const params = new URLSearchParams();
  for (const [key, value] of data) params.append(key, typeof value === "string" ? value : value.name);
  if (method === "get") {
    url.search = params.toString();
    return navigate_target(url.href,target,null,navigation);
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
  return navigate_target(url.href,target, {
    method: "POST", headers: request.options.headers, body: request.options.body
  },navigation);
}

if (form_prototype) {
  // Named controls may mask form.submit, form.method and form.enctype. Keep that
  // native behavior and intercept the prototype API instead of assigning an own
  // submit property, which HTMLFormElement's named-property setter can reject.
  form_prototype.submit = function submit_form() {
    method_descriptor.get.call(this);
    submit(this).catch(console.error);
  };
}
