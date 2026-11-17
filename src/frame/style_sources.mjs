import {restore_css,css_references} from './css.mjs';

const declarations=new WeakMap(),initial=new WeakMap();
const get=globalThis.Element?.prototype.getAttribute;
const namespace=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'namespaceURI').get;
const styles=new Map([
  ['http://www.w3.org/1999/xhtml',globalThis.HTMLElement],
  ['http://www.w3.org/2000/svg',globalThis.SVGElement],
  ['http://www.w3.org/1998/Math/MathML',globalThis.MathMLElement]
].map(([ns,type])=>[ns,type&&Object.getOwnPropertyDescriptor(type.prototype,'style')?.get]));
function declaration(element){return styles.get(namespace.call(element))?.call(element);}
function state(value){let entry=declarations.get(value);if(!entry){entry={version:0,markers:new Map()};declarations.set(value,entry);}return entry;}
export function style_change(value,markers){const entry=state(value);entry.version++;for(const [key,source] of markers)entry.markers.set(key,source);}
export function resolved_style(value,source,css){
  const entry=state(value),before=css_references(source),after=css_references(css);
  for(let index=0;index<before.length;index++)if(after[index]&&before[index].url!==after[index].url)entry.markers.set(after[index].url,before[index].url);
}
export function inline_style_version(element){const value=declaration(element);return value?state(value).version:0;}
export function remember_inline_style(element,source,rendered){
  initial.set(element,{version:inline_style_version(element),source});
  if(rendered!==undefined){const value=declaration(element);if(value)resolved_style(value,source,rendered);}
}
export function serialized_inline_style(element){
  const source=get.call(element,'style');if(source===null)return null;
  const value=declaration(element);if(!value)return source;
  const entry=state(value),original=initial.get(element);
  return original&&original.version===entry.version?original.source:restore_css(source,entry.markers,undefined,true);
}
