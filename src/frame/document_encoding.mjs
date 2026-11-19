import {document_states,unwrap_frame_document} from './document_identity.mjs';

const encodings=document_states('document-character-encodings');
const apply=Reflect.apply;
export function configure_document_encoding(document,alias,encoding){
  encodings.set(document,encoding);encodings.set(alias,encoding);
}
export function copy_document_encoding(source,target){
  const encoding=encodings.get(unwrap_frame_document(source));
  if(encoding)encodings.set(target,encoding);
}
if(globalThis.Document)for(const name of ['characterSet','charset','inputEncoding']){
  const descriptor=Object.getOwnPropertyDescriptor(Document.prototype,name);
  if(!descriptor?.get)continue;
  Object.defineProperty(Document.prototype,name,{...descriptor,get:new Proxy(descriptor.get,{
    apply(getter,receiver,args){
      const target=unwrap_frame_document(receiver),native=apply(getter,target,args);
      return encodings.get(target)||native;
    }
  })});
}
