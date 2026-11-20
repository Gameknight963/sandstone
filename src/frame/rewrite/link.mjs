import {ctx,intercept_property,proxy_function} from '../context.mjs';
import {is_style_link,rewrite_stylesheet} from './stylesheet.mjs';
import {resource_attribute} from '../resource_attributes.mjs';
import {get_document_encoding} from '../document_encoding.mjs';
import {encoding_parse_url} from '../../url_encoding.mjs';
import {create_link_preload} from '../link_preloads.mjs';
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;

export function rewrite_link(element) {
  const get=Element.prototype.getAttribute,remove=Element.prototype.removeAttribute;
  let authored=get.call(element,'href'),active=false,activating=false,observer;
  resource_attribute(element,'href',()=>authored);
  const preload=create_link_preload(element,()=>authored);
  const methods=new Map();
  function activate(){
    if(active||activating||!is_style_link(element))return;
    activating=true;observer?.disconnect();
    preload.dispose();
    // Remove only our own wrappers; retain methods patched by the page later.
    for(const [name,state] of methods){
      if(element[name]!==state.wrapper)continue;
      if(state.property)Object.defineProperty(element,name,state.property);else delete element[name];
    }
    try{
      const pending=rewrite_stylesheet(element,()=>authored??get.call(element,'data-href'));
      active=true;return pending;
    }finally{activating=false;}
  }
  function changed(){try{activate()?.catch(console.error);if(!active)preload.update();}catch(error){console.error(error);}}
  intercept_property(element,'href',{
    get(){if(authored===null)return '';try{return encoding_parse_url(authored,ctx.document.baseURI,get_document_encoding(owner.call(element))).href;}catch{return authored;}},
    set(value){
      const text=`${value}`;
      if(active){element.href=text;return;}
      authored=text;remove.call(element,'href');changed();
    }
  });
  for(const name of ['setAttribute','getAttribute','hasAttribute','removeAttribute']){
    const state={property:Object.getOwnPropertyDescriptor(element,name)};methods.set(name,state);
    proxy_function(element,name,(target,receiver,args)=>{
      const required=name==='setAttribute'?2:1;
      if(receiver!==element||args.length<required)return Reflect.apply(target,receiver,args);
      const attribute=`${args[0]}`;
      if(attribute.toLowerCase()==='href'){
        if(name==='setAttribute'){element.href=args[1];return;}
        if(!active){
          if(name==='getAttribute')return authored;
          if(name==='hasAttribute')return authored!==null;
          authored=null;preload.update();
        }
      }
      return Reflect.apply(target,receiver,[attribute,...args.slice(1)]);
    });
    state.wrapper=element[name];
  }
  // Keep the authored relation visible to scripts and relList. With no physical
  // href, native hints cannot issue HTTP requests before a later style upgrade.
  observer=new MutationObserver(changed);
  observer.observe(element,{attributes:true,attributeFilter:['rel','as','crossorigin','referrerpolicy','media','type']});
  remove.call(element,'href');
  const pending=activate();if(!active)preload.update();return pending;
}
