import test from 'node:test';
import assert from 'node:assert/strict';
import {BroadcastService} from '../src/broadcast/service.mjs';

function fixture(){
  const contexts=new Map(),service=new BroadcastService({contexts:()=>contexts,Channel:null});
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
