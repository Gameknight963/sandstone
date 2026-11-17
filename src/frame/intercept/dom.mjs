import * as rewrite from "../rewrite/index.mjs";
import { proxy_function, get_dom_property } from "../context.mjs";
import * as loader from "../loader.mjs";
import {mutate_styles as mutate_style_sources} from '../rewrite/style.mjs';
import {mutate_document_base} from '../document_base.mjs';
import {reconcile_iframes} from '../iframe_lifecycle.mjs';
import {html_fragment,range_fragment} from '../html_fragments.mjs';
import {copy_resources,prepare_resources,pause_resources,mark_connected_scripts,mark_fragment_scripts,node_document,active_document,connected_node,walk_resources} from '../resource_nodes.mjs';
import {detach_media_attribute} from '../rewrite/media.mjs';
import {detach_svg_attribute} from '../svg_resources.mjs';
import {shadow_root} from '../shadow_roots.mjs';
import {unwrap_document} from '../document_identity.mjs';
import {range_sources} from './ranges.mjs';
const mutate_styles=(nodes,operation)=>mutate_document_base(()=>active_document(node_document(nodes[0]))?mutate_style_sources(nodes,operation):operation());

function prepare(node,full=true) {
  prepare_resources(node);
  if(!full)return;
  const pending = rewrite.element(node);
  pending?.catch(console.error);
  walk_resources(node,element=>{if(element instanceof Element){const root=shadow_root(element);if(root)rewrite.element(root)?.catch(console.error);}});
}

function execute(node) {
  if(!(node instanceof Node)||!connected_node(node)||node_document(node)!==document)return;
  if (!loader.is_loaded) return;
  if (typeof node?.__sandstone_execute__ === "function") node.__sandstone_execute__();
  for (const child of get_dom_property(node, "children") || []) execute(child);
  if(node instanceof Element){const root=shadow_root(node);if(root)execute(root);}
}

function intercept(target, key, first_only = false) {
  if (!target || typeof target[key] !== "function") return;
  proxy_function(target, key, (original, receiver, args) => {
    receiver=unwrap_document(receiver);args=args.map(unwrap_document);
    const nodes = first_only ? args.slice(0, 1) : args;
    // A fragment is empty after insertion; retain its children for execution.
    const inserted = nodes.flatMap(node => node?.nodeType === 11 ? [...node.childNodes] : [node]);
    const active=active_document(node_document(receiver)),full=active&&connected_node(receiver);
    const result = mutate_styles([receiver, ...nodes], () => {
      if(active)for (const node of nodes) prepare(node,full);
      return Reflect.apply(original, receiver, args);
    });
    for (const node of inserted)if(node instanceof Node){
      if(active_document(node_document(node))){mark_connected_scripts(node);reconcile_iframes(node);execute(node);}
      else{pause_resources(node);mark_connected_scripts(node);}
    }
    return result;
  });
}

if (globalThis.Node) {
  const clone=Node.prototype.cloneNode;
  const kind=Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
  Node.prototype.cloneNode=new Proxy(clone,{apply(target,receiver,args){
    const copy=Reflect.apply(target,receiver,args);
    // Source attributes may temporarily be absent or contain local blobs.
    // Restore their virtual values without ever assigning remote native URLs.
    copy_resources(receiver,copy,!active_document(node_document(copy)));
    return copy;
  }});
  const import_node=Document.prototype.importNode,adopt_node=Document.prototype.adoptNode;
  const document_view=Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
  const registry=globalThis.customElements,upgrade=registry?.upgrade;
  Document.prototype.importNode=new Proxy(import_node,{apply(target,receiver,args){
    const active=!!document_view.call(receiver);
    if(!args.length)return Reflect.apply(target,receiver,args);
    if(!active){const copy=Reflect.apply(target,receiver,args);copy_resources(args[0],copy,true,true);return copy;}
    const inert=receiver.implementation.createHTMLDocument('');
    const copy=Reflect.apply(target,inert,args);
    copy_resources(args[0],copy,true,true);prepare_resources(copy);
    adopt_node.call(receiver,copy);
    if(upgrade&&receiver===document)upgrade.call(registry,copy);
    return copy;
  }});
  Document.prototype.adoptNode=new Proxy(adopt_node,{apply(target,receiver,args){
    const active=!!document_view.call(receiver);
    if(!args.length)return Reflect.apply(target,receiver,args);
    const node=args[0],type=kind.call(node);
    if(type===9||globalThis.ShadowRoot&&node instanceof ShadowRoot)return Reflect.apply(target,receiver,args);
    if(type===2){if(!detach_media_attribute(node))detach_svg_attribute(node);}
    if(active)prepare_resources(node);
    const result=Reflect.apply(target,receiver,args);
    if(!active)pause_resources(node);
    return result;
  }});
  if(globalThis.DOMParser){
    const parse=DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString=new Proxy(parse,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);if(loader.is_loaded)mark_connected_scripts(result);return result;}});
  }
  for(const key of ['parseHTML','parseHTMLUnsafe'])if(typeof Document[key]==='function'){
    const parse=Document[key];Document[key]=new Proxy(parse,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);if(loader.is_loaded)mark_connected_scripts(result);return result;}});
  }
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
      prototype[key] = new Proxy(original,{apply(target,receiver,args){
        receiver=unwrap_document(receiver);args=args.map(unwrap_document);
        return mutate_styles([receiver, ...(key === 'normalize' ? [receiver] : args)], () => Reflect.apply(target, receiver, args));
      }});
    }
  }
  for (const [prototype, keys] of [[Node.prototype, ['textContent', 'nodeValue']], [CharacterData.prototype, ['data']], [HTMLElement.prototype, ['innerText']]]) {
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(prototype, key);
      Object.defineProperty(prototype, key, {...property, set(value) {
        const result=mutate_styles([this], () => property.set.call(this, value));
        mark_connected_scripts(this);if(this.parentNode)mark_connected_scripts(this.parentNode);
        return result;
      }});
    }
  }
  if (globalThis.Range) {
    for (const key of ['deleteContents', 'extractContents', 'insertNode', 'surroundContents']) {
      const original = Range.prototype[key];
      Range.prototype[key] = function(...args) {
        if((key==='insertNode'||key==='surroundContents')&&args.length)args[0]=unwrap_document(args[0]);
        const sources=range_sources(this),ancestor=sources[0];
        const active=active_document(node_document(ancestor)),full=active&&connected_node(ancestor);
        const inserting=key==='insertNode'||key==='surroundContents',node=args[0];
        const inserted=inserting?(node?.nodeType===11?[...node.childNodes]:[node]):[];
        const result=mutate_styles([...sources,...args],()=>{
          if(inserting&&active)prepare(node,full);
          return Reflect.apply(original,this,args);
        });
        for(const node of inserted)if(node instanceof Node){
          if(active_document(node_document(node))){mark_connected_scripts(node);reconcile_iframes(node);execute(node);}
          else{pause_resources(node);mark_connected_scripts(node);}
        }
        return result;
      };
    }
  }
  if(globalThis.Selection&&typeof Selection.prototype.deleteFromDocument==='function'){
    const original=Selection.prototype.deleteFromDocument,getRange=Selection.prototype.getRangeAt;
    const count=Object.getOwnPropertyDescriptor(Selection.prototype,'rangeCount').get;
    Selection.prototype.deleteFromDocument=new Proxy(original,{apply(target,receiver,args){
      const length=count.call(receiver);if(!length)return Reflect.apply(target,receiver,args);
      const sources=[];for(let index=0;index<length;index++)sources.push(...range_sources(getRange.call(receiver,index)));
      return mutate_styles(sources,()=>Reflect.apply(target,receiver,args));
    }});
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
    if(active_document(node_document(context)))prepare(content,connected_node(context));
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
      const context=unwrap_document(start.call(this)),source=owner.call(context)||context;
      if(!view.call(source))return contextual.call(this,value);
      const content=range_fragment(context,value);
      // Images/media can start loading as soon as their owner document is
      // active, even while detached. Other resources and executable scripts
      // retain their original markup until insertion prepares them.
      prepare_resources(content);
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
        if(this instanceof HTMLTemplateElement)mark_fragment_scripts(this.content);
        else mark_connected_scripts(this);
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
