import {file_metadata} from './codec.mjs';
import {transform_keys} from '../crypto/codec.mjs';
import mimeTypes from 'mime-db';

const extensions=new Map();
for(const [type,info] of Object.entries(mimeTypes))for(const extension of info.extensions||[])if(!extensions.has(extension))extensions.set(extension,type);
const fileType=name=>name.includes('.')?extensions.get(name.split('.').pop().toLowerCase())||'':'';

const text=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);};
const offset=value=>{const number=Math.trunc(Number(value));if(!Number.isFinite(number)||number<0||number>Number.MAX_SAFE_INTEGER)throw new TypeError('Invalid file offset');return number;};
const blobSize=Object.getOwnPropertyDescriptor(Blob.prototype,'size').get,blobBytes=Blob.prototype.arrayBuffer;
const bufferSize=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const branded=(getter,value)=>{try{Reflect.apply(getter,value,[]);return true;}catch{return false;}};
export function create_file_client(dispatch,{worker=false,origin=()=>undefined}={}){
  const handles=new WeakMap(),streams=new WeakMap(),syncHandles=new WeakMap(),secret={},blob=Blob.prototype;let sync;
  const getWriter=WritableStream.prototype.getWriter,write=WritableStreamDefaultWriter.prototype.write,release=WritableStreamDefaultWriter.prototype.releaseLock;
  function enqueue(stream,value){
    if(!streams.has(stream))throw new TypeError('Invalid FileSystemWritableFileStream receiver');
    const writer=Reflect.apply(getWriter,stream,[]);
    try{return Reflect.apply(write,writer,[value]);}finally{Reflect.apply(release,writer,[]);}
  }
  const info=handle=>{let value=handles.get(handle);if(!value){value=file_metadata(handle);if(value)handles.set(handle,value);}if(!value)throw new TypeError('Invalid FileSystemHandle receiver');return value;};
  const send=(handle,op,values={})=>{const entry=info(handle),kind=['file','directory','entries','resolve','remove'].includes(op)?'directory':['getFile','writable','openSync'].includes(op)?'file':null;if(kind&&entry.kind!==kind)throw new TypeError('Invalid FileSystemHandle kind');return dispatch({op,handle,...values});};
  class FileSystemHandle{
    constructor(){throw new TypeError('Illegal constructor');}
    get kind(){return info(this).kind;}
    get name(){return info(this).name;}
    async isSameEntry(other){info(other);return send(this,'same',{other});}
    async queryPermission(options={}){permission(options);return send(this,'permission');}
    async requestPermission(options={}){permission(options);return send(this,'permission');}
  }
  const permission=options=>{const value=options?.mode,mode=value===undefined?'read':text(value);if(!['read','readwrite'].includes(mode))throw new TypeError('Invalid file permission mode');};
  class FileSystemDirectoryHandle extends FileSystemHandle{
    async getFileHandle(name,options={}){if(!arguments.length)throw new TypeError('File name is required');return decode(await send(this,'file',{name:text(name),create:!!options?.create}));}
    async getDirectoryHandle(name,options={}){if(!arguments.length)throw new TypeError('Directory name is required');return decode(await send(this,'directory',{name:text(name),create:!!options?.create}));}
    async removeEntry(name,options={}){if(!arguments.length)throw new TypeError('File name is required');return send(this,'remove',{name:text(name),recursive:!!options?.recursive});}
    async resolve(other){info(other);return send(this,'resolve',{other});}
    async *entries(){const entries=await send(this,'entries');for(const [name,handle] of entries)yield [name,decode(handle)];}
    async *keys(){for await(const [name] of this.entries())yield name;}
    async *values(){for await(const [,handle] of this.entries())yield handle;}
  }
  FileSystemDirectoryHandle.prototype[Symbol.asyncIterator]=FileSystemDirectoryHandle.prototype.entries;
  class FileSystemFileHandle extends FileSystemHandle{
    async getFile(){const result=await send(this,'getFile');return new File([result.bytes],result.name,{lastModified:result.modified,type:fileType(result.name)});}
    async createWritable(options={}){
      const value=options?.mode,mode=value===undefined?'siloed':text(value);if(!['siloed','exclusive'].includes(mode))throw new TypeError('Invalid writable mode');
      const token=await send(this,'writable',{keepExistingData:!!options?.keepExistingData,mode});
      return new FileSystemWritableFileStream(secret,token);
    }
  }
  async function chunk(value){
    let position,data=value;
    if(value!==null&&typeof value==='object'&&!branded(blobSize,value)&&!ArrayBuffer.isView(value)&&!branded(bufferSize,value)){
      const type=text(value.type);
      if(type==='seek')return {op:'seek',position:offset(value.position)};
      if(type==='truncate')return {op:'truncate',size:offset(value.size)};
      if(type!=='write')throw new TypeError('Invalid file write command');
      if(!('data' in value))throw new TypeError('Write data is required');
      data=value.data;if(value.position!==undefined)position=offset(value.position);
    }
    let bytes;
    if(branded(blobSize,data))bytes=new Uint8Array(await Reflect.apply(blobBytes,data,[]));
    else if(ArrayBuffer.isView(data))bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice();
    else if(branded(bufferSize,data))bytes=new Uint8Array(data).slice();
    else bytes=new TextEncoder().encode(text(data).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD'));
    return {op:'write',bytes,...(position===undefined?{}:{position})};
  }
  class FileSystemWritableFileStream extends WritableStream{
    constructor(key,token){
      if(key!==secret)throw new TypeError('Illegal constructor');
      super({write:async value=>{try{return await dispatch({...await chunk(value),token});}catch(error){await dispatch({op:'abort',token}).catch(()=>{});throw error;}},close:()=>dispatch({op:'close',token}),abort:()=>dispatch({op:'abort',token})});
      streams.set(this,token);
    }
    async write(value){
      if(!arguments.length)throw new TypeError('Write data is required');
      return enqueue(this,value);
    }
    async seek(position){if(!arguments.length)throw new TypeError('File position is required');return enqueue(this,{type:'seek',position});}
    async truncate(size){if(!arguments.length)throw new TypeError('File size is required');return enqueue(this,{type:'truncate',size});}
  }
  const view=value=>{
    if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    if(branded(bufferSize,value))return new Uint8Array(value);
    throw new TypeError('A BufferSource is required');
  };
  const syncInfo=handle=>{const state=syncHandles.get(handle);if(!state)throw new TypeError('Invalid FileSystemSyncAccessHandle receiver');if(state.closed)throw new DOMException('File handle is closed','InvalidStateError');return state;};
  class FileSystemSyncAccessHandle{
    constructor(key,token){if(key!==secret)throw new TypeError('Illegal constructor');const handle=new Proxy(this,{});syncHandles.set(handle,{token,closed:false});return handle;}
    read(buffer,options={}){const state=syncInfo(this),target=view(buffer),result=sync({op:'syncRead',token:state.token,size:target.byteLength,...(options?.at===undefined?{}:{at:offset(options.at)})});target.set(result.bytes);return result.bytes.length;}
    write(buffer,options={}){const state=syncInfo(this),bytes=view(buffer).slice();return sync({op:'syncWrite',token:state.token,bytes,...(options?.at===undefined?{}:{at:offset(options.at)})}).value;}
    truncate(size){const state=syncInfo(this);if(!arguments.length)throw new TypeError('File size is required');sync({op:'syncTruncate',token:state.token,size:offset(size)});}
    getSize(){const state=syncInfo(this);return sync({op:'syncSize',token:state.token}).value;}
    flush(){const state=syncInfo(this);sync({op:'syncFlush',token:state.token});}
    close(){const state=syncHandles.get(this);if(!state)throw new TypeError('Invalid FileSystemSyncAccessHandle receiver');if(state.closed)return;sync({op:'syncClose',token:state.token});state.closed=true;}
  }
  function configureSync(request){
    if(!worker)throw new TypeError('Synchronous file access requires a worker');sync=request;
    Object.defineProperty(FileSystemFileHandle.prototype,'createSyncAccessHandle',{configurable:true,writable:true,enumerable:true,value:async function createSyncAccessHandle(){return new FileSystemSyncAccessHandle(secret,await send(this,'openSync'));}});
  }
  const managers=new WeakSet();
  class StorageManager{
    constructor(){throw new TypeError('Illegal constructor');}
    async getDirectory(){if(!managers.has(this))throw new TypeError('Invalid StorageManager receiver');return decode(await dispatch({op:'root'}));}
    async estimate(){if(!managers.has(this))throw new TypeError('Invalid StorageManager receiver');return dispatch({op:'estimate'});}
    async persisted(){if(!managers.has(this))throw new TypeError('Invalid StorageManager receiver');return dispatch({op:'persisted'});}
  }
  if(!worker)Object.defineProperty(StorageManager.prototype,'persist',{configurable:true,writable:true,enumerable:true,value:async function persist(){if(!managers.has(this))throw new TypeError('Invalid StorageManager receiver');return dispatch({op:'persist'});}});
  const storage=new Proxy(Object.create(StorageManager.prototype),{});managers.add(storage);
  for(const [name,Constructor] of Object.entries({FileSystemHandle,FileSystemDirectoryHandle,FileSystemFileHandle,FileSystemWritableFileStream,FileSystemSyncAccessHandle,StorageManager})){
    Object.defineProperty(Constructor,'name',{value:name,configurable:true});
    Object.defineProperty(Constructor.prototype,Symbol.toStringTag,{value:name,configurable:true});
    for(const key of Object.getOwnPropertyNames(Constructor.prototype))if(key!=='constructor')Object.defineProperty(Constructor.prototype,key,{...Object.getOwnPropertyDescriptor(Constructor.prototype,key),enumerable:true});
  }
  // Native Blob slots let handles pass through native clone validation first,
  // including IndexedDB and ports. Only an opaque capability and entry metadata
  // travel in the Blob; file contents remain in the host.
  for(const symbol of Object.getOwnPropertySymbols(blob))if(symbol!==Symbol.toStringTag)Object.defineProperty(FileSystemHandle.prototype,symbol,Object.getOwnPropertyDescriptor(blob,symbol));
  const decode=value=>transform_keys(value,value=>{
    const metadata=file_metadata(value);if(!metadata)return value;
    const principal=origin();if(principal!==undefined&&metadata.origin!==principal)throw new DOMException('File handle belongs to another origin','DataCloneError');
    Object.setPrototypeOf(value,metadata.kind==='directory'?FileSystemDirectoryHandle.prototype:FileSystemFileHandle.prototype);
    handles.set(value,metadata);return value;
  });
  return {storage,decode,configureSync,FileSystemHandle,FileSystemDirectoryHandle,FileSystemFileHandle,FileSystemWritableFileStream,FileSystemSyncAccessHandle,StorageManager};
}
