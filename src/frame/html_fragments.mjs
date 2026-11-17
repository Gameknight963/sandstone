import {scripting_html} from './scripting_html.mjs';
import {defer_declarative_roots} from './declarative_html.mjs';

// Parse with native context rules in a document without a browsing context.
// Detached elements in the live document can start resource requests before
// their nodes have been rewritten.
const element=globalThis.Element?.prototype,node=globalThis.Node?.prototype;
const inner=element&&Object.getOwnPropertyDescriptor(element,'innerHTML').set;
const outer=element&&Object.getOwnPropertyDescriptor(element,'outerHTML').set;
const adjacent=element?.insertAdjacentHTML,append=node?.appendChild,remove=node?.removeChild;
const parent=node&&Object.getOwnPropertyDescriptor(node,'parentElement').get;
const first=node&&Object.getOwnPropertyDescriptor(node,'firstChild').get;
const owner=node&&Object.getOwnPropertyDescriptor(node,'ownerDocument').get;
const type=node&&Object.getOwnPropertyDescriptor(node,'nodeType').get;
const importNode=globalThis.Document?.prototype.importNode;
const contextual=globalThis.Range?.prototype.createContextualFragment;
const select=globalThis.Range?.prototype.selectNodeContents;
const NativeSanitizer=globalThis.Sanitizer,sanitizer_config=NativeSanitizer?.prototype.get;
const create=globalThis.Document?.prototype.createElement;
let validation_document;

function clone_context(context){
  const kind=type.call(context),source=kind===9?context:owner.call(context);
  const inert=source.contentType==='text/html'?source.implementation.createHTMLDocument(''):
    source.implementation.createDocument(source.documentElement?.namespaceURI||null,'',null);
  const copy=kind===9?inert:kind===11?inert.createDocumentFragment():importNode.call(inert,context,false);
  let original=context,ancestor=copy;
  // The fragment parser's form pointer and namespace integration points can
  // depend on ancestors, even when those ancestors are detached.
  while((original=parent.call(original))){
    const container=importNode.call(inert,original,false);
    append.call(container,ancestor);ancestor=container;
  }
  return {inert,copy};
}

export function range_fragment(context,value){
  const {inert,copy}=clone_context(context),range=inert.createRange();
  let parsing=copy;
  const element=type.call(copy)===1?copy:parent.call(copy);
  let raw=false;
  if(element?.namespaceURI==='http://www.w3.org/1999/xhtml'&&element.localName==='noscript'){
    // Style has the same raw-text tokenizer state regardless of scripting.
    parsing=inert.createElement('style');
    const ancestor=parent.call(element);if(ancestor)append.call(ancestor,parsing);
    raw=true;
  }
  select.call(range,parsing);
  // Unlike innerHTML, this native API creates executable scripts. Leave them
  // untouched until the ordinary insertion hooks prepare their execution.
  if(raw)return contextual.call(range,value);
  const protected_html=scripting_html(parsing,value);
  const fragment=contextual.call(range,protected_html.value);
  protected_html.restore(fragment);
  return fragment;
}

export function html_fragment(context,value,operation='inner',position){
  const {inert,copy}=clone_context(context);
  let container=copy;
  if(operation==='outer'||operation==='adjacent'&&['beforebegin','afterend'].includes(position)){
    container=parent.call(copy);
    if(!container){container=inert.createDocumentFragment();append.call(container,copy);}
  }
  if(operation==='inner')inner.call(copy,value);
  else if(operation==='outer')outer.call(copy,value);
  else{
    adjacent.call(copy,position,value);
    if(container!==copy)remove.call(container,copy);
  }
  const fragment=inert.createDocumentFragment();
  while(first.call(container))append.call(fragment,first.call(container));
  for(const script of fragment.querySelectorAll('script'))script.__sandstone_inert__=true;
  return fragment;
}

export function setter_fragment(context,method,args){
  let text,runScripts=false,options=args[1];
  const converted=[...args],captured=Object.create(null);
  if(args.length)converted[0]={toString(){
    if(typeof args[0]==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
    text=`${args[0]}`;return '';
  }};
  if(options&&(typeof options==='object'||typeof options==='function')){
    const source=options;
    converted[1]=new Proxy(Object.create(null),{get(_target,key){
      let value=Reflect.get(source,key,source);
      if(key==='runScripts')value=runScripts=!!value;
      if(key==='sanitizer'&&value!==undefined&&typeof value!=='string'&&NativeSanitizer){
        // Let native WebIDL consume a sanitizer dictionary once, retaining a
        // private snapshot for parsing after all argument coercions finish.
        let config;try{config=sanitizer_config.call(value);}catch{config=value;}
        value=new NativeSanitizer(config);
      }
      captured[key]=value;return value;
    }});
    options=captured;
  }
  validation_document??=document.implementation.createHTMLDocument('');
  Reflect.apply(method,create.call(validation_document,'div'),converted);
  // Coercions can move the receiver, change a form ancestor, or mutate a
  // namespace integration point. Capture the native parsing context afterward.
  const {inert,copy}=clone_context(context),protected_roots=defer_declarative_roots(context,text),protected_scripting=scripting_html(context,protected_roots.value);
  Reflect.apply(method,copy,[protected_scripting.value,options]);
  const container=copy instanceof HTMLTemplateElement?copy.content:copy;
  protected_scripting?.restore(container);protected_roots?.restore(container);
  const fragment=inert.createDocumentFragment();while(first.call(container))append.call(fragment,first.call(container));
  return {fragment,runScripts};
}
