import {create_file_client} from '../../filesystem/client.mjs';
import * as rpc from '../../rpc.mjs';
import * as loader from '../loader.mjs';
import {configure_clone} from '../clone.mjs';
import {trustworthy_url} from '../../trustworthy.mjs';
import {create_sync_http_server} from '../../sync_http.mjs';
import {on_document_unload} from '../runtime_events.mjs';

const sync_channels=new Map();
rpc.rpc_handlers.filesystem_sync_close=token=>{
  const channel=sync_channels.get(token);if(!channel)return;
  sync_channels.delete(token);channel.server.close();channel.port.close();
};
rpc.rpc_handlers.filesystem_sync_bind=(id,token,port)=>{
  rpc.rpc_handlers.filesystem_sync_close(token);
  const server=create_sync_http_server({fetch:async(url,options)=>{
    if(url!=='sandstone-filesystem:command')throw new DOMException('Invalid file transport request','SecurityError');
    let result,bytes;
    try{
      const value=await rpc.call_procedure(rpc.host,'filesystem_sync_command',[loader.frame_id,id,token,options.filesystem]);
      if(value?.bytes instanceof Uint8Array){bytes=value.bytes;result={};}else result={value};
    }catch(error){result={error:{name:error.name,message:error.message}};}
    return new Response(bytes,{headers:{'x-sandstone-file-result':encodeURIComponent(JSON.stringify(result))}});
  }});
  sync_channels.set(token,{server,port});port.onmessage=event=>server.receive(event.data);port.start();
};
on_document_unload(()=>{for(const token of sync_channels.keys())rpc.rpc_handlers.filesystem_sync_close(token);});

const client=create_file_client(command=>rpc.call_procedure(rpc.host,'filesystem_command',[loader.beacon_context,command]),{worker:typeof importScripts==='function',origin:()=>loader.document_origin??loader.worker_origin??(loader.url?new URL(loader.url).origin:undefined)});
const constructors=['FileSystemHandle','FileSystemFileHandle','FileSystemDirectoryHandle','FileSystemWritableFileStream','StorageManager'];
for(const name of constructors)globalThis[name]=client[name];
function trustworthy(){try{return trustworthy_url(new URL([loader.document_origin,loader.worker_origin].find(value=>value&&value!=='null')||loader.url));}catch{return false;}}
export function configure_filesystem(){for(const name of constructors)if(trustworthy())globalThis[name]=client[name];else Reflect.deleteProperty(globalThis,name);}
export function configure_filesystem_sync(request){if(!trustworthy())return;client.configureSync(request);globalThis.FileSystemSyncAccessHandle=client.FileSystemSyncAccessHandle;}
const NavigatorType=globalThis.Navigator||globalThis.WorkerNavigator;
if(NavigatorType)Object.defineProperty(NavigatorType.prototype,'storage',{enumerable:true,configurable:true,get(){
  if(!(this instanceof NavigatorType))throw new TypeError('Invalid navigator receiver');
  if(!trustworthy())return;
  return client.storage;
}});
const clone=globalThis.structuredClone;
globalThis.structuredClone=new Proxy(clone,{apply(target,receiver,args){return client.decode(Reflect.apply(target,receiver,args));}});
configure_clone(globalThis.structuredClone);
const data=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data'),decoded=new WeakMap();
Object.defineProperty(MessageEvent.prototype,'data',{...data,get(){
  const source=data.get.call(this);
  // Authored events retain the original object, including proxies and getters.
  // Only browser-delivered messages have passed through structured cloning.
  if(!this.isTrusted)return source;
  const previous=decoded.get(this);if(previous?.source===source)return previous.value;
  const value=client.decode(source);decoded.set(this,{source,value});return value;
}});
