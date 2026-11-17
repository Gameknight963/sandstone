import * as rewrite from "../rewrite/index.mjs";
import { proxy_function, get_dom_property } from "../context.mjs";
import * as loader from "../loader.mjs";
import {mutate_styles as mutate_style_sources} from '../rewrite/style.mjs';
import {mutate_document_base} from '../document_base.mjs';
import {reconcile_iframes} from '../iframe_lifecycle.mjs';
import {html_fragment,range_fragment} from '../html_fragments.mjs';
import {rewrite_event_attributes} from '../event_attributes.mjs';
import {clone_media} from '../rewrite/media.mjs';
const mutate_styles=(nodes,operation)=>mutate_document_base(()=>mutate_style_sources(nodes,operation));

function prepare(node) {
  const pending = rewrite.element(node);
  pending?.catch(console.error);
}

function execute(node) {
  if (!loader.is_loaded) return;
  if (typeof node?.__sandstone_execute__ === "function") node.__sandstone_execute__();
  for (const child of get_dom_property(node, "children") || []) execute(child);
}

function intercept(target, key, first_only = false) {
  if (!target || typeof target[key] !== "function") return;
  proxy_function(target, key, (original, receiver, args) => {
    const nodes = first_only ? args.slice(0, 1) : args;
    // A fragment is empty after insertion; retain its children for execution.
    const inserted = nodes.flatMap(node => node?.nodeType === 11 ? [...node.childNodes] : [node]);
    const result = mutate_styles([receiver, ...nodes], () => {
      for (const node of nodes) prepare(node);
      return Reflect.apply(original, receiver, args);
    });
    for (const node of inserted) {reconcile_iframes(node);execute(node);}
    return result;
  });
}

if (globalThis.Node) {
  const clone=Node.prototype.cloneNode;
  const first=Object.getOwnPropertyDescriptor(Node.prototype,'firstChild').get;
  const next=Object.getOwnPropertyDescriptor(Node.prototype,'nextSibling').get;
  const kind=Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
  function restore_media(source,copy){
    if(clone_media(source,copy))rewrite_event_attributes(copy);
    let original=first.call(source),child=first.call(copy);
    while(original&&child){restore_media(original,child);original=next.call(original);child=next.call(child);}
    if(source instanceof HTMLTemplateElement&&copy instanceof HTMLTemplateElement)restore_media(source.content,copy.content);
  }
  Node.prototype.cloneNode=new Proxy(clone,{apply(target,receiver,args){
    const copy=Reflect.apply(target,receiver,args);
    // Source attributes may temporarily be absent or contain local blobs.
    // Restore their virtual values without ever assigning remote native URLs.
    if(kind.call(copy)!==9)restore_media(receiver,copy);
    return copy;
  }});
  for (const key of ["appendChild", "insertBefore", "replaceChild"]) intercept(Node.prototype, key, true);
  for (const target of [globalThis.Element?.prototype, globalThis.Document?.prototype, globalThis.DocumentFragment?.prototype]) {
    for (const key of ["append", "prepend", "replaceChildren"]) intercept(target, key);
  }
  for (const target of [Element.prototype, CharacterData.prototype]) {
    for (const key of ["before", "after", "replaceWith"]) intercept(target, key);
  }
  proxy_function(Element.prototype, 'insertAdjacentText', (original, receiver, args) => mutate_styles([receiver], () => Reflect.apply(original, receiver, args)));
  for (const prototype of [Node.prototype, globalThis.CharacterData?.prototype, Element.prototype]) {
    for (const key of prototype === Node.prototype ? ['removeChild', 'normalize'] : ['before', 'after', 'replaceWith', 'remove']) {
      if (!Object.hasOwn(prototype, key)) continue;
      const original = prototype[key];
      prototype[key] = function(...args) {
        return mutate_styles([this, ...(key === 'normalize' ? [this] : args)], () => Reflect.apply(original, this, args));
      };
    }
  }
  for (const [prototype, keys] of [[Node.prototype, ['textContent', 'nodeValue']], [CharacterData.prototype, ['data']], [HTMLElement.prototype, ['innerText']]]) {
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(prototype, key);
      Object.defineProperty(prototype, key, {...property, set(value) {
        return mutate_styles([this], () => property.set.call(this, value));
      }});
    }
  }
  if (globalThis.Range) {
    for (const key of ['deleteContents', 'extractContents', 'insertNode', 'surroundContents']) {
      const original = Range.prototype[key];
      Range.prototype[key] = function(...args) {
        const ancestor=this.commonAncestorContainer;
        const inserting=key==='insertNode'||key==='surroundContents',node=args[0];
        const inserted=inserting?(node?.nodeType===11?[...node.childNodes]:[node]):[];
        const result=mutate_styles([ancestor,...args],()=>{
          if(inserting)prepare(node);
          return Reflect.apply(original,this,args);
        });
        for(const node of inserted){reconcile_iframes(node);execute(node);}
        return result;
      };
    }
  }
  for (const [prototype, keys] of [[CharacterData.prototype, ['appendData', 'insertData', 'deleteData', 'replaceData']], [Text.prototype, ['splitText']]]) {
    for (const key of keys) {
      const original = prototype[key];
      prototype[key] = function(...args) {
        return mutate_styles([this], () => Reflect.apply(original, this, args));
      };
    }
  }

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
  const adjacent = Element.prototype.insertAdjacentHTML;
  const namespace=Object.getOwnPropertyDescriptor(Element.prototype,'namespaceURI').get;
  const parent=Object.getOwnPropertyDescriptor(Node.prototype,'parentNode').get;
  const stringify=String;
  const markup_string=value=>{
    if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
    return stringify(value);
  };
  const replace = Element.prototype.replaceChildren;
  const before=Element.prototype.before,after=Element.prototype.after,prepend=Element.prototype.prepend,append=Element.prototype.append;
  function fragment(context,value,operation,position) {
    const content=html_fragment(context,value,operation,position);
    prepare(content);
    return content;
  }
  if(globalThis.Range){
    const contextual=Range.prototype.createContextualFragment;
    let rangeOwner=Range.prototype;
    while(!Object.hasOwn(rangeOwner,'startContainer'))rangeOwner=Object.getPrototypeOf(rangeOwner);
    const start=Object.getOwnPropertyDescriptor(rangeOwner,'startContainer').get;
    const owner=Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
    const adopt=Document.prototype.adoptNode,view=Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
    const registry=globalThis.customElements,upgrade=registry?.upgrade;
    Range.prototype.createContextualFragment=function(value){
      start.call(this);
      if(!arguments.length)return contextual.call(this);
      value=markup_string(value);
      const context=start.call(this),source=owner.call(context)||context;
      if(!view.call(source))return contextual.call(this,value);
      const content=range_fragment(context,value);
      // Images/media can start loading as soon as their owner document is
      // active, even while detached. Other resources and executable scripts
      // retain their original markup until insertion prepares them.
      for(const element of content.querySelectorAll('*')){
        rewrite_event_attributes(element);
        if(Element.prototype.matches.call(element,"img, source, video, audio, input[type='image'], track"))rewrite.media(element)?.catch(console.error);
      }
      adopt.call(source,content);
      if(upgrade&&source===document)upgrade.call(registry,content);
      return content;
    };
  }
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...descriptor,
    set(value) {
      namespace.call(this);
      if(!arguments.length)return descriptor.set.call(this);
      value=value===null?'':markup_string(value);
      if (["SCRIPT", "STYLE", "TEXTAREA", "TEMPLATE"].includes(this.tagName)) {
        mutate_styles([this], () => descriptor.set.call(this, value));
        return;
      }
      const content = fragment(this,value);
      Reflect.apply(replace, this, [content]);
    }
  });
  Object.defineProperty(Element.prototype,'outerHTML',{...outer,set(value){
    namespace.call(this);
    if(!arguments.length)return outer.set.call(this);
    value=value===null?'':markup_string(value);
    const container=parent.call(this);
    if(!container||container instanceof Document)return outer.set.call(this,value);
    const content=fragment(this,value,'outer');
    // Use the intercepted insertion path for resource preparation, stylesheet
    // bookkeeping and iframe lifecycle handling.
    Element.prototype.replaceWith.call(this,content);
  }});
  if(globalThis.ShadowRoot){
    const shadow=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'innerHTML');
    const host=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
    const replace_shadow=DocumentFragment.prototype.replaceChildren;
    Object.defineProperty(ShadowRoot.prototype,'innerHTML',{...shadow,set(value){
      const context=host.call(this);
      if(!arguments.length)return shadow.set.call(this);
      value=value===null?'':markup_string(value);
      Reflect.apply(replace_shadow,this,[fragment(context,value)]);
    }});
  }
  Element.prototype.insertAdjacentHTML = function(position, value) {
    namespace.call(this);
    if(arguments.length<2)return Reflect.apply(adjacent,this,arguments);
    position=markup_string(position);value=markup_string(value);
    const normalized=position.toLowerCase();
    if(!['beforebegin','afterbegin','beforeend','afterend'].includes(normalized))throw new DOMException('Invalid position','SyntaxError');
    const container=parent.call(this);
    if(['beforebegin','afterend'].includes(normalized)&&(!container||container instanceof Document))return adjacent.call(this,position,value);
    const content = fragment(this,value,'adjacent',normalized);
    switch (normalized) {
      case "beforebegin": before.call(this,content); break;
      case "afterbegin": prepend.call(this,content); break;
      case "beforeend": append.call(this,content); break;
      case "afterend": after.call(this,content); break;
      default: throw new DOMException("Invalid position", "SyntaxError");
    }
  };
}

if (globalThis.Image) {
  globalThis.Image = new Proxy(globalThis.Image, {
    construct(target, args) {
      const image = Reflect.construct(target, args);
      prepare(image);
      return image;
    }
  });
}
