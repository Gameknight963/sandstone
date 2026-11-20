import {FileStorage} from './storage.mjs';
import {file_handle,file_metadata} from './codec.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';

const fail=(name,message)=>{throw new DOMException(message,name);};
const missing=()=>fail('NotFoundError','File system entry no longer exists');
const maximum=512*1024*1024;
const pathKey=info=>JSON.stringify(info.path);
const capabilityKey=info=>JSON.stringify([info.kind,info.path]);
const locate=(tree,info)=>[...tree.values()].find(node=>node.kind===info.kind&&pathKey(node)===pathKey(info));
function filename(name){if(typeof name!=='string'||!name||name==='.'||name==='..'||/[\\/\0]/.test(name))throw new TypeError('Invalid file name');return name;}
function size(value){if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid file offset');return value;}
function allocation(value){size(value);if(value>maximum)fail('QuotaExceededError','File exceeds the available memory budget');return value;}
export class FileService{
  constructor(factory,options={}){this.storage=new FileStorage(factory,options);this.leases=new Map();this.locks=options.locks??globalThis.navigator?.locks;}
  async acquire(origin,capability,mode='exclusive'){
    await this.storage.ready;if(!this.storage.persistent)return ()=>{};
    const manager=this.locks;if(!manager)return ()=>{};
    return new Promise((resolve,reject)=>{
      let started=false;
      const failed=error=>{if(!started&&error.name==='SecurityError'){this.locks=null;resolve(()=>{});}else reject(error);};
      try{Promise.resolve(manager.request('sandstone:filesystem:lock:'+JSON.stringify([origin,capability]),{ifAvailable:true,mode},lock=>{
        started=true;if(!lock){reject(new DOMException('File has an active writer','NoModificationAllowedError'));return;}
        return new Promise(release=>resolve(release));
      })).catch(failed);}catch(error){failed(error);}
    });
  }
  drop(token){const lease=this.leases.get(token);if(!lease)return;this.leases.delete(token);lease.release?.();}
  handle(origin,node,tx){
    const key=capabilityKey(node);let capability=tx.capabilities.get(key);
    if(!capability){capability=create_bootstrap_nonce();tx.grant(key,capability);}
    return file_handle({origin,id:node.id,name:node.name,kind:node.kind,path:node.path,capability});
  }
  validate(tx,info){if(tx.capabilities.get(capabilityKey(info))!==info.capability)missing();}
  async command(origin,owner,command){
    if(typeof origin!=='string'||origin==='null'||new URL(origin).origin!==origin)fail('SecurityError','File origin is unavailable');
    if(!command||typeof command.op!=='string')throw new TypeError('Invalid file command');
    const {op}=command;
    if(op.startsWith('sync'))return this.sync(origin,owner,command);
    if(['write','seek','truncate','close','abort'].includes(op))return this.stream(origin,owner,command);
    const info=command.handle&&file_metadata(command.handle);
    if(op!=='root'&&(!info||info.origin!==origin))fail('SecurityError','File handle belongs to another origin');
    if(info)await this.storage.run(origin,false,tx=>{this.validate(tx,info);if(['same','resolve'].includes(op)){const other=file_metadata(command.other);if(other?.origin===origin)this.validate(tx,other);}});
    if(op==='permission')return 'granted';
    if(op==='same'){const other=file_metadata(command.other);return !!other&&other.origin===origin&&pathKey(other)===pathKey(info)&&other.kind===info.kind;}
    if(op==='resolve'){if(info.kind!=='directory')throw new TypeError('A directory is required');const other=file_metadata(command.other);return other&&other.origin===origin&&info.path.every((name,index)=>other.path[index]===name)?other.path.slice(info.path.length):null;}
    const releases=[],locked=new Set();let retained=false,heldToken;
    if(op==='writable'||op==='openSync')releases.push(await this.acquire(origin,info.capability,op==='openSync'||command.mode==='exclusive'?'exclusive':'shared'));
    if(op==='remove'){
      const ids=await this.storage.run(origin,false,({tree,capabilities})=>{
        const parent=locate(tree,info),child=parent&&[...tree.values()].find(value=>value.parent===parent.id&&value.name===command.name);if(!child)return [];
        const ids=new Set([child.id]);let previous;do{previous=ids.size;for(const value of tree.values())if(ids.has(value.parent))ids.add(value.id);}while(previous!==ids.size);return [...ids].map(id=>({id,capability:capabilities.get(capabilityKey(tree.get(id)))||pathKey(tree.get(id))}));
      });
      try{for(const {id,capability} of ids){releases.push(await this.acquire(origin,capability));locked.add(id);}}catch(error){for(const release of releases)release();throw error;}
    }
    const write=['root','file','directory','remove','entries'].includes(op);
    let result;
    try{result=await this.storage.run(origin,write,async tx=>{
      if(info)this.validate(tx,info);
      let node=info?locate(tx.tree,info):tx.tree.get('root');
      if(op==='root'&&!node){node={origin,id:'root',parent:null,name:'',kind:'directory',path:[]};tx.put(node);}
      if(!node)missing();
      if(info&&node.kind!==info.kind)throw new TypeError('Invalid file handle kind');
      if(op==='root')return this.handle(origin,node,tx);
      if(op==='file'||op==='directory'){
        if(node.kind!=='directory')throw new TypeError('A directory is required');
        const name=filename(command.name),kind=op==='file'?'file':'directory';
        let child=[...tx.tree.values()].find(child=>child.parent===node.id&&child.name===name);
        if(child&&child.kind!==kind)fail('TypeMismatchError','Entry has a different kind');
        if(!child){if(!command.create)missing();child={origin,id:create_bootstrap_nonce(),parent:node.id,name,kind,path:[...node.path,name],size:0,modified:Date.now()};tx.put(child);}
        return this.handle(origin,child,tx);
      }
      if(op==='entries'){
        if(node.kind!=='directory')throw new TypeError('A directory is required');
        return [...tx.tree.values()].filter(child=>child.parent===node.id).map(child=>[child.name,this.handle(origin,child,tx)]);
      }
      if(op==='remove'){
        const name=filename(command.name),child=[...tx.tree.values()].find(child=>child.parent===node.id&&child.name===name);if(!child)missing();
        const ids=new Set([child.id]);let previous;
        do{previous=ids.size;for(const value of tx.tree.values())if(ids.has(value.parent))ids.add(value.id);}while(previous!==ids.size);
        if([...ids].some(id=>!locked.has(id)))fail('NoModificationAllowedError','Directory changed during removal');
        if(!command.recursive&&ids.size>1)fail('InvalidModificationError','Directory is not empty');
        if([...this.leases.values()].some(lease=>lease.origin===origin&&ids.has(lease.id)))fail('NoModificationAllowedError','File has an active writer');
        for(const id of ids)tx.remove(id);return;
      }
      if(op==='getFile'){
        if(node.kind!=='file')throw new TypeError('A file is required');
        return {name:node.name,modified:node.modified,bytes:await tx.read(node.id)};
      }
      if(op==='writable'||op==='openSync'){
        if(node.kind!=='file')throw new TypeError('A file is required');
        const mode=op==='openSync'?'exclusive':command.mode===undefined?'siloed':command.mode;if(!['siloed','exclusive'].includes(mode))throw new TypeError('Invalid writable mode');
        if([...this.leases.values()].some(lease=>lease.origin===origin&&lease.id===node.id&&(mode==='exclusive'||lease.mode==='exclusive')))fail('NoModificationAllowedError','File has an active writer');
        const token=create_bootstrap_nonce(),lease={origin,owner,id:node.id,mode,sync:op==='openSync',bytes:new Uint8Array(),position:0,release:()=>{for(const release of releases)release();}};
        this.leases.set(token,lease);heldToken=token;
        try{if(command.keepExistingData)lease.bytes=(await tx.read(node.id)).slice();}catch(error){this.drop(token);throw error;}
        retained=true;
        return token;
      }
      throw new TypeError('Unknown file operation');
    });}catch(error){if(heldToken)this.drop(heldToken);throw error;}finally{if(!retained)for(const release of releases)release();}
    if(write)await this.storage.catalog();return result;
  }
  async sync(origin,owner,command){
    const lease=this.leases.get(command.token);
    if(!lease||!lease.sync||lease.origin!==origin||lease.owner!==owner)fail('InvalidStateError','Synchronous file handle is unavailable');
    if(command.op==='syncClose'){this.drop(command.token);return;}
    const write=command.op==='syncWrite'||command.op==='syncTruncate';
    const result=await this.storage.run(origin,write,async tx=>{
      const node=tx.tree.get(lease.id);if(!node)missing();
      if(command.op==='syncSize')return node.size||0;
      if(command.op==='syncFlush')return;
      const bytes=await tx.read(lease.id),position=command.at===undefined?lease.position:size(command.at);
      if(command.op==='syncRead'){
        const count=Math.min(size(command.size),Math.max(0,bytes.length-position));lease.position=position+count;return {bytes:bytes.slice(position,position+count)};
      }
      let next;
      if(command.op==='syncWrite'){
        if(!(command.bytes instanceof Uint8Array))throw new TypeError('Invalid file bytes');
        if(!command.bytes.length){lease.position=position;return 0;}
        const end=allocation(position+command.bytes.length);next=new Uint8Array(Math.max(bytes.length,end));next.set(bytes);next.set(command.bytes,position);lease.position=end;
      }else if(command.op==='syncTruncate'){
        const length=allocation(command.size);next=new Uint8Array(length);next.set(bytes.subarray(0,length));lease.position=Math.min(lease.position,length);
      }else throw new TypeError('Unknown synchronous file operation');
      tx.write(lease.id,next);tx.put({...node,size:next.length,modified:Date.now()});return command.op==='syncWrite'?command.bytes.length:undefined;
    });
    if(write)await this.storage.catalog();return result;
  }
  async stream(origin,owner,command){
    const lease=this.leases.get(command.token);if(!lease||lease.origin!==origin||lease.owner!==owner)fail('InvalidStateError','File writer is unavailable');
    const {op}=command;
    if(lease.sync||lease.closing)fail('InvalidStateError','File writer is unavailable');
    if(op==='abort'){this.drop(command.token);return;}
    if(op==='close'){
      lease.closing=true;
      try{await this.storage.run(origin,true,tx=>{const node=tx.tree.get(lease.id);if(!node)missing();tx.write(lease.id,lease.bytes);tx.put({...node,size:lease.bytes.length,modified:Date.now()});});}finally{this.drop(command.token);}
      await this.storage.catalog();return;
    }
    if(op==='seek'){lease.position=size(command.position);return;}
    if(op==='truncate'){
      const length=allocation(command.size),bytes=new Uint8Array(length);bytes.set(lease.bytes.subarray(0,length));lease.bytes=bytes;lease.position=Math.min(lease.position,length);return;
    }
    if(op==='write'){
      if(!(command.bytes instanceof Uint8Array))throw new TypeError('Invalid file bytes');
      const position=command.position===undefined?lease.position:size(command.position);
      if(!command.bytes.length){lease.position=position;return;}
      const end=allocation(position+command.bytes.length);
      if(end>lease.bytes.length){const bytes=new Uint8Array(end);bytes.set(lease.bytes);lease.bytes=bytes;}
      lease.bytes.set(command.bytes,position);lease.position=end;return;
    }
    throw new TypeError('Unknown writer operation');
  }
  release(owner){for(const [token,lease] of this.leases)if(lease.owner===owner)this.drop(token);}
  async clear(hostname){
    for(const [token,lease] of this.leases){const host=new URL(lease.origin).hostname;if(!hostname||host===hostname)this.drop(token);}
    await this.storage.clear(hostname);
  }
}
