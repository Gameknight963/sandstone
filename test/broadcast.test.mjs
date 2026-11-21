import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {BroadcastService} from '../src/broadcast/service.mjs';

function fixture(options={}){
  const contexts=new Map(),service=new BroadcastService({contexts:()=>contexts,Channel:null,...options});
  const open=(token,origin,top='https://top.test/',name='updates',crossSite=false)=>{
    contexts.set(token,{frame:token,context:{url:origin,top_url:top,cross_site:crossSite,broadcast_origin:origin.startsWith('opaque:')?origin:new URL(origin).origin}});
    const port={received:[],postMessage(value){this.received.push(value);},start(){},close(){this.closed=true;}};
    service.open(token,token,name,port);return port;
  };
  return {contexts,service,open};
}
test('Broadcast channels partition virtual origins, top-level sites, schemes and names',()=>{
  const {open,service}=fixture();
  const sender=open('sender','https://a.test/'),peer=open('peer','https://a.test/path','https://sub.top.test/');
  const ancestorPeer=open('cross-site-ancestor','https://a.test/','https://top.test/','updates',true);
  const excluded=[open('other-origin','https://b.test/'),open('other-top','https://a.test/','https://unrelated.test/'),
    open('other-scheme','https://a.test/','http://top.test/'),open('other-name','https://a.test/','https://top.test/','different'),open('opaque','opaque:unique')];
  const data={bytes:new Uint8Array([1,2]),cycle:null};data.cycle=data;
  service.command('sender','sender','post',data);
  assert.equal(sender.received.length,0);assert.equal(peer.received.length,1);
  assert.equal(ancestorPeer.received.length,1);
  const message=peer.received[0];assert.equal(message.origin,'https://a.test');assert.equal(message.data.cycle,message.data);
  data.bytes.fill(9);assert.deepEqual([...message.data.bytes],[1,2]);
  for(const port of excluded)assert.equal(port.received.length,0);
});

test('Asynchronous key resolution cannot reorder a sender\'s later messages',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {open,service}=fixture({decode:value=>value===1?held.then(()=>value):value});
  open('sender','https://a.test/');const peer=open('peer','https://a.test/');
  const first=service.command('sender','sender','post',1),second=service.command('sender','sender','post',2);
  assert.equal(peer.received.length,0);release();await Promise.all([first,second]);assert.deepEqual(peer.received.map(value=>value.data),[1,2]);
});

test('Asynchronous key publication preserves receiver order and drops replies after channel closure',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {open,service}=fixture({encode:value=>value===1?held.then(()=>value):value});
  open('sender','https://a.test/');const peer=open('peer','https://a.test/'),closed=open('closed','https://a.test/');
  service.command('sender','sender','post',1);service.command('sender','sender','post',2);
  assert.equal(peer.received.length,0);service.command('closed','closed','close');release();await setImmediate();
  assert.deepEqual(peer.received.map(value=>value.data),[1,2]);assert.equal(closed.received.length,0);
});

test('Failed asynchronous codecs report messageerror and allow subsequent messages to finish',async()=>{
  const {open,service}=fixture({decode:value=>value==='invalid'?Promise.reject(new Error('key missing')):value});
  const sender=open('sender','https://a.test/'),peer=open('peer','https://a.test/');
  await Promise.all([service.command('sender','sender','post','invalid'),service.command('sender','sender','post','valid')]);
  assert.deepEqual(sender.received.map(value=>value.type),['messageerror']);assert.deepEqual(peer.received.map(value=>value.data),['valid']);
});
test('Broadcast document retirement closes ports and prevents new or late subscriptions',()=>{
  const {open,contexts,service}=fixture();
  const sender=open('sender','https://a.test/'),peer=open('peer','https://a.test/');
  service.command('sender','sender','close');assert.equal(sender.closed,true);assert.equal(service.channels.size,1);
  contexts.get('peer').retired=true;
  service.command('peer','peer','post','late');assert.equal(peer.closed,true);assert.equal(service.channels.size,0);
  assert.throws(()=>service.open('peer','peer','updates',{}),{name:'InvalidStateError'});
  assert.throws(()=>service.open('unknown','unknown','updates',{}),{name:'InvalidStateError'});
  const active=open('active','https://a.test/');service.disconnect('active');assert.equal(active.closed,true);assert.equal(service.channels.size,0);
});
