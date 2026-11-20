import assert from 'node:assert/strict';

export async function verifyServiceWorkerClients(page){
  const fixture=await page.context().newPage(),origin='https://bound-worker.test',direct=[],errors=[];
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const first=await fixture.evaluate(async origin=>{
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      const html='<!doctype html><body><script>globalThis.bindingValue=fetch("/controlled").then(response=>response.text());</script>';
      const source=`onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{if(new URL(event.request.url).pathname==='/controlled')event.respondWith(new Response(event.clientId));};`;
      sandstone.network.session.fetch=async url=>new Response(new URL(url).pathname==='/worker.js'?source:new URL(url).pathname==='/controlled'?'network':html,{headers:{'content-type':new URL(url).pathname==='/worker.js'?'text/javascript':new URL(url).pathname==='/controlled'?'text/plain':'text/html','cache-control':'no-store'}});
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/first');
      const manager=sandstone.service_workers.manager;globalThis.bindingFirst=main_frame.document_context;
      const uncontrolled=await main_frame.eval_js('bindingValue');
      globalThis.bindingRecord=await manager.register(origin+'/worker.js',{}, {base:origin+'/first',origin});await manager.settled(bindingRecord);
      return {uncontrolled,bound:manager.clients.has(bindingFirst),claimed:manager.clients.get(bindingFirst)?.controller===bindingRecord.active,fetch:await main_frame.eval_js('fetch("/controlled").then(response=>response.text())'),token:bindingFirst};
    },origin);
    assert.deepEqual(first,{uncontrolled:'network',bound:true,claimed:true,fetch:first.token,token:first.token});
    const next=await fixture.evaluate(async origin=>{
      await main_frame.navigate_to(origin+'/next');
      const manager=sandstone.service_workers.manager;
      return {value:await main_frame.eval_js('bindingValue'),token:main_frame.document_context,old:manager.clients.has(bindingFirst),controlled:manager.clients.get(main_frame.document_context)?.controller===bindingRecord.active};
    },origin);
    assert.deepEqual(next,{value:next.token,token:next.token,old:false,controlled:true});assert.notEqual(next.token,first.token);
    for(const type of ['http','blank','srcdoc','opaque']){
      await fixture.evaluate(type=>main_frame.eval_js(`(async()=>{
        document.querySelector('iframe')?.remove();
        const frame=document.createElement('iframe');const loaded=new Promise(resolve=>frame.onload=resolve);
        if(${JSON.stringify(type)}==='http')frame.src='/child';
        else if(${JSON.stringify(type)}==='srcdoc'||${JSON.stringify(type)}==='opaque'){
          if(${JSON.stringify(type)}==='opaque')frame.sandbox='allow-scripts';
          frame.srcdoc='<body>Inherited frame';
        }
        document.body.append(frame);await loaded;
      })()`),type);
      await fixture.waitForFunction(()=>Object.values(sandstone.controller.iframes).some(frame=>frame.parent_id===main_frame.id&&!frame.worker));
      const child=await fixture.evaluate(()=>{
        const frame=Object.values(sandstone.controller.iframes).find(frame=>frame.parent_id===main_frame.id&&!frame.worker);
        const client=sandstone.service_workers.manager.clients.get(frame.document_context);
        return {id:frame.id,token:frame.document_context,bound:!!client,controlled:client?.controller===bindingRecord.active};
      });
      if(type==='opaque'){assert.equal(child.bound,false);continue;}
      assert.equal(child.controlled,true,type);
      const value=await fixture.evaluate(()=>main_frame.eval_js('document.querySelector("iframe").contentWindow.fetch("/controlled").then(response=>response.text())'));
      assert.equal(value,child.token,type);
    }
    await fixture.evaluate(()=>main_frame.eval_js('document.querySelector("iframe").remove()'));
    await fixture.waitForFunction(()=>![...sandstone.service_workers.manager.clients.values()].some(client=>client.frame!==main_frame.id&&new URL(client.creationURL).origin==='https://bound-worker.test'));
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Documents bind before authored fetches and activation claims existing clients automatically','Replacement documents select active workers and retire old document tokens','HTTP child documents and inherited blank/srcdoc frames retain controllers; opaque children stay uncontrolled','Removing child frames retires their service-worker clients'];
  }finally{
    await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});await fixture.close();
  }
}
