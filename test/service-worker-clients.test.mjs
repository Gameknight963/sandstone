import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerClients} from '../src/service_worker/clients.mjs';

function environment(){
  const frames={},records=[],clients=new Map();let list=async()=>records;
  const manager={clients,list:(...args)=>list(...args),addClient:value=>{const client={...value,controller:null,registration:null};clients.set(client.id,client);return client;},removeClient:id=>clients.delete(id),control:(client,record,worker)=>Object.assign(client,{registration:record,controller:worker})};
  const binder=new ServiceWorkerClients({manager,frames:()=>frames});
  const frame=(id='frame',url='https://app.test/page',token='document')=>frames[id]={id,root_id:id,url:new URL(url),origin:new URL(url).origin,broadcast_origin:new URL(url).origin,document_context:token};
  return {binder,frames,records,clients,manager,frame,set list(value){list=value;}};
}
test('New documents select the longest matching registration before their scripts run',async()=>{
  const api=environment(),frame=api.frame(undefined,'https://app.test/app/page');
  const root={scope:'https://app.test/',active:{id:'root'}},app={scope:'https://app.test/app/',active:{id:'app'}};api.records.push(root,app);
  const client=await api.binder.bind(frame);assert.equal(client.controller,app.active);assert.equal(client.frame,frame.id);assert.equal(client.creationURL,frame.url.href);
  app.active=null;app.installing={};frame.document_context='second';const second=await api.binder.bind(frame);assert.equal(second.controller,null);
});
test('Same-origin blank/srcdoc clients inherit even an unregistered controller while opaque frames stay uncontrolled',async()=>{
  const api=environment(),parent=api.frame(),registration={unregistered:true},worker={id:'inherited'};
  const owner=api.manager.addClient({id:parent.document_context,creationURL:parent.url.href});api.manager.control(owner,registration,worker);
  for(const path of ['blank','srcdoc']){
    const child=api.frame(path,'about:'+path,path);Object.assign(child,{root_id:parent.id,origin:parent.origin,broadcast_origin:parent.origin,parent_context:parent.document_context,request_url:parent.url.href});
    const client=await api.binder.bind(child);assert.equal(client.controller,worker);assert.equal(client.creationURL,parent.url.href);
  }
  const opaque=api.frame('opaque','about:srcdoc','opaque');Object.assign(opaque,{origin:parent.origin,broadcast_origin:'opaque:child',parent_context:parent.document_context});
  assert.equal(await api.binder.bind(opaque),null);assert.equal(api.clients.has('opaque'),false);
});
test('Uncontrolled parents do not select a newly registered worker for inherited clients',async()=>{
  const api=environment(),parent=api.frame();api.manager.addClient({id:parent.document_context,creationURL:parent.url.href});
  api.records.push({scope:'https://app.test/',active:{id:'worker'}});
  const child=api.frame('blank','about:blank','blank');Object.assign(child,{origin:parent.origin,broadcast_origin:parent.origin,parent_context:parent.document_context,request_url:parent.url.href});
  assert.equal((await api.binder.bind(child)).controller,null);
});
test('Superseded and aborted document lookups cannot reinsert or control their old clients',async()=>{
  const api=environment(),frame=api.frame(),controller=new AbortController();let release;
  api.list=()=>new Promise(resolve=>release=resolve);
  const pending=api.binder.bind(frame,controller.signal);assert.equal(api.clients.size,1);controller.abort();assert.equal(api.clients.size,0);
  release([{scope:'https://app.test/',active:{id:'worker'}}]);assert.equal(await pending,null);assert.equal(api.clients.size,0);
  const other=api.binder.bind(frame);api.binder.disconnect(frame.id);frame.document_context='replacement';release([]);assert.equal(await other,null);
});
test('Owner workers and insecure/opaque documents never become clients',async()=>{
  const api=environment();
  for(const changes of [{service_worker_host:true},{origin:'null'},{broadcast_origin:'opaque:test'}]){
    const frame=Object.assign(api.frame(),changes);assert.equal(await api.binder.bind(frame),null);
  }
  assert.equal(await api.binder.bind(api.frame('http','http://insecure.test/page')),null);assert.equal(api.clients.size,0);
  const owner=api.frame('owner');owner.service_worker_host=true;const child=api.frame('child');child.root_id=owner.id;
  assert.equal(await api.binder.bind(child),null);
});

test('HTTP workers select their script scope while blob workers inherit the creator controller',async()=>{
  const api=environment(),parent=api.frame(undefined,'https://app.test/app/page');
  const record={scope:'https://app.test/app/',active:{id:'active'}};api.records.push(record);
  await api.binder.bind(parent);
  for(const [name,url,controlled] of [['scoped','https://app.test/app/worker.js',true],['outside','https://app.test/worker.js',false],['blob','blob:https://app.test/id',true],['opaqueBlob','blob:null/id',true]]){
    const frame=api.frame(name,url,name);Object.assign(frame,{worker:true,origin:parent.origin,broadcast_origin:parent.origin,parent_context:parent.document_context,root_id:parent.id});
    const client=await api.binder.bind(frame);assert.equal(client.type,'worker');assert.equal(client.creationURL,url);assert.equal(client.controller,controlled?record.active:null);
    api.binder.disconnect(frame.id);assert.equal(api.clients.has(name),false);
  }
  const data=api.frame('data','data:text/javascript,','data');data.worker=true;assert.equal(await api.binder.bind(data),null);
});
test('Unavailable registration storage leaves ordinary document clients usable for later claims',async()=>{
  const api=environment(),error=new Error('Storage unavailable');api.list=async()=>{throw error;};
  const client=await api.binder.bind(api.frame());assert.equal(client.controller,null);assert.equal(client.binding_error,error);assert.equal(api.clients.get(client.id),client);
});
