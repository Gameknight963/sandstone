import * as rewrite from './rewrite/index.mjs';
import {clone_media,set_media_active} from './rewrite/media.mjs';
import {clone_svg_resource,is_svg_resource,rewrite_svg_resource,set_svg_active} from './svg_resources.mjs';
import {rewrite_event_attributes} from './event_attributes.mjs';
import {shadow_root} from './shadow_roots.mjs';
import {clone_script,mark_script_connected} from './rewrite/script.mjs';
import {copy_resource_attributes} from './resource_attributes.mjs';
import {clone_style} from './rewrite/style.mjs';

const N=globalThis.Node?.prototype,D=globalThis.Document?.prototype;
const owner=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get;
const kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const connected=N&&Object.getOwnPropertyDescriptor(N,'isConnected').get;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get;
const view=D&&Object.getOwnPropertyDescriptor(D,'defaultView').get;
export const node_document=node=>kind.call(node)===9?node:owner.call(node);
export const active_document=document=>!!document&&!!view.call(document);
export const connected_node=node=>connected.call(node);

export function walk_resources(node,callback,templates=false){
  if(!globalThis.Node||!(node instanceof Node))return;
  const pending=[node];
  while(pending.length){
    const current=pending.pop();callback(current);
    for(const child of children.call(current))pending.push(child);
    if(current instanceof Element){const root=shadow_root(current);if(root)pending.push(root);}
    if(templates&&current instanceof HTMLTemplateElement)pending.push(current.content);
  }
}
export function prepare_resources(node){
  walk_resources(node,element=>{
    if(!(element instanceof Element))return;
    rewrite_event_attributes(element);
    set_media_active(element,true);set_svg_active(element,true);
    if(Element.prototype.matches.call(element,'img, source, video, audio, input, track'))rewrite.media(element);
    if(is_svg_resource(element))rewrite_svg_resource(element);
  });
}
export function pause_resources(node){walk_resources(node,element=>{set_media_active(element,false);set_svg_active(element,false);});}
export function mark_connected_scripts(node){walk_resources(node,element=>mark_script_connected(element));}
export function mark_fragment_scripts(node){walk_resources(node,element=>{if(element instanceof HTMLScriptElement)element.__sandstone_inert__=true;},true);}
export function copy_resources(source,copy,inactive=false,prime=false){
  const restored=clone_media(source,copy,inactive)||clone_svg_resource(source,copy,inactive);
  if(restored&&!inactive)rewrite_event_attributes(copy);
  clone_script(source,copy,prime);
  copy_resource_attributes(source,copy);clone_style(source,copy);
  const originals=[...children.call(source)],copies=[...children.call(copy)];
  for(let i=0;i<Math.min(originals.length,copies.length);i++)copy_resources(originals[i],copies[i],inactive,prime);
  if(source instanceof Element&&copy instanceof Element){const a=shadow_root(source),b=shadow_root(copy);if(a&&b)copy_resources(a,b,inactive,prime);}
  if(source instanceof HTMLTemplateElement&&copy instanceof HTMLTemplateElement)copy_resources(source.content,copy.content,true,prime);
}
