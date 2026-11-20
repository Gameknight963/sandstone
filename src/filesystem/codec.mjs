const prefix='application/x-sandstone-file-handle;v=1;data=';
const type=Object.getOwnPropertyDescriptor(Blob.prototype,'type').get;
export function file_handle(info){
  const hex=Array.from(new TextEncoder().encode(JSON.stringify(info)),byte=>byte.toString(16).padStart(2,'0')).join('');
  return new Blob([],{type:prefix+hex});
}
export function file_metadata(value){
  let mime;try{mime=Reflect.apply(type,value,[]);}catch{return;}
  if(!mime.startsWith(prefix))return;
  const hex=mime.slice(prefix.length);if(!/^(?:[0-9a-f]{2})+$/.test(hex))return;
  try{
    const info=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(hex.match(/../g),byte=>parseInt(byte,16))));
    if(typeof info.origin!=='string'||typeof info.id!=='string'||!info.id||typeof info.name!=='string'||!['file','directory'].includes(info.kind))return;
    if(typeof info.capability!=='string'||!/^[a-f0-9]{32}$/.test(info.capability))return;
    if(!Array.isArray(info.path)||!info.path.every(part=>typeof part==='string'&&part&&part!=='.'&&part!=='..'&&!/[\\/\0]/.test(part)))return;
    if(new URL(info.origin).origin!==info.origin||info.origin==='null')return;
    return info;
  }catch{}
}
