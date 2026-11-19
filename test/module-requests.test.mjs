import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {ModuleLoader} from '../src/frame/modules.mjs';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';

test('Worker static graphs retain their destination while dynamic imports start script graphs without changing module identity',async()=>{
  const seen=[],sources={
    root:'import "./static";export{};',static:'export{};',
    dynamic:'import "./dynamic-child";export{};','dynamic-child':'export{};'
  };
  const loader=new ModuleLoader({
    context:()=>({destination:'worker'}),
    fetch:async(url,options)=>{seen.push([new URL(url).pathname,options.destination]);return new Response(sources[new URL(url).pathname.slice(1)],{headers:{'Content-Type':'text/javascript'}});},
    rewrite:(source,options)=>rewrite_source(source,[],options),createURL:(_,__,url)=>'blob:'+url,register(){},execute:async()=>({})
  });
  const root=await loader.prepare_url('./root','https://site.test/');
  await loader.import('./dynamic',{key:root.key});
  assert.deepEqual(seen,[['/root','worker'],['/static','worker'],['/dynamic','script'],['/dynamic-child','script']]);
  await loader.import('./static',{key:root.key});assert.equal(seen.length,4);
});

test('Module graph fetching retains declared types independently of names and request context',async()=>{
  const requests=[];
  const loader=new ModuleLoader({fetch:async(url,options,type)=>{
    requests.push([url,type]);
    return new Response(type==='json'?'{"value":42}':type==='css'?'body{color:red}':'import data from "./data" with {type:"json"};import sheet from "./sheet" with {type:"css"};export {data,sheet};',{
      headers:{'Content-Type':type==='json'?'application/json':type==='css'?'text/css':'text/javascript'}
    });
  },rewrite:(source,options)=>rewrite_source(source,[],options),createURL:(_,__,url)=>'blob:'+url,register(){},execute(){throw new Error('Preparation executed code')}});
  await loader.prepare_url('./entry','https://site.test/');
  assert.deepEqual(requests,[['https://site.test/entry','javascript'],['https://site.test/data','json'],['https://site.test/sheet','css']]);
});

test('JSON and CSS module defaults preserve explicit Accept values and CORS Origin across redirects',async()=>{
  for(const [destination,defaultAccept] of [['json','application/json,*/*;q=0.5'],['style','text/css,*/*;q=0.1']]){
    for(const accept of [undefined,'application/vnd.custom+json','']){
      const seen=[];
      const response=await fetch_with_cookies(async(url,options)=>{seen.push({url,...options});return seen.length===1?new Response(null,{status:302,headers:{Location:'/final'}}):new Response('done');},new SiteDataStore(),'https://site.test/start',{
        mode:'cors',destination,referrerPolicy:'no-referrer',...(accept===undefined?{}:{headers:{Accept:accept}})
      },{url:'https://site.test/page'});
      assert.equal(await response.text(),'done');
      for(const request of seen){assert.equal(request.headers.accept,accept??defaultAccept);assert.equal(request.headers.origin,'https://site.test');assert.equal(request.headers.referer,undefined);assert.equal(request.destination,undefined);}
    }
  }
});
