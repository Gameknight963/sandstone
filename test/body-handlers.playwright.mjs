import assert from 'node:assert/strict';

export async function verifyBodyHandlers(page){
  const origin='https://body-handlers.test';
  const setup='<script>window.bodyEvents=[];window.addEventListener("load",()=>bodyEvents.push("head"));function boot(event){bodyEvents.push({thisWindow:this===window,target:event.target===document,type:event.type,host:location.hostname})}</script>';
  const fixtures={
    '/body':'<!doctype html>'+setup+'<body onload="boot.call(this,event)"><script>window.addEventListener("load",()=>bodyEvents.push("tail"))</script>',
    '/frameset':'<!doctype html>'+setup+'<frameset onload="boot.call(this,event)"></frameset>',
    '/override':'<!doctype html>'+setup+'<body onload="bodyEvents.push(\'attribute\')"><script>window.onload=()=>bodyEvents.push("property")</script>',
    '/start':'<!doctype html><body>Body adoption'
  };
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:fixtures[new URL(route.request().url()).pathname]}));
  await page.evaluate(({origin,fixtures})=>{
    const fetch=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,...args)=>new URL(url).origin===origin?Promise.resolve(new Response(fixtures[new URL(url).pathname],{headers:{'Content-Type':'text/html'}})):fetch.call(sandstone.network.session,url,...args);
  },{origin,fixtures});
  const read=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const navigate=async(proxy,path)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+path);
    else await native.goto(origin+path);
  };
  const results=[];
  try{
    for(const path of ['/body','/frameset','/override']){
      const outcomes=[];
      for(const proxy of [false,true]){
        await navigate(proxy,path);
        outcomes.push(JSON.parse(await read(proxy,'JSON.stringify(bodyEvents)')));
      }
      assert.ok(outcomes[0].length>=2,'Native body load fixture did not run');
      assert.deepEqual(outcomes[1],outcomes[0],path+' window handler order and forwarding');
      results.push('Initial '+path.slice(1)+' load handlers retain virtual globals and native ordering');
    }
    const adoption=`(()=>{
      const seen=[];window.adoptedBodyEvents=seen;
      const inert=new DOMParser().parseFromString('<body onmessage="adoptedBodyEvents.push([this===window,event.data,location.hostname])">','text/html');
      const body=document.adoptNode(inert.body);
      window.dispatchEvent(new MessageEvent('message',{data:'adopted'}));
      body.onmessage=event=>seen.push(['property',event.data]);
      document.body.append(body);window.dispatchEvent(new MessageEvent('message',{data:'inserted'}));
      body.remove();window.onmessage=null;
      return JSON.stringify(seen);
    })()`;
    const outcomes=[];
    for(const proxy of [false,true]){await navigate(proxy,'/start');outcomes.push(JSON.parse(await read(proxy,adoption)));}
    assert.deepEqual(outcomes[1],outcomes[0],'Adopted body event handlers and property overrides');
    results.push('Adopted body window handlers preserve attribute activation and property overrides');
    return results;
  }finally{await native.close();}
}
