import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {CryptoService} from '../src/crypto/service.mjs';
import {create_crypto_client} from '../src/crypto/client.mjs';
import {key_metadata,key_handle,key_tag} from '../src/crypto/codec.mjs';

const bytes=new Uint8Array([1,2,3]),algorithm={name:'HMAC',hash:'SHA-256'};
const client=service=>create_crypto_client(async(method,args)=>structuredClone(await service.call(method,structuredClone(args))));
function fixture(){
  const vault=new CryptoService(webcrypto),first=new CryptoService(webcrypto),second=new CryptoService(webcrypto);
  const transport={store:records=>vault.store(structuredClone(records)),load:handles=>structuredClone(vault.load(structuredClone(handles)))};
  first.setVault(transport);second.setVault(transport);return {vault,first,second,a:client(first),b:client(second)};
}

test('A private vault preserves nonextractable keys and their permissions after the creating service is gone',async()=>{
  const {first,second,vault,a,b}=fixture(),key=await a.subtle.generateKey(algorithm,false,['sign']);
  const expected=await a.subtle.sign('HMAC',key,bytes),message=structuredClone(key),id=key_metadata(message)[key_tag];
  assert.equal(vault.keys.has(id),true);first.keys.clear();
  const received=b.decode(message);assert.equal(received.extractable,false);assert.deepEqual(received.usages,['sign']);
  assert.deepEqual(await b.subtle.sign('HMAC',received,bytes),expected);assert.equal(second.keys.has(id),true);
  let nativeError;await assert.rejects(webcrypto.subtle.exportKey('raw',vault.load([message])[0]),error=>{nativeError=error;return true;});
  await assert.rejects(b.subtle.exportKey('raw',received),{name:nativeError.name,message:nativeError.message});
  await assert.rejects(b.subtle.verify('HMAC',received,expected,bytes),{name:'InvalidAccessError'});
});

test('Vault key resolution retains cyclic graphs, aliases, sparse arrays, Maps, Sets and transferred ports',async()=>{
  const {a,b,second}=fixture(),key=await a.subtle.generateKey(algorithm,false,['sign']),channel=new MessageChannel();
  const graph={key,other:key,array:new Array(4),map:new Map(),set:new Set(),port:channel.port1};
  graph.self=graph;graph.array[3]=key;graph.map.set(key,graph);graph.set.add(key);
  const snapshot=structuredClone(graph,{transfer:[channel.port1]}),decoded=b.decode(snapshot);
  assert.equal(decoded.self,decoded);assert.equal(decoded.key,decoded.other);assert.equal(decoded.array[3],decoded.key);
  assert.equal(0 in decoded.array,false);assert.equal(decoded.map.get(decoded.key),decoded);assert.equal([...decoded.set][0],decoded.key);
  await second.decode_shared(snapshot); // Resolve only key handles; never serialize the port through the vault.
  assert.equal((await b.subtle.sign('HMAC',decoded.key,bytes)).byteLength,32);
  const reply=new Promise(resolve=>channel.port2.once('message',resolve));decoded.port.postMessage('still connected');assert.equal(await reply,'still connected');
  decoded.port.close();channel.port2.close();
});

test('A key is not returned until its vault commit succeeds and concurrent publication shares that commit',async()=>{
  const service=new CryptoService(webcrypto),vault=new CryptoService(webcrypto),native=await webcrypto.subtle.generateKey(algorithm,false,['sign']);
  let commit,stores=0;const held=new Promise(resolve=>{commit=resolve;});
  service.setVault({store:async records=>{stores++;await held;vault.store(structuredClone(records));},load:()=>[]});
  let settled=false;const first=service.encode_shared(native).then(value=>{settled=true;return value;}),second=service.encode_shared(native);
  await Promise.resolve();assert.equal(stores,1);assert.equal(settled,false);commit();
  const [a,b]=await Promise.all([first,second]);assert.equal(key_metadata(a)[key_tag],key_metadata(b)[key_tag]);assert.equal(vault.keys.size,1);
});

test('Rejected vault writes can be retried, while a detached vault leaves local keys usable',async()=>{
  const service=new CryptoService(webcrypto),native=await webcrypto.subtle.generateKey(algorithm,false,['sign']);let writes=0;
  const detach=service.setVault({store(){if(++writes===1)throw new Error('unavailable');},load:()=>[]});
  await assert.rejects(service.encode_shared(native),/unavailable/);const handle=await service.encode_shared(native);assert.equal(writes,2);
  detach();assert.equal(service.encode_shared(native) instanceof Promise,false);
  assert.equal(service.decode_shared(handle).extractable,false);
});

test('Native key adoption validates the entire batch before changing capabilities',async()=>{
  const service=new CryptoService(webcrypto),source=new CryptoService(webcrypto);
  const first=await webcrypto.subtle.generateKey(algorithm,false,['sign']),second=await webcrypto.subtle.generateKey({name:'AES-GCM',length:128},false,['encrypt']);
  const handle=source.encode(first),other=source.encode(second),metadata=key_metadata(handle);
  assert.throws(()=>service.store([{handle,key:first},{handle:other,key:first}]),{name:'DataCloneError'});assert.equal(service.keys.size,0);
  assert.throws(()=>service.store([{handle:key_handle({...metadata,usages:['verify']}),key:first}]),{name:'DataCloneError'});
  service.store([{handle,key:structuredClone(first)}]);assert.equal(service.load([handle])[0].extractable,false);
  assert.throws(()=>service.store([{handle,key:{}}]),{name:'DataCloneError'});assert.throws(()=>service.load([new Blob()]),{name:'DataCloneError'});
});

test('Resolving an unknown key fails without inventing a capability or accepting an incomplete vault reply',async()=>{
  const service=new CryptoService(webcrypto),source=new CryptoService(webcrypto),key=await webcrypto.subtle.generateKey(algorithm,false,['sign']),handle=source.encode(key);
  service.setVault({store(){},load:()=>[null]});await assert.rejects(service.decode_shared(handle),{name:'DataCloneError'});assert.equal(service.keys.size,0);
  service.setVault({store(){},load:()=>[]});await assert.rejects(service.decode_shared(handle),{name:'DataCloneError'});assert.equal(service.keys.size,0);
});
