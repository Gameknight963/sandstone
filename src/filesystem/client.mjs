import {file_metadata} from './codec.mjs';
import {transform_keys} from '../crypto/codec.mjs';
import mimeTypes from 'mime-db';

const extensions=new Map();
for(const [type,info] of Object.entries(mimeTypes))for(const extension of info.extensions||[])if(!extensions.has(extension))extensions.set(extension,type);
const fileType=name=>name.includes('.')?extensions.get(name.split('.').pop().toLowerCase())||'':'';

const text=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);};
const offset=value=>{const number=Math.trunc(+value);if(!Number.isFinite(number)||number<0||number>Number.MAX_SAFE_INTEGER)throw new TypeError('Invalid file offset');return number;};
const unsigned=value=>{const number=+value;if(!Number.isFinite(number)||number===0)return 0;const result=Math.trunc(number)%2**64;return result<0?result+2**64:result;};
const usv=value=>text(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD');
const blobSize=Object.getOwnPropertyDescriptor(Blob.prototype,'size').get,blobBytes=Blob.prototype.arrayBuffer;
const bufferSize=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const sharedSize=typeof SharedArrayBuffer==='function'&&Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,'byteLength').get;
const isView=ArrayBuffer.isView;
const viewGetters=[Object.getPrototypeOf(Uint8Array.prototype),DataView.prototype].map(prototype=>Object.fromEntries(['buffer','byteOffset','byteLength'].map(key=>[key,Object.getOwnPropertyDescriptor(prototype,key).get])));
const branded=(getter,value)=>{try{Reflect.apply(getter,value,[]);return true;}catch{return false;}};
const generatorPrototype=Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})()));
const generatorNext=generatorPrototype.next,asyncIteratorPrototype=Object.getPrototypeOf(generatorPrototype);
function viewInfo(value){
  for(const getters of viewGetters){
    let buffer;try{buffer=Reflect.apply(getters.buffer,value,[]);}catch{continue;}
    return {buffer,getters};
  }
  throw new TypeError('A buffer view is required');
}
function nativeView(value){const {buffer,getters}=viewInfo(value);return new Uint8Array(buffer,Reflect.apply(getters.byteOffset,value,[]),Reflect.apply(getters.byteLength,value,[]));}
export function create_file_client(dispatch,{worker=false,origin=()=>undefined}={}){
  const handles=new WeakMap(),streams=new WeakMap(),syncHandles=new WeakMap(),secret={},blob=Blob.prototype;let sync;
  const iterators=new WeakMap(),iteratorPrototype=Object.create(asyncIteratorPrototype);
  Object.defineProperties(iteratorPrototype,{
    next:{enumerable:true,configurable:true,writable:true,value:async function next(){
      const generator=iterators.get(this);if(!generator)throw new TypeError('Invalid directory iterator receiver');
      return Reflect.apply(generatorNext,generator,[]);
    }},
    [Symbol.toStringTag]:{value:'FileSystemDirectoryHandle AsyncIterator',configurable:true}
  });
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
  function directoryIterator(handle,kind){
    if(info(handle).kind!=='directory')throw new TypeError('Invalid directory handle receiver');
    // Keep iteration independent of authored entries/keys/values overrides.
    // A Web IDL async iterator has no generator return()/throw() methods, so
    // breaking a for-await loop must not close a retained iterator.
    const generator=(async function*(){
      const entries=await send(handle,'entries');
      for(const [name,value] of entries)yield kind==='keys'?name:kind==='values'?decode(value):[name,decode(value)];
    })();
    const iterator=Object.create(iteratorPrototype);iterators.set(iterator,generator);return iterator;
  }
  class FileSystemDirectoryHandle extends FileSystemHandle{
    async getFileHandle(name,options={}){if(!arguments.length)throw new TypeError('File name is required');return decode(await send(this,'file',{name:text(name),create:!!options?.create}));}
    async getDirectoryHandle(name,options={}){if(!arguments.length)throw new TypeError('Directory name is required');return decode(await send(this,'directory',{name:text(name),create:!!options?.create}));}
    async removeEntry(name,options={}){if(!arguments.length)throw new TypeError('File name is required');return send(this,'remove',{name:text(name),recursive:!!options?.recursive});}
    async resolve(other){info(other);return send(this,'resolve',{other});}
    entries(){return directoryIterator(this,'entries');}
    keys(){return directoryIterator(this,'keys');}
    values(){return directoryIterator(this,'values');}
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
  function dataValue(value){
    if(branded(blobSize,value)||branded(bufferSize,value))return value;
    if(isView(value)){
      if(!branded(bufferSize,viewInfo(value).buffer))throw new TypeError('Shared buffers are not writable file chunks');
      return value;
    }
    return usv(value);
  }
  function convertChunk(value){
    if(branded(blobSize,value)||isView(value)||branded(bufferSize,value))return dataValue(value);
    if(value==null||typeof value==='object'||typeof value==='function'){
      // Web IDL reads dictionary members in alphabetical order. The public
      // convenience method converts before queueing; writer.write converts
      // when its chunk reaches the sink. Keep BufferSources live until then.
      const result=Object.create(null),data=value?.data;
      if(data!==undefined)result.data=data===null?null:dataValue(data);
      const position=value?.position;if(position!==undefined)result.position=position===null?null:unsigned(position);
      const size=value?.size;if(size!==undefined)result.size=size===null?null:unsigned(size);
      const type=text(value?.type);if(!['write','seek','truncate'].includes(type))throw new TypeError('Invalid file write command');
      result.type=type;return result;
    }
    return usv(value);
  }
  async function chunk(value){
    const input=convertChunk(value);let position,data=input;
    if(input!==null&&typeof input==='object'&&!branded(blobSize,input)&&!isView(input)&&!branded(bufferSize,input)){
      if(input.type==='seek'){
        if(input.position==null)throw new DOMException('Seek position is required','SyntaxError');
        return {op:'seek',position:input.position};
      }
      if(input.type==='truncate'){
        if(input.size==null)throw new DOMException('Truncate size is required','SyntaxError');
        return {op:'truncate',size:input.size};
      }
      if(input.data===undefined)throw new DOMException('Write data is required','SyntaxError');
      if(input.data===null)throw new TypeError('Write data must not be null');
      data=input.data;if(input.position!=null)position=input.position;
    }
    let bytes;
    if(branded(blobSize,data))bytes=new Uint8Array(await Reflect.apply(blobBytes,data,[]));
    else if(isView(data))bytes=nativeView(data).slice();
    else if(branded(bufferSize,data))bytes=new Uint8Array(data).slice();
    else bytes=new TextEncoder().encode(data);
    return {op:'write',bytes,...(position===undefined?{}:{position})};
  }
  class FileSystemWritableFileStream extends WritableStream{
    constructor(key,token){
      if(key!==secret)throw new TypeError('Illegal constructor');
      super({write:async value=>{try{return await dispatch({...await chunk(value),token});}catch(error){await dispatch({op:'abort',token}).catch(()=>{});throw error;}},close:()=>dispatch({op:'close',token}),abort:()=>dispatch({op:'abort',token})});
      streams.set(this,token);
    }
    async write(value){
      if(!streams.has(this))throw new TypeError('Invalid FileSystemWritableFileStream receiver');
      if(!arguments.length)throw new TypeError('Write data is required');
      return enqueue(this,convertChunk(value));
    }
    async seek(position){if(!streams.has(this))throw new TypeError('Invalid FileSystemWritableFileStream receiver');if(!arguments.length)throw new TypeError('File position is required');return enqueue(this,{type:'seek',position:unsigned(position)});}
    async truncate(size){if(!streams.has(this))throw new TypeError('Invalid FileSystemWritableFileStream receiver');if(!arguments.length)throw new TypeError('File size is required');return enqueue(this,{type:'truncate',size:unsigned(size)});}
  }
  const view=value=>{
    if(isView(value))return nativeView(value);
    if(branded(bufferSize,value)||sharedSize&&branded(sharedSize,value))return new Uint8Array(value);
    throw new TypeError('A BufferSource is required');
  };
  const syncInfo=handle=>{const state=syncHandles.get(handle);if(!state)throw new TypeError('Invalid FileSystemSyncAccessHandle receiver');if(state.closed)throw new DOMException('File handle is closed','InvalidStateError');return state;};
  class FileSystemSyncAccessHandle{
    constructor(key,token){if(key!==secret)throw new TypeError('Illegal constructor');const handle=new Proxy(this,{});syncHandles.set(handle,{token,closed:false});return handle;}
    read(buffer,options={}){const state=syncInfo(this),target=view(buffer),at=options?.at,result=sync({op:'syncRead',token:state.token,size:target.byteLength,...(at===undefined?{}:{at:offset(at)})});target.set(result.bytes);return result.bytes.length;}
    write(buffer,options={}){const state=syncInfo(this),source=view(buffer),at=options?.at,position=at===undefined?{}:{at:offset(at)},bytes=source.slice();return sync({op:'syncWrite',token:state.token,bytes,...position}).value;}
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
