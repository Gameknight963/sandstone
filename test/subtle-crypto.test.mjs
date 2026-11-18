import test from 'node:test';
import assert from 'node:assert/strict';
import {CryptoService} from '../src/crypto/service.mjs';
import {create_crypto_client} from '../src/crypto/client.mjs';
import {transform_keys} from '../src/crypto/codec.mjs';
import {webcrypto} from 'node:crypto';

const bytes=value=>new TextEncoder().encode(value);
const hex=value=>Buffer.from(value).toString('hex');
function fixture(){
  const service=new CryptoService(webcrypto);
  const client=create_crypto_client(async(method,args)=>structuredClone(await service.call(method,structuredClone(args))));
  return {service,client,subtle:client.subtle};
}

test('Relayed Web Crypto hashes and authenticates with native key permissions',async()=>{
  const {subtle,client,service}=fixture();
  assert.equal(hex(await subtle.digest('SHA-256',bytes('abc'))),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const key=await subtle.importKey('raw',bytes('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  assert.ok(key instanceof client.CryptoKey);assert.equal(key.type,'secret');assert.equal(key.extractable,false);
  assert.equal(JSON.stringify(key),'{}');assert.deepEqual(key.usages,['sign','verify']);
  const signature=await subtle.sign('HMAC',key,bytes('message'));
  assert.equal(await subtle.verify('HMAC',key,signature,bytes('message')),true);
  assert.equal(await subtle.verify('HMAC',key,signature,bytes('changed')),false);
  // Node versions differ in the name used for exporting a nonextractable key.
  // The relay must preserve the host's actual error, including its message.
  let nativeFailure;
  await assert.rejects(webcrypto.subtle.exportKey('raw',service.decode(client.encode(key))),error=>{nativeFailure=error;return true;});
  await assert.rejects(subtle.exportKey('raw',key),{name:nativeFailure.name,message:nativeFailure.message});
  await assert.rejects(subtle.digest('not-an-algorithm',bytes('abc')),{name:'NotSupportedError'});
  await assert.rejects(subtle.digest.call({},'SHA-256',bytes('abc')),TypeError);
});

test('Relayed AES snapshots BufferSource views and honors inherited algorithm dictionaries',async()=>{
  const {subtle}=fixture();
  const key=await subtle.importKey('raw',new Uint8Array(16),'AES-GCM',true,new Set(['encrypt','decrypt']));
  const iv=new Uint8Array(12),source=bytes('xpayloadx'),view=new DataView(source.buffer,1,7);
  const algorithm=Object.create({name:'AES-GCM',iv});
  const encrypted=subtle.encrypt(algorithm,key,view);
  source.fill(0);iv.fill(9);
  const ciphertext=await encrypted;
  assert.equal(new TextDecoder().decode(await subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,ciphertext)),'payload');
  const damaged=new Uint8Array(ciphertext);damaged[0]^=1;
  await assert.rejects(subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,damaged),{name:'OperationError'});
  const jwk=await subtle.exportKey('jwk',key);
  const imported=await subtle.importKey('jwk',Object.create(jwk),'AES-GCM',true,['encrypt']);
  await assert.rejects(subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},imported,ciphertext),{name:'InvalidAccessError'});
});

test('Relayed derivation, ECDH public keys, signatures, and key wrapping use native implementations',async()=>{
  const {subtle}=fixture();
  const password=await subtle.importKey('raw',bytes('password'),'PBKDF2',false,['deriveBits','deriveKey']);
  const bits=await subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:bytes('salt'),iterations:1},password,256);
  assert.equal(hex(bits),'120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  const key=await subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:bytes('salt'),iterations:1},password,{name:'AES-GCM',length:128},true,['encrypt','decrypt']);
  const wrapping=await subtle.generateKey({name:'AES-KW',length:128},false,['wrapKey','unwrapKey']);
  const wrapped=await subtle.wrapKey('raw',key,wrapping,'AES-KW');
  const unwrapped=await subtle.unwrapKey('raw',wrapped,wrapping,'AES-KW','AES-GCM',true,['encrypt']);
  assert.equal(hex(await subtle.exportKey('raw',unwrapped)),hex(await subtle.exportKey('raw',key)));
  const alice=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const bob=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  assert.equal(hex(await subtle.deriveBits({name:'ECDH',public:bob.publicKey},alice.privateKey,256)),hex(await subtle.deriveBits({name:'ECDH',public:alice.publicKey},bob.privateKey,256)));
  const signing=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const signature=await subtle.sign({name:'ECDSA',hash:'SHA-256'},signing.privateKey,bytes('signed'));
  assert.equal(await subtle.verify({name:'ECDSA',hash:'SHA-256'},signing.publicKey,signature,bytes('signed')),true);
});

test('Key transport preserves cycles, aliases, Maps, Sets and sparse arrays without exporting material',async()=>{
  const {subtle,client,service}=fixture();
  const key=await subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
  const value={key,again:key,map:new Map([[key,new Set([key])]]),sparse:new Array(5)};value.self=value;
  const clone=client.decode(structuredClone(client.encode(value)));
  assert.equal(clone.self,clone);assert.equal(clone.key,clone.again);assert.notEqual(clone.key,key);
  assert.equal([...clone.map.keys()][0],clone.key);assert.equal([...clone.map.values()][0].has(clone.key),true);
  assert.equal(clone.sparse.length,5);assert.equal(0 in clone.sparse,false);
  const caused=client.decode(structuredClone(client.encode({key,error:new Error('key cause',{cause:{key}})})));
  assert.ok(caused.error instanceof Error);assert.equal(caused.error.cause.key,caused.key);
  assert.equal(Object.getOwnPropertyDescriptor(caused.error,'cause').enumerable,false);
  const encoded=client.encode(key),native=service.decode(encoded);
  assert.ok(native instanceof CryptoKey);assert.equal(native.extractable,false);
  assert.ok(!('d' in encoded)&&!('k' in encoded));
  await assert.rejects(service.call('constructor',[]),{name:'NotSupportedError'});
  assert.throws(()=>new client.CryptoKey(),TypeError);
  const ordinary={__proto__:null,value:new Uint8Array([1,2])};
  assert.deepEqual(transform_keys(ordinary,value=>value).value,new Uint8Array([1,2]));
});

test('Key transport lets native cloning reject proxies and preserve authored data and getter ordering',async()=>{
  const {client}=fixture();
  const proxy=new Proxy({},{ownKeys(){throw new Error('Proxy must never be inspected');}});
  assert.throws(()=>structuredClone(client.encode(proxy)),{name:'DataCloneError'});
  const buffer=new ArrayBuffer(8);
  assert.throws(()=>structuredClone(client.encode({proxy,buffer}),{transfer:[buffer]}),{name:'DataCloneError'});
  assert.equal(buffer.byteLength,8);
  const value={__sandstone_crypto_key_v1__:'ordinary marker',saved:true};
  Object.defineProperty(value,Symbol.toStringTag,{get(){throw new Error('Symbol tags are not cloned');}});
  assert.deepEqual(client.decode(structuredClone(client.encode(value))),{__sandstone_crypto_key_v1__:'ordinary marker',saved:true});
  const order=[],source={};
  Object.defineProperties(source,{first:{enumerable:true,get(){order.push('first');delete source.second;return 1;}},second:{value:2,enumerable:true,configurable:true}});
  assert.deepEqual(client.decode(structuredClone(client.encode(source))),{first:1});
  assert.deepEqual(order,['first']);
});

test('Key handles restore RSA public exponent metadata and preserve native export restrictions',async()=>{
  const {subtle,client}=fixture();
  const pair=await subtle.generateKey({name:'RSA-PSS',modulusLength:1024,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['sign','verify']);
  const copy=client.decode(structuredClone(client.encode(pair)));
  assert.ok(copy.publicKey.algorithm.publicExponent instanceof Uint8Array);
  assert.deepEqual(copy.publicKey.algorithm.publicExponent,new Uint8Array([1,0,1]));
  const signature=await subtle.sign({name:'RSA-PSS',saltLength:32},copy.privateKey,bytes('rsa handle'));
  assert.equal(await subtle.verify({name:'RSA-PSS',saltLength:32},copy.publicKey,signature,bytes('rsa handle')),true);
  await assert.rejects(subtle.exportKey('pkcs8',copy.privateKey),error=>/^InvalidAccess/.test(error.name));
});

test('Modern native key encapsulation and public key derivation are forwarded when available',async()=>{
  const {subtle}=fixture();
  const pair=await subtle.generateKey('ML-KEM-768',false,['encapsulateBits','decapsulateBits','encapsulateKey','decapsulateKey']);
  const publicKey=await subtle.getPublicKey(pair.privateKey,['encapsulateBits','encapsulateKey']);
  const bits=await subtle.encapsulateBits('ML-KEM-768',publicKey);
  assert.equal(hex(await subtle.decapsulateBits('ML-KEM-768',pair.privateKey,bits.ciphertext)),hex(bits.sharedKey));
  const result=await subtle.encapsulateKey('ML-KEM-768',publicKey,'AES-GCM',true,['encrypt']);
  const restored=await subtle.decapsulateKey('ML-KEM-768',pair.privateKey,result.ciphertext,'AES-GCM',true,['decrypt']);
  assert.equal(hex(await subtle.exportKey('raw',restored)),hex(await subtle.exportKey('raw',result.sharedKey)));
  const older=create_crypto_client(()=>{}, {methods:['digest']});
  assert.equal(typeof older.subtle.digest,'function');assert.equal(older.subtle.encapsulateBits,undefined);
});
