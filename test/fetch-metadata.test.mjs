import test from 'node:test';
import assert from 'node:assert/strict';
import {metadata_url,metadata_site,set_fetch_metadata} from '../src/host/fetch_metadata.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {serialize_request} from '../src/frame/polyfill/request.mjs';

const metadata=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>name.startsWith('sec-fetch-')));
const profile=(site,mode='cors',destination='empty',user=false)=>({'sec-fetch-dest':destination,'sec-fetch-mode':mode,'sec-fetch-site':site,...(user?{'sec-fetch-user':'?1'}:{})});

test('Fetch Metadata replaces forged fields with the virtual request origin, mode and destination',async()=>{
  const headers={'Sec-Fetch-Site':'none','Sec-Fetch-Mode':'navigate','Sec-Fetch-User':'?1','Sec-Fetch-Dest':'document','Sec-Fetch-Unknown':'forged'};
  let actual;
  await fetch_with_cookies(async(url,init)=>{actual=init.headers;return new Response('ok');},new SiteDataStore(),'https://site.test/api',{mode:'cors',headers},{url:'https://site.test/page'});
  assert.deepEqual(metadata(actual),profile('same-origin'));
  assert.equal(headers['Sec-Fetch-Site'],'none','The caller header object was mutated');
  const request=await serialize_request('/api',{destination:'document'},'https://site.test/page');
  assert.equal(request.options.destination,undefined,'Author Fetch options selected a resource destination');
});

test('Fetch Metadata only reaches HTTPS and loopback HTTP endpoints, including after unsafe redirects',async()=>{
  for(const value of ['https://site.test/','http://127.1/','http://127.255.0.2/','http://[::1]/','http://localhost/','http://a.localhost/','http://localhost./'])assert.equal(metadata_url(new URL(value)),true,value);
  for(const value of ['http://site.test/','http://127.evil.test/','http://localhost.evil.test/','http://192.168.1.1/','file:///page.html','data:text/plain,hi','ws://localhost/'])assert.equal(metadata_url(new URL(value)),false,value);
  const seen=[];
  await fetch_with_cookies(async(url,init)=>{
    seen.push({url,headers:init.headers});
    return seen.length===1?new Response(null,{status:302,headers:{Location:'http://other.test/intermediate'}}):seen.length===2?new Response(null,{status:302,headers:{Location:'https://site.test/final'}}):new Response('ok');
  },new SiteDataStore(),'https://site.test/start',{mode:'cors',headers:{'Sec-Fetch-User':'?1'}},{url:'https://site.test/page'});
  assert.deepEqual(seen.map(value=>metadata(value.headers)),[profile('same-origin'),{},profile('cross-site')]);
});

test('Redirect metadata retains schemeful same-site and cross-site hops when returning to the source',async()=>{
  const source=new URL('https://a.example.test/');
  let site='same-origin';
  const urls=['https://a.example.test/','https://b.example.test/','https://a.example.test/','https://other.test/','https://a.example.test/'];
  assert.deepEqual(urls.map(url=>site=metadata_site(site,source,new URL(url))),['same-origin','same-site','same-site','cross-site','cross-site']);
  assert.equal(metadata_site('same-origin',source,new URL('http://a.example.test/')),'cross-site');
  assert.equal(metadata_site('same-origin',source,source,true),'cross-site');
  assert.equal(metadata_site('none',source,new URL('https://other.test/')),'none');
});

test('Navigation metadata distinguishes direct UI requests, document/iframe destinations and actual activation',async()=>{
  const seen=[],transport=async(url,init)=>{seen.push(metadata(init.headers));return new Response('ok');},store=new SiteDataStore();
  await fetch_with_cookies(transport,store,'https://site.test/page',{}, {navigation:true,user_activation:true});
  await fetch_with_cookies(transport,store,'https://site.test/page',{}, {url:'https://site.test/source',navigation:true});
  await fetch_with_cookies(transport,store,'https://site.test/page',{}, {url:'https://site.test/source',navigation:true,nested:true,user_activation:true});
  await fetch_with_cookies(transport,store,'https://site.test/page',{mode:'cors'}, {url:'https://site.test/source',user_activation:true});
  await fetch_with_cookies(transport,store,'https://site.test/page',{}, {navigation:true,metadata_source:'https://site.test/page',user_activation:true});
  assert.deepEqual(seen,[profile('none','navigate','document',true),profile('same-origin','navigate','document'),profile('same-origin','navigate','iframe',true),profile('same-origin'),profile('same-origin','navigate','document',true)]);
});

test('Opaque clients are cross-site while cross-site ancestors do not change a nonopaque request origin',async()=>{
  const seen=[],transport=async(url,init)=>{seen.push(metadata(init.headers));return new Response('ok');},store=new SiteDataStore();
  await fetch_with_cookies(transport,store,'https://site.test/api',{mode:'cors'}, {url:'https://site.test/page',broadcast_origin:'opaque:document'});
  await fetch_with_cookies(transport,store,'https://site.test/api',{mode:'cors'}, {url:'https://site.test/page',top_url:'https://site.test/',cross_site:true});
  assert.deepEqual(seen,[profile('cross-site'),profile('same-origin')]);
  const headers=new Headers({'Sec-Fetch-User':'?1'});
  set_fetch_metadata(headers,new URL('https://site.test/image'),{site:'same-origin',mode:'no-cors',destination:'image',user:true});
  assert.deepEqual(metadata(Object.fromEntries(headers)),profile('same-origin','no-cors','image'));
});

test('History requests retain their saved site and activation without exposing the source document path',async()=>{
  const store=new SiteDataStore(),seen=[],transport=async(url,init)=>{seen.push(metadata(init.headers));return new Response('ok');};
  const first=await fetch_with_cookies(transport,store,'https://b.example.test/page',{},
    {url:'https://user:secret@a.example.test/private?token=hidden',navigation:true,user_activation:false});
  assert.deepEqual(first.request_metadata,{source:'https://a.example.test/',site:'same-site',user:false,opaque:false});
  await fetch_with_cookies(transport,store,'https://b.example.test/page',{},
    {navigation:true,user_activation:true,request_metadata:first.request_metadata});
  assert.deepEqual(seen,[profile('same-site','navigate','document'),profile('same-site','navigate','document')]);
});
