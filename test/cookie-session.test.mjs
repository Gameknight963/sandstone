import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {CookieSession} from '../src/host/cookie_session.mjs';
import {MemoryLockManager} from '../src/locks/manager.mjs';

function fixture(){
  const channels=new Set(),locks=new MemoryLockManager();
  class Channel {
    constructor(){channels.add(this);}
    postMessage(value){for(const peer of channels)if(peer!==this)queueMicrotask(()=>{if(channels.has(peer)&&!peer.paused)peer.onmessage?.({data:structuredClone(value)});});}
    close(){channels.delete(this);}
  }
  const owners=[];
  function open(values=[]){
    const received=[];
    const owner=new CookieSession({Channel,locks,snapshot:()=>values,receive:entries=>received.push(entries)});
    owners.push(owner);return {owner,received,values};
  }
  return {open,locks,close(){for(const owner of owners)owner.close();}};
}

test('Cookie session startup receives existing hosts before readiness and forwards later changes',async()=>{
  const f=fixture();try{
    const first=f.open(['existing']);await first.owner.ready;
    const second=f.open();await second.owner.ready;
    assert.deepEqual(second.received,[['existing']]);
    first.values.push('new');first.owner.changed();await setImmediate();
    assert.deepEqual(second.received,[['existing'],['existing','new']]);
    first.owner.changed();await setImmediate();assert.equal(second.received.length,2);
  }finally{f.close();}
});

test('Cookie session startup waits for a live peer and settles if that peer closes',async()=>{
  const f=fixture();try{
    const first=f.open(['saved']);await first.owner.ready;first.owner.channel.paused=true;
    const second=f.open();let ready=false;second.owner.ready.then(()=>ready=true);
    await setImmediate();assert.equal(ready,false);
    first.owner.close();await second.owner.ready;assert.equal(ready,true);
  }finally{f.close();}
});

test('Closing a joining host cancels its waits without releasing other host ownership',async()=>{
  const f=fixture();try{
    const first=f.open();await first.owner.ready;first.owner.channel.paused=true;
    const second=f.open();await setImmediate();second.owner.close();await second.owner.ready;await setImmediate();
    const snapshot=await f.locks.query();
    assert.equal(snapshot.held.length,1);assert.ok(snapshot.held[0].name.endsWith(first.owner.id));assert.deepEqual(snapshot.pending,[]);
  }finally{f.close();}
});
