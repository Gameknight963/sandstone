import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {FileService} from '../src/filesystem/service.mjs';
import {file_handle,file_metadata} from '../src/filesystem/codec.mjs';
import {create_file_client} from '../src/filesystem/client.mjs';
import {MemoryLockManager} from '../src/locks/manager.mjs';
import {estimate_storage} from '../src/filesystem/estimate.mjs';
const origin='https://files.test',owner='document';
const fixture=factory=>{const service=new FileService(factory);return {service,call:command=>service.command(origin,owner,structuredClone(command))};};
test('File directories, handles and binary writes remain origin scoped',async()=>{
  const {service,call}=fixture();const root=await call({op:'root'}),directory=await call({op:'directory',handle:root,name:'data',create:true}),file=await call({op:'file',handle:directory,name:'x.bin',create:true});
  assert.equal(file_metadata(root).name,'');assert.deepEqual(await call({op:'resolve',handle:root,other:file}),['data','x.bin']);
  assert.equal(await call({op:'same',handle:file,other:structuredClone(file)}),true);
  const token=await call({op:'writable',handle:file});await call({op:'write',token,bytes:Uint8Array.of(1,2,3),position:2});
  assert.deepEqual((await call({op:'getFile',handle:file})).bytes,new Uint8Array());
  await call({op:'close',token});assert.deepEqual((await call({op:'getFile',handle:file})).bytes,Uint8Array.of(0,0,1,2,3));
  await assert.rejects(service.command('https://other.test',owner,{op:'getFile',handle:file}),{name:'SecurityError'});
  const other=await service.command('https://other.test',owner,{op:'root'});assert.deepEqual(await service.command('https://other.test',owner,{op:'entries',handle:other}),[]);
});
test('Writable abort, truncation, seek and concurrent lock modes preserve committed files',async()=>{
  const {call}=fixture(),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'x',create:true});
  let token=await call({op:'writable',handle:file});await call({op:'write',token,bytes:Uint8Array.of(1,2,3)});await call({op:'close',token});
  token=await call({op:'writable',handle:file,keepExistingData:true});await call({op:'truncate',token,size:5});await call({op:'seek',token,position:1});await call({op:'write',token,bytes:Uint8Array.of(8)});await call({op:'abort',token});
  assert.deepEqual((await call({op:'getFile',handle:file})).bytes,Uint8Array.of(1,2,3));
  const locks=await Promise.allSettled([call({op:'writable',handle:file,mode:'exclusive',keepExistingData:true}),call({op:'writable',handle:file,mode:'exclusive',keepExistingData:true})]);
  assert.equal(locks.filter(result=>result.status==='fulfilled').length,1);assert.equal(locks.find(result=>result.status==='rejected').reason.name,'NoModificationAllowedError');
  await call({op:'abort',token:locks.find(result=>result.status==='fulfilled').value});
});
test('File storage persists across services and clearing invalidates old handles and writers',async()=>{
  const factory=new IDBFactory(),first=fixture(factory),root=await first.call({op:'root'}),file=await first.call({op:'file',handle:root,name:'saved',create:true});
  let token=await first.call({op:'writable',handle:file});await first.call({op:'write',token,bytes:Uint8Array.of(42)});await first.call({op:'close',token});
  const second=fixture(factory);assert.equal((await second.call({op:'getFile',handle:file})).bytes[0],42);
  token=await first.call({op:'writable',handle:file});await second.service.clear('files.test');
  await assert.rejects(first.call({op:'close',token}),{name:'NotFoundError'});await assert.rejects(second.call({op:'getFile',handle:file}),{name:'NotFoundError'});
  assert.deepEqual(await second.service.storage.catalog(),[]);
});
test('File directory removal checks descendants, names, lease ownership and deleted identities',async()=>{
  const {service,call}=fixture(),root=await call({op:'root'}),dir=await call({op:'directory',handle:root,name:'folder',create:true}),file=await call({op:'file',handle:dir,name:'x',create:true});
  await assert.rejects(call({op:'remove',handle:root,name:'folder'}),{name:'InvalidModificationError'});
  await assert.rejects(call({op:'file',handle:root,name:'../x',create:true}),TypeError);
  const token=await call({op:'writable',handle:file});await assert.rejects(service.command(origin,'foreign',{op:'close',token}),{name:'InvalidStateError'});
  await assert.rejects(call({op:'remove',handle:root,name:'folder',recursive:true}),{name:'NoModificationAllowedError'});
  service.release(owner);await call({op:'remove',handle:root,name:'folder',recursive:true});
  const replacement=await call({op:'directory',handle:root,name:'folder',create:true});assert.equal(await call({op:'same',handle:dir,other:replacement}),true);
  assert.deepEqual(await call({op:'resolve',handle:root,other:file}),['folder','x']);
});

test('Per-host file clearing preserves subdomains, unrelated hosts and their open writers',async()=>{
  const factory=new IDBFactory(),service=new FileService(factory),origins=['https://files.test','https://files.test:8443','https://child.files.test','https://other.test'];
  const files=await Promise.all(origins.map(async(origin,index)=>{
    const owner='owner-'+index,call=command=>service.command(origin,owner,command),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'saved',create:true}),token=await call({op:'writable',handle:file});
    await call({op:'write',token,bytes:Uint8Array.of(index+1)});return {call,file,token};
  }));
  await service.clear('files.test');
  for(const file of files.slice(0,2)){await assert.rejects(file.call({op:'close',token:file.token}),{name:'InvalidStateError'});await assert.rejects(file.call({op:'getFile',handle:file.file}),{name:'NotFoundError'});}
  for(const [index,file] of files.slice(2).entries()){await file.call({op:'close',token:file.token});assert.deepEqual((await file.call({op:'getFile',handle:file.file})).bytes,Uint8Array.of(index+3));}
  const reloaded=new FileService(factory);
  assert.deepEqual((await service.storage.catalog()).map(entry=>entry.origin).sort(),origins.slice(2).sort());
  assert.deepEqual((await reloaded.command(origins[2],'reloaded',{op:'getFile',handle:files[2].file})).bytes,Uint8Array.of(3));
  await reloaded.clear();assert.deepEqual(await service.storage.catalog(),[]);
});
test('Directory iterators bypass public overrides and remain resumable after an early exit',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory();
  await root.getFileHandle('a.txt',{create:true});await root.getDirectoryHandle('folder',{create:true});
  root.entries=()=>{throw new Error('Authored entries override');};
  const collect=async iterator=>{const result=[];for await(const item of iterator)result.push(item);return result;};
  assert.deepEqual((await collect(root.keys())).sort(),['a.txt','folder']);
  assert.deepEqual((await collect(root.values())).map(handle=>[handle.name,handle.kind]).sort(),[['a.txt','file'],['folder','directory']]);
  const iterator=root.keys();assert.equal(iterator.return,undefined);assert.equal(iterator.throw,undefined);
  assert.equal(Object.prototype.toString.call(iterator),'[object FileSystemDirectoryHandle AsyncIterator]');
  let first;for await(const name of iterator){first=name;break;}
  const rest=await collect(iterator);assert.equal(rest.length,1);assert.deepEqual([first,...rest].sort(),['a.txt','folder']);
});

test('Directory iterators validate receivers immediately and serialize concurrent next requests',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory(),file=await root.getFileHandle('saved',{create:true});
  for(const method of ['entries','keys','values'])for(const receiver of [{},file])assert.throws(()=>client.FileSystemDirectoryHandle.prototype[method].call(receiver),TypeError);
  const iterator=root.values();
  const records=await Promise.all([iterator.next(),iterator.next(),iterator.next()]);
  assert.equal(records.filter(record=>record.done).length,2);assert.equal(records.find(record=>!record.done).value.name,'saved');
  await assert.rejects(Object.getPrototypeOf(iterator).next.call({}),TypeError);
  const removed=await root.getDirectoryHandle('removed',{create:true});await root.removeEntry('removed');
  const missing=removed.entries();await assert.rejects(missing.next(),{name:'NotFoundError'});assert.deepEqual(await missing.next(),{value:undefined,done:true});
});

test('File client streams queue concurrent writes, ignore public overrides and preserve writer locking',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory(),file=await root.getFileHandle('queued.txt',{create:true});
  const stream=await file.createWritable();stream.getWriter=()=>{throw new Error('Authored override');};
  await Promise.all([stream.write('a'),stream.write('b'),stream.seek(4),stream.write(new Uint8Array([8,9]).subarray(1))]);
  await stream.close();assert.deepEqual([...new Uint8Array(await (await file.getFile()).arrayBuffer())],[97,98,0,0,9]);
  const next=await file.createWritable(),writer=WritableStream.prototype.getWriter.call(next);
  await assert.rejects(next.write('x'),TypeError);await writer.abort();writer.releaseLock();
  const invalid=await file.createWritable({mode:'exclusive'});await assert.rejects(invalid.write({type:'write'}),{name:'SyntaxError'});
  const replacement=await file.createWritable({mode:'exclusive'});await replacement.abort();
  assert.equal((await(await root.getFileHandle('png',{create:true})).getFile()).type,'');
});
test('File write conversion failures preserve streams while sink failures discard uncommitted data',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory(),file=await root.getFileHandle('conversion.txt',{create:true});
  let stream=await file.createWritable({mode:'exclusive'});
  for(const value of [null,undefined,Symbol('invalid'),()=>{}])await assert.rejects(stream.write(value),TypeError);
  await assert.rejects(stream.seek(1n),TypeError);
  await assert.rejects(file.createWritable({mode:'exclusive'}),{name:'NoModificationAllowedError'});
  await stream.write('saved');await stream.close();
  stream=await file.createWritable({mode:'exclusive'});await stream.write('uncommitted');
  await assert.rejects(stream.write({type:'write'}),{name:'SyntaxError'});
  assert.equal(await(await file.getFile()).text(),'saved');
  const next=await file.createWritable({mode:'exclusive'});await next.abort();
});

test('File write dictionaries convert in member order before queueing without snapshotting queued views early',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory(),file=await root.getFileHandle('getters.txt',{create:true}),stream=await file.createWritable();
  const first=stream.write(new Blob(['first'])),bytes=Uint8Array.of(1,2),order=[];
  const second=stream.write({get type(){order.push('type');return 'write';},get data(){order.push('data');return bytes;},get position(){order.push('position');return 8;},get size(){order.push('size');return 1;}});
  assert.deepEqual(order,['data','position','size','type']);bytes.fill(9);
  await first;await second;await stream.close();assert.deepEqual([...new Uint8Array(await(await file.getFile()).arrayBuffer())],[102,105,114,115,116,0,0,0,9,9]);
});

test('File handle cloning retains cycles, aliases and native identity without exposing Blob methods',async()=>{
  const {service}=fixture(),client=create_file_client(command=>service.command(origin,owner,structuredClone(command))),root=await client.storage.getDirectory(),file=await root.getFileHandle('x',{create:true});
  const value={file,alias:file,list:[file],map:new Map([[file,root]])};value.self=value;
  const copy=client.decode(structuredClone(value));assert.equal(copy.self,copy);assert.equal(copy.file,copy.alias);assert.equal(copy.list[0],copy.file);assert.equal(copy.map.get(copy.file).kind,'directory');
  assert.ok(copy.file instanceof client.FileSystemFileHandle);assert.equal(await file.isSameEntry(copy.file),true);assert.equal(file.arrayBuffer,undefined);
  assert.equal(JSON.stringify(file),'{}');assert.throws(()=>new client.FileSystemHandle(),TypeError);await assert.rejects(client.FileSystemFileHandle.prototype.getFile.call({}),TypeError);
});
test('Synchronous file leases commit each write, share cursor state and exclude other writers',async()=>{
  const {call}=fixture(),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'sync',create:true}),token=await call({op:'openSync',handle:file});
  await assert.rejects(call({op:'writable',handle:file}),{name:'NoModificationAllowedError'});
  assert.equal(await call({op:'syncWrite',token,bytes:Uint8Array.of(1,2,3),at:2}),3);
  assert.deepEqual((await call({op:'getFile',handle:file})).bytes,Uint8Array.of(0,0,1,2,3));
  assert.deepEqual((await call({op:'syncRead',token,size:8,at:1})).bytes,Uint8Array.of(0,1,2,3));
  assert.equal(await call({op:'syncSize',token}),5);await call({op:'syncTruncate',token,size:3});await call({op:'syncFlush',token});
  await call({op:'syncClose',token});await assert.rejects(call({op:'syncSize',token}),{name:'InvalidStateError'});
  const writer=await call({op:'writable',handle:file});await call({op:'abort',token:writer});
});
test('Independent filesystem services coordinate writers and removal through shared native locks',async()=>{
  const factory=new IDBFactory(),locks=new MemoryLockManager(),first=new FileService(factory,{locks}),second=new FileService(factory,{locks});
  const root=await first.command(origin,owner,{op:'root'}),file=await first.command(origin,owner,{op:'file',handle:root,name:'shared',create:true});
  const token=await first.command(origin,owner,{op:'writable',handle:file});
  await assert.rejects(second.command(origin,'other',{op:'openSync',handle:file}),{name:'NoModificationAllowedError'});
  await assert.rejects(second.command(origin,'other',{op:'remove',handle:root,name:'shared'}),{name:'NoModificationAllowedError'});
  await first.command(origin,owner,{op:'abort',token});
  const sync=await second.command(origin,'other',{op:'openSync',handle:file});await second.command(origin,'other',{op:'syncClose',token:sync});
  await first.command(origin,owner,{op:'remove',handle:root,name:'shared'});
});
test('Storage-denied filesystem sessions do not lock unrelated in-memory files in another host',async()=>{
  const locks=new MemoryLockManager(),first=new FileService(undefined,{locks}),second=new FileService(undefined,{locks});
  const open=async service=>{const root=await service.command(origin,owner,{op:'root'}),file=await service.command(origin,owner,{op:'file',handle:root,name:'independent',create:true});return service.command(origin,owner,{op:'openSync',handle:file});};
  const [a,b]=await Promise.all([open(first),open(second)]);
  await first.command(origin,owner,{op:'syncClose',token:a});await second.command(origin,owner,{op:'syncClose',token:b});
});
test('Empty writes can move the cursor without extending either writable or synchronous files',async()=>{
  const {call}=fixture(),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'empty',create:true});
  let token=await call({op:'writable',handle:file});await call({op:'seek',token,position:1000000000});await call({op:'write',token,bytes:new Uint8Array()});await call({op:'close',token});
  assert.equal((await call({op:'getFile',handle:file})).bytes.length,0);
  token=await call({op:'openSync',handle:file});assert.equal(await call({op:'syncWrite',token,bytes:new Uint8Array(),at:1000000000}),0);assert.equal(await call({op:'syncSize',token}),0);await call({op:'syncClose',token});
});
test('Serialized file capabilities cannot be forged for another path or replayed after clearing',async()=>{
  const {call,service}=fixture(),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'secret',create:true}),info=file_metadata(file);
  await assert.rejects(call({op:'getFile',handle:file_handle({...info,capability:'0'.repeat(32)})}),{name:'NotFoundError'});
  await assert.rejects(call({op:'same',handle:file_handle({...info,path:[],kind:'directory'}),other:root}),{name:'NotFoundError'});
  const other=create_file_client(()=>{}, {origin:()=> 'https://other.test'});assert.throws(()=>other.decode(structuredClone(file)),{name:'DataCloneError'});
  await service.clear('files.test');const next=await call({op:'root'});await call({op:'file',handle:next,name:'secret',create:true});
  await assert.rejects(call({op:'getFile',handle:file}),{name:'NotFoundError'});
});
test('Storage estimates count owned files, local storage and catalogs without exposing another origin',()=>{
  const state={local:{[origin]:[['key','value']]},indexed:[{origin,name:'records',version:1}],cacheStorage:[{origin,name:'assets'}],serviceWorkers:[{origin,scope:origin+'/'}]};
  const before=estimate_storage(origin,state,7,1000000);assert.ok(before.usage>7);assert.equal(before.usageDetails.localStorage,16);assert.equal(before.usageDetails.fileSystem,7);
  for(const key of ['indexed','cacheStorage','serviceWorkers'])state[key].push({origin:'https://other.test',name:'private'.repeat(1000)});
  state.local['https://other.test']=[['secret','contents']];assert.deepEqual(estimate_storage(origin,state,7,1000000),before);
});
test('Clearing a bucket revokes old capabilities without letting an old tab block its replacement',async()=>{
  const factory=new IDBFactory(),locks=new MemoryLockManager(),first=new FileService(factory,{locks}),second=new FileService(factory,{locks});
  let root=await first.command(origin,owner,{op:'root'}),file=await first.command(origin,owner,{op:'file',handle:root,name:'reset',create:true}),old=await first.command(origin,owner,{op:'openSync',handle:file});
  await second.clear('files.test');root=await second.command(origin,'new',{op:'root'});file=await second.command(origin,'new',{op:'file',handle:root,name:'reset',create:true});
  const token=await second.command(origin,'new',{op:'openSync',handle:file});
  await assert.rejects(first.command(origin,owner,{op:'syncWrite',token:old,bytes:Uint8Array.of(9)}),{name:'NotFoundError'});
  await second.command(origin,'new',{op:'syncClose',token});await first.command(origin,owner,{op:'syncClose',token:old});
});
test('Filesystem schema upgrades retain existing file data while adding handle authorization',async()=>{
  const factory=new IDBFactory();
  const db=await new Promise((resolve,reject)=>{const request=factory.open('sandstone:filesystem:v1',1);request.onupgradeneeded=()=>{for(const name of ['nodes','bytes'])request.result.createObjectStore(name,{keyPath:['origin','id']}).createIndex('origin','origin');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(['nodes','bytes'],'readwrite');tx.objectStore('nodes').put({origin,id:'root',parent:null,name:'',kind:'directory'});tx.objectStore('nodes').put({origin,id:'legacy',parent:'root',name:'saved.txt',kind:'file',size:3,modified:1});tx.objectStore('bytes').put({origin,id:'legacy',bytes:Uint8Array.of(1,2,3)});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  const {call}=fixture(factory),root=await call({op:'root'}),file=await call({op:'file',handle:root,name:'saved.txt'});
  assert.deepEqual((await call({op:'getFile',handle:file})).bytes,Uint8Array.of(1,2,3));assert.match(file_metadata(file).capability,/^[a-f0-9]{32}$/);
});
