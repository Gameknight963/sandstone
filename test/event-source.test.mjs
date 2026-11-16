import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStreamParser, create_event_source_class} from '../src/frame/event_source.mjs';

const encode=value=>new TextEncoder().encode(value);
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

test('Event streams parse split UTF-8, BOM, CRLF, multiline data and named events',()=>{
  const events=[],ids=[],retries=[];
  const parser=new EventStreamParser({event:value=>events.push(value),id:value=>ids.push(value),retry:value=>retries.push(value)});
  const input='\ufeff: heartbeat\r\nid: 漢字\r\nevent: update\r\ndata: first €\r\ndata:  second\r\n\r\nretry: 17\nretry: nope\nretry: -2\ndata\n\nevent: ignored\n\ndata: final\n\ndata: incomplete';
  for(const byte of encode(input))parser.push(new Uint8Array([byte]));
  parser.finish();
  assert.deepEqual(events,[{type:'update',data:'first €\n second',lastEventId:'漢字'},
    {type:'message',data:'',lastEventId:'漢字'},{type:'message',data:'final',lastEventId:'漢字'}]);
  assert.deepEqual(retries,[17]);assert.equal(ids.at(-1),'漢字');
});

test('Event IDs commit on blank lines, reject NUL and allow explicit resets',()=>{
  const events=[],ids=[];
  const parser=new EventStreamParser({event:value=>events.push(value),id:value=>ids.push(value)});
  parser.push(encode('id: kept\n\nid: ignored\0value\ndata: one\n\nid\ndata: two\n\nid: unfinished\n'));
  parser.finish();
  assert.deepEqual(events.map(event=>event.lastEventId),['kept','']);
  assert.deepEqual(ids,['kept','kept','']);
  const reconnected=new EventStreamParser({event:value=>events.push(value),lastEventId:'previous'});
  reconnected.push(encode('data: resumed\n\n'));reconnected.finish();
  assert.equal(events.at(-1).lastEventId,'previous');
});

test('EventSource reconnects with Last-Event-ID and keeps dispatch ordered',async()=>{
  const requests=[],events=[];
  const ES=create_event_source_class({base:()=> 'https://page.test/base/',defaultRetry:1,
    async fetch(url,options){
      requests.push({url,options});
      const response=new Response(requests.length===1?'retry: 1\nid: first\nevent: update\ndata: one\n\n':'id:\ndata: two\n\n',{headers:{'Content-Type':'text/event-stream;charset=wrong'}});
      Object.defineProperty(response,'url',{value:'https://stream.test/final'});return response;
    }});
  const source=new ES('events#fragment',{withCredentials:true});
  assert.equal(source.readyState,ES.CONNECTING);assert.equal(source.url,'https://page.test/base/events#fragment');
  source.onopen=function(){assert.equal(this,source);events.push(['open',source.readyState]);};
  source.addEventListener('update',event=>events.push([event.type,event.data,event.lastEventId,event.origin]));
  source.onerror=()=>events.push(['error',source.readyState]);
  await new Promise(resolve=>source.onmessage=event=>{events.push([event.type,event.data,event.lastEventId,event.origin]);source.close();resolve();});
  assert.deepEqual(events,[['open',1],['update','one','first','https://stream.test'],['error',0],['open',1],['message','two','','https://stream.test']]);
  assert.equal(requests.length,2);assert.equal(requests[0].url,'https://page.test/base/events');
  assert.equal(requests[1].options.headers['Last-Event-ID'],'first');
  assert.equal(requests[0].options.credentials,'include');assert.equal(requests[0].options.headers.Accept,'text/event-stream');
  assert.equal(source.readyState,2);assert.equal(Object.prototype.toString.call(source),'[object EventSource]');
});

test('EventSource stops on invalid responses and close cancels a live body',async()=>{
  for(const response of [new Response(null,{status:204}),new Response('wrong',{headers:{'Content-Type':'text/plain'}})]){
    let count=0;
    const ES=create_event_source_class({base:()=> 'https://page.test/',defaultRetry:1,fetch:async()=>{count++;return response;}});
    const source=new ES('/events');
    await new Promise(resolve=>source.onerror=resolve);
    assert.equal(source.readyState,2);await delay(5);assert.equal(count,1);
  }
  let cancelled=false;
  const ES=create_event_source_class({base:()=> 'https://page.test/',fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}})});
  const source=new ES('/events');await new Promise(resolve=>source.onopen=resolve);source.close();await delay(1);
  assert.equal(cancelled,true);assert.equal(source.readyState,2);
});

test('EventSource retries network errors and close suppresses queued events',async()=>{
  let count=0;
  const ES=create_event_source_class({base:()=> 'https://page.test/',defaultRetry:1,
    async fetch(){if(++count===1)throw new Error('offline');return new Response('data: one\n\ndata: two\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
  const source=new ES('/events'),events=[];
  source.onerror=()=>events.push('error');source.onopen=()=>events.push('open');
  await new Promise(resolve=>source.onmessage=event=>{events.push(event.data);source.close();resolve();});await delay(5);
  assert.deepEqual(events,['error','open','one']);assert.equal(count,2);
  assert.throws(()=>new ES(),TypeError);assert.throws(()=>new ES('http://['),{name:'SyntaxError'});
});
