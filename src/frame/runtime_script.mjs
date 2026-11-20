import {native_dom} from './dom_operations.mjs';

const prototype=globalThis.Document?.prototype;
const head=prototype&&Object.getOwnPropertyDescriptor(prototype,'head').get;
const body=prototype&&Object.getOwnPropertyDescriptor(prototype,'body').get;
const root=prototype&&Object.getOwnPropertyDescriptor(prototype,'documentElement').get;

// XML createElement('script') has no namespace and cannot execute. Runtime
// helpers need an HTML script in both HTML and XML documents, including SVG
// documents whose native document.head and document.body are null.
export function create_runtime_script(){
  const script=native_dom.create.call(document,'http://www.w3.org/1999/xhtml','script');
  script.__rewritten__=true;
  return script;
}
export function append_runtime_script(script,{bodyFirst=false}={}){
  const parent=bodyFirst&&body.call(document)||head.call(document)||root.call(document);
  return native_dom.append.call(parent,script);
}
