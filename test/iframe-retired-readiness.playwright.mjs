export async function verifyRetiredReadiness(page){
  await page.evaluate(async()=>{
    const previousFetch=sandstone.network.session.fetch;
    sandstone.network.session.fetch=async url=>{
      const response=new Response('<!doctype html><body>Readiness',{headers:{'Content-Type':'text/html;charset=utf-8'}});
      Object.defineProperty(response,'url',{value:url});return response;
    };
    await main_frame.navigate_to('https://retirement.test/start');
    const target=main_frame.rpc_target,receive=target.onmessage,held=[];
    const policy=main_frame.rpc_policy,authorize=policy.authorize;
    globalThis.retiredReadiness={held,cancelled:0,previousFetch,target,receive,policy,authorize};
    target.onmessage=function(event,...args){
      if(event.data?.type==='procedure'&&['storage_ready','cookies_ready'].includes(event.data.procedure)){
        held.push({event:{data:event.data,source:event.source||event.currentTarget,ports:event.ports},args});return;
      }
      return receive.call(this,event,...args);
    };
    policy.authorize=function(message,source){
      try{return authorize.call(this,message,source);}
      catch(error){if(error.name==='AbortError')retiredReadiness.cancelled++;throw error;}
    };
    const iframe=main_frame.iframe,descriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
    let requested=descriptor.get.call(iframe);
    Object.assign(retiredReadiness,{iframe,descriptor});
    // Hold the physical navigation while the host retires its old contexts.
    Object.defineProperty(iframe,'src',{configurable:true,get(){return requested;},set(value){requested=String(value);retiredReadiness.nextURL=requested;}});
    await main_frame.eval_js('globalThis.child=document.createElement("iframe");document.body.append(child);child.contentWindow;true');
  });
  try{
    await page.waitForFunction(()=>retiredReadiness.held.length===2);
    await page.evaluate(()=>{retiredReadiness.navigation=main_frame.navigate_to('https://retirement.test/next');});
    await page.waitForFunction(()=>retiredReadiness.nextURL&&retiredReadiness.held.every(({event})=>{
      const binding=retiredReadiness.policy.ports.get(event.source);
      return binding&&retiredReadiness.policy.contexts().get(binding.context)?.retired;
    }));
    await page.evaluate(async()=>{
      const state=retiredReadiness;
      state.target.onmessage=state.receive;
      for(const {event,args} of state.held)state.receive.call(state.target,event,...args);
      // A round trip and a task boundary let the live old parent process rejections.
      await main_frame.eval_js('new Promise(resolve=>setTimeout(()=>resolve(true),0))');
    });
    await page.waitForFunction(()=>retiredReadiness.cancelled===2);
  }finally{
    await page.evaluate(async()=>{
      const state=retiredReadiness;
      state.target.onmessage=state.receive;state.policy.authorize=state.authorize;
      delete state.iframe.src;
      if(state.nextURL)state.descriptor.set.call(state.iframe,state.nextURL);
      try{await state.navigation;}finally{sandstone.network.session.fetch=state.previousFetch;delete globalThis.retiredReadiness;}
    });
  }
  return ['Retired blank-frame readiness cancels while the previous document remains physically active'];
}
