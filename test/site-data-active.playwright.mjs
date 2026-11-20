import assert from 'node:assert/strict';

export async function verifyActiveSiteClearing(page){
  const fixture=await page.context().newPage(),errors=[];fixture.on('pageerror',error=>errors.push(error.message));
  const origin='https://active-clear.test',embedded='https://embedded-clear.test';
  let next=0;
  const read=source=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),source).then(JSON.parse);
  const command=async value=>{
    const deadline=Date.now()+5000;
    while(!await read('globalThis.embeddedReady===true')){if(Date.now()>deadline)throw new Error('Embedded clear document not ready');await new Promise(resolve=>setTimeout(resolve,20));}
    const request={...value,id:++next};
    const {id,...reply}=await read('new Promise((resolve,reject)=>{const receive=event=>{if(event.data?.clearReply&&event.data.id==='+request.id+'){clearTimeout(timer);removeEventListener("message",receive);resolve(event.data);}},timer=setTimeout(()=>{removeEventListener("message",receive);reject(new Error("Embedded clear reply timed out"));},5000);addEventListener("message",receive);document.querySelector("iframe").contentWindow.postMessage('+JSON.stringify(request)+',"*");})');
    return reply;
  };
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(({origin,embedded})=>{
      const child='<!doctype html><script>onmessage=event=>{const {key,value,id}=event.data;if(key)localStorage.setItem(key,value);parent.postMessage({clearReply:true,id,keys:Object.keys(localStorage).sort()},"*");};parent.postMessage({embeddedReady:true},"*");<\/script><body>Embedded storage';
      const root='<!doctype html><script>onmessage=event=>{if(event.data?.embeddedReady)globalThis.embeddedReady=true;};<\/script><iframe src="'+embedded+'/child"></iframe>';
      main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>new Response(new URL(url).origin===origin?root:child,{headers:{'content-type':'text/html','cache-control':'no-store'}});
    },{origin,embedded});
    await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
    await fixture.waitForFunction(host=>Object.values(sandstone.controller.iframes).some(frame=>frame.url?.hostname===host&&frame.document_context),new URL(embedded).hostname);
    assert.deepEqual(await command({key:'saved',value:'before'}),{clearReply:true,keys:['saved']});
    await fixture.evaluate(()=>{
      const target=main_frame.rpc_target,deliver=target.onmessage;
      target.onmessage=(event,rpc)=>{if(event.data?.procedure==='local_storage'&&event.data.arguments?.[2]?.key==='delayed'){globalThis.heldClearWrite={event:{data:event.data,currentTarget:event.currentTarget||event.target},rpc,deliver};return;}return deliver(event,rpc);};
    });
    await command({key:'delayed',value:'stale'});await fixture.waitForFunction(()=>!!globalThis.heldClearWrite);
    const previous=await fixture.evaluate(()=>main_frame.document_context);
    await fixture.getByRole('button',{name:'Options',exact:true}).click();await fixture.locator('#site_data_details').evaluate(element=>element.open=true);
    const row=fixture.locator('.site_data_row').filter({hasText:/^embedded-clear\.test:/});
    await row.getByRole('button',{name:'Clear local storage',exact:true}).click();
    await fixture.waitForFunction(previous=>main_frame.document_context!==previous&&!main_frame.is_navigating,previous,{timeout:5000});
    assert.deepEqual(await command({}),{clearReply:true,keys:[]});
    assert.equal(await fixture.evaluate(()=>{try{main_frame.rpc_policy.authorize(heldClearWrite.event.data,heldClearWrite.event.currentTarget);return 'accepted';}catch(error){return error.name;}}),'SecurityError');
    await fixture.evaluate(async()=>{const held=globalThis.heldClearWrite;await held.deliver(held.event,held.rpc);});
    assert.deepEqual(await fixture.evaluate(origin=>sandstone.controller.site_data.local[origin]||[],embedded),[]);
    assert.deepEqual(await command({key:'fresh',value:'after'}),{clearReply:true,keys:['fresh']});
    await fixture.waitForFunction(origin=>sandstone.controller.site_data.local[origin]?.some(([key])=>key==='fresh'),embedded);
    assert.deepEqual(await fixture.evaluate(origin=>sandstone.controller.site_data.local[origin],embedded),[['fresh','after']]);
    assert.deepEqual(errors,[]);
    return ['Clearing an active embedded site reloads its owning page before the old runtime can recreate data','Delayed writes from a cleared document cannot resurrect local storage','Replacement embedded documents retain working storage after clearing'];
  }finally{await fixture.close();await page.bringToFront();}
}
