import {ctx,intercept_property,proxy_function} from '../context.mjs';
import {is_style_link,rewrite_stylesheet} from './stylesheet.mjs';

export function rewrite_link(element) {
  const get=Element.prototype.getAttribute,remove=Element.prototype.removeAttribute;
  let authored=get.call(element,'href'),active=false,activating=false,observer;
  const methods=new Map();
  function activate(){
    if(active||activating||!is_style_link(element))return;
    activating=true;observer?.disconnect();
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
  function changed(){try{activate()?.catch(console.error);}catch(error){console.error(error);}}
  intercept_property(element,'href',{
    get(){if(authored===null)return '';try{return new URL(authored,ctx.document.baseURI).href;}catch{return authored;}},
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
          authored=null;
        }
      }
      return Reflect.apply(target,receiver,[attribute,...args.slice(1)]);
    });
    state.wrapper=element[name];
  }
  // Keep the authored relation visible to scripts and relList. With no physical
  // href, native hints cannot issue HTTP requests before a later style upgrade.
  observer=new MutationObserver(changed);
  observer.observe(element,{attributes:true,attributeFilter:['rel','as']});
  remove.call(element,'href');
  return activate();
}
