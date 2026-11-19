import {unwrap_frame_document as unwrap,wrap_frame_document as wrap,register_document_metadata,document_metadata_getter} from './document_identity.mjs';

let installed=false;
// Install after runtime modules have captured native DOM accessors. Internal
// ownership checks keep physical documents; authored DOM references share the
// same document view as the virtual global and event targets.
export function install_node_documents(documentView){
  if(!globalThis.Node)return;
  const virtual=new Set(['URL','documentURI','referrer','readyState','location','currentScript','defaultView']);
  const properties=Object.getOwnPropertyDescriptors(Object.getPrototypeOf(documentView)),getters={};
  for(const name of virtual)if(properties[name]?.get){const get=properties[name].get;getters[name]=()=>Reflect.apply(get,documentView,[]);}
  register_document_metadata(documentView.__proxy__,getters);
  if(installed)return;installed=true;
  const accessors=(prototype,mapped=new Set(),virtual=new Set())=>{
    for(const [name,property] of Object.entries(Object.getOwnPropertyDescriptors(prototype))){
      if(!property.get)continue;
      // Event-property adapters retain the authored receiver to project this,
      // target, currentTarget and paths into the caller's document view.
      if(prototype===Document.prototype&&name.startsWith('on'))continue;
      Object.defineProperty(prototype,name,{...property,
        get:new Proxy(property.get,{apply(target,receiver,args){
          const native=unwrap(receiver);
          if(native!==receiver&&virtual.has(name)){const get=document_metadata_getter(receiver,name);if(get)return get();}
          const value=Reflect.apply(target,native,args);return mapped.has(name)?wrap(value):value;
        }}),
        ...(property.set?{set:new Proxy(property.set,{apply(target,receiver,args){
          const native=unwrap(receiver);
          if(native!==receiver&&name==='location'){const get=document_metadata_getter(receiver,name);if(get){Reflect.set(get(),'href',args[0]);return;}}
          return Reflect.apply(target,native,args);
        }})}:{})
      });
    }
  };
  accessors(Node.prototype,new Set(['parentNode','ownerDocument']));
  accessors(Document.prototype,new Set(),virtual);
  const method=(prototype,name,indices=[],mapsResult=false)=>{
    const property=Object.getOwnPropertyDescriptor(prototype,name);if(typeof property?.value!=='function')return;
    Object.defineProperty(prototype,name,{...property,value:new Proxy(property.value,{apply(target,receiver,args){
      const converted=[...args];for(const index of indices)if(index<converted.length)converted[index]=unwrap(converted[index]);
      const value=Reflect.apply(target,unwrap(receiver),converted);return mapsResult?wrap(value):value;
    }})});
  };
  method(Node.prototype,'getRootNode',[],true);
  for(const name of ['contains','compareDocumentPosition','isSameNode','isEqualNode','appendChild','removeChild'])method(Node.prototype,name,[0]);
  for(const name of ['insertBefore','replaceChild'])method(Node.prototype,name,[0,1]);
  for(const name of ['cloneNode','normalize'])method(Node.prototype,name);
  // Libraries borrow Document methods from the prototype when given a node's
  // ownerDocument. Preserve those receivers through existing DOM interceptors.
  const documentArgs={adoptNode:[0],importNode:[0],evaluate:[1]};
  // These adapters already unwrap their receivers and must retain the caller's
  // document alias for ranges, traversers, and the destination HTML rewriter.
  const adapted=new Set(['constructor','createRange','getSelection','createTreeWalker','createNodeIterator','open','write','writeln','close']);
  for(const name of Object.getOwnPropertyNames(Document.prototype))if(!adapted.has(name))method(Document.prototype,name,documentArgs[name]||[],true);
}
