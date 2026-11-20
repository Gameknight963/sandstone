import * as rewrite from './rewrite/index.mjs';
import {clone_media,set_media_active,capture_media,observe_media_container} from './rewrite/media.mjs';
import {clone_svg_resource,is_svg_resource,rewrite_svg_resource,set_svg_active,capture_svg_resource} from './svg_resources.mjs';
import {rewrite_event_attributes} from './event_attributes.mjs';
import {shadow_root,clonable_shadow,capture_shadow_state} from './shadow_roots.mjs';
import {clone_script,mark_script_connected,capture_script} from './rewrite/script.mjs';
import {copy_resource_attributes,capture_resource_attributes} from './resource_attributes.mjs';
import {clone_style,capture_style} from './rewrite/style.mjs';
import {import_declarative_host} from './declarative_html.mjs';
import {is_svg_script} from './svg_scripts.mjs';
import {rewrite_xml_stylesheet,copy_xml_stylesheet,capture_xml_stylesheet,is_xml_stylesheet} from './xml_stylesheets.mjs';
import {unwrap_frame_document} from './document_identity.mjs';

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
  node=unwrap_frame_document(node);
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
    if(is_xml_stylesheet(element))rewrite_xml_stylesheet(element);
    if(!(element instanceof Element))return;
    rewrite_event_attributes(element);
    observe_media_container(element);
    set_media_active(element,true);set_svg_active(element,true);
    if(Element.prototype.matches.call(element,'img, source, video, audio, input, track'))rewrite.media(element);
    if(is_svg_resource(element))rewrite_svg_resource(element);
  });
}
export function pause_resources(node){walk_resources(node,element=>{set_media_active(element,false);set_svg_active(element,false);});}
export function mark_connected_scripts(node){walk_resources(node,element=>mark_script_connected(element));}
export function mark_fragment_scripts(node){walk_resources(node,element=>{if(element instanceof HTMLScriptElement||is_svg_script(element))element.__sandstone_inert__=true;},true);}
export function copy_resource_node(source,copy,inactive=false,prime=false,serializing=false){
  if(source===copy)return;
  copy_xml_stylesheet(source,copy);
  const restored=clone_media(source,copy,inactive)||clone_svg_resource(source,copy,inactive);
  if(restored&&!inactive)rewrite_event_attributes(copy);
  clone_script(source,copy,prime,serializing);
  copy_resource_attributes(source,copy,serializing);
  if(serializing)capture_style(source,true)?.(copy);else clone_style(source,copy);
}
export function copy_resources(source,copy,inactive=false,prime=false){
  if(source===copy)return copy;
  const root=source instanceof Element&&clonable_shadow(source);
  if(inactive&&root)copy=import_declarative_host(source,copy,root);
  copy_resource_node(source,copy,inactive,prime);
  const originals=[...children.call(source)],copies=[...children.call(copy)];
  for(let i=0;i<Math.min(originals.length,copies.length);i++)copy_resources(originals[i],copies[i],inactive,prime);
  if(source instanceof Element&&copy instanceof Element){const a=clonable_shadow(source),b=shadow_root(copy);if(a&&b){capture_shadow_state(a)(b);copy_resources(a,b,inactive,prime);}}
  if(source instanceof HTMLTemplateElement&&copy instanceof HTMLTemplateElement)copy_resources(source.content,copy.content,true,prime);
  return copy;
}

export function capture_resources(source,shallow=false){
  const instruction=capture_xml_stylesheet(source);
  const media=capture_media(source),svg=capture_svg_resource(source),script=capture_script(source),attributes=capture_resource_attributes(source),style=capture_style(source);
  const descendants=shallow?[]:[...children.call(source)].map(node=>capture_resources(node));
  const root=source instanceof Element&&clonable_shadow(source),shadow=root&&capture_resources(root),shadow_state=root&&capture_shadow_state(root);
  const template=source instanceof HTMLTemplateElement&&capture_resources(source.content);
  return (copy,inactive=false,prime=false)=>{
    if(copy===source)return;
    instruction?.(copy);
    const restored=media?.(copy,inactive)||svg?.(copy,inactive);
    if(restored&&!inactive)rewrite_event_attributes(copy);
    script?.(copy,prime);attributes(copy);style?.(copy,shallow);
    const targets=[...children.call(copy)];for(let i=0;i<Math.min(descendants.length,targets.length);i++)descendants[i](targets[i],inactive,prime);
    if(shadow&&copy instanceof Element){const root=shadow_root(copy);if(root){shadow_state(root);shadow(root,inactive,prime);}}
    if(template&&copy instanceof HTMLTemplateElement)template(copy.content,true,prime);
  };
}
