import {create_file_client} from '../../filesystem/client.mjs';
import * as rpc from '../../rpc.mjs';
import * as loader from '../loader.mjs';
import {configure_clone} from '../clone.mjs';
import {trustworthy_url} from '../../trustworthy.mjs';

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
  const source=data.get.call(this),previous=decoded.get(this);if(previous?.source===source)return previous.value;
  const value=client.decode(source);decoded.set(this,{source,value});return value;
}});
