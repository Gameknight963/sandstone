import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerRequests} from '../src/service_worker/requests.mjs';
import {create_request_class} from '../src/frame/request.mjs';
import {remember_request} from '../src/request_metadata.mjs';
import {serialize_request} from '../src/frame/polyfill/request.mjs';

test('Worker request snapshots retain source policy but are bound to their owner and original URL',()=>{
  const requests=new ServiceWorkerRequests(),context={url:'https://source.test/form',top_url:'https://top.test/',navigation:true,cross_site:true,user_activation:true};
  const token=requests.issue('owner','https://app.test/post',context);context.url='https://forged.test/';
  const stored=requests.restore('owner',token,'https://app.test/post');assert.equal(stored.url,'https://source.test/');assert.equal(stored.cross_site,true);assert.equal(stored.user_activation,false);assert.equal(Object.isFrozen(stored),true);
  assert.throws(()=>requests.restore('other',token,'https://app.test/post'),{name:'SecurityError'});
  assert.throws(()=>requests.restore('owner',token,'https://app.test/different'),{name:'SecurityError'});
  requests.disconnect('owner');assert.throws(()=>requests.restore('owner',token,'https://app.test/post'),{name:'SecurityError'});
});
test('Snapshot storage stays bounded and does not retain a terminated worker owner',()=>{
  let next=0;const requests=new ServiceWorkerRequests({limit:2,id:()=>String(++next)});
  const first=requests.issue('one','https://app.test/',{});requests.issue('two','https://app.test/',{});requests.issue('one','https://app.test/',{});
  assert.equal(requests.records.size,2);assert.throws(()=>requests.restore('one',first,'https://app.test/'),{name:'SecurityError'});requests.disconnect('one');assert.equal(requests.records.size,1);
});
test('Request copies preserve their trusted context and mode while Fetch clears the resource destination',async()=>{
  const Request=create_request_class(()=> 'https://app.test/worker.js',()=> 'https://app.test/');
  const input=remember_request(new Request('/post',{method:'POST',body:'value',mode:'same-origin',redirect:'manual'}),{mode:'navigate',destination:'document',context:'opaque-token',referrer:'https://source.test/'});
  assert.equal(input.clone().destination,'document');const copy=new Request(input);assert.equal(copy.destination,'');assert.equal(copy.mode,'navigate');
  const data=await serialize_request(copy,{},'https://app.test/worker.js','https://app.test/');
  assert.equal(data.options.mode,'navigate');assert.equal(data.options.destination,'');assert.equal(data.options.sandstone_request_context,'opaque-token');assert.equal(data.options.referrer,'https://source.test/');
  const authored=await serialize_request('/post',{sandstone_request_context:'forged'},'https://app.test/worker.js','https://app.test/');assert.equal(authored.options.sandstone_request_context,undefined);
});
