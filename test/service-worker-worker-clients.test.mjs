import test from 'node:test';
import assert from 'node:assert/strict';
import {create_worker_clients} from '../src/service_worker/worker_clients.mjs';

test('Worker client lookups and messages create immutable snapshots of each native client',async()=>{
  const info={id:'document',url:'https://app.test/start',type:'window',frameType:'nested',visibilityState:'visible',focused:false};
  const api=create_worker_clients({base:'https://app.test/workers/sw.js',command:async(method)=>method==='clients.matchAll'?[info]:info});
  const first=await api.clients.get('document'),second=await api.clients.get('document'),source=api.source(info);
  assert.notEqual(first,second);assert.notEqual(source,first);assert.equal(first.id,second.id);assert.ok(first instanceof api.WindowClient);
  info.focused=true;info.url='https://app.test/next';const next=(await api.clients.matchAll())[0];
  assert.equal(first.focused,false);assert.equal(first.url,'https://app.test/start');assert.equal(next.focused,true);assert.equal(next.url,info.url);
});

test('WindowClient navigation resolves relative to the worker script and returns a new client or null',async()=>{
  const calls=[],initial={id:'old',url:'https://app.test/page',type:'window',focused:false};
  const api=create_worker_clients({base:'https://app.test/workers/sw.js',command:async(method,args)=>{calls.push({method,args});return args[1].includes('foreign')?null:{...initial,id:'new',url:args[1]};}}),client=api.source(initial);
  const next=await client.navigate('../next');assert.equal(next.url,'https://app.test/next');assert.notEqual(next,client);assert.equal(client.url,initial.url);
  assert.deepEqual(calls[0],{method:'client.navigate',args:['old','https://app.test/next']});assert.equal(await client.navigate('https://foreign.test/'),null);
  await assert.rejects(client.navigate(),TypeError);await assert.rejects(client.navigate('about:blank'),TypeError);await assert.rejects(client.navigate('http://['),TypeError);
  await assert.rejects(api.WindowClient.prototype.navigate.call({},'/'),TypeError);
});
