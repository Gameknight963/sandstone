import assert from 'node:assert/strict';

export async function verifyProvisionalNavigation(page,{stages=['prepare_document','html']}={}){
  const fixture=await page.context().newPage(),origin='https://provisional-navigation.test',direct=[],errors=[],diagnostics=[];
  let parentFrame;
  const read=source=>fixture.evaluate(source=>main_frame.eval_js(source),source);
  try{
    fixture.on('pageerror',error=>errors.push(error.message));
    fixture.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(()=>{
      main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>new Response(new URL(url).pathname==='/child'
        ? '<!doctype html><body>Original<script>parent.postMessage({old:true,marker:globalThis.provisionalMarker||"missing"},"*");</script>'
        : new URL(url).pathname==='/replacement'?'<body>Replacement<script>parent.postMessage({replacement:true,url:location.href,origin,stored:localStorage.getItem("pending-seed")},"*");</script>'
        : '<!doctype html><body>Parent<script>globalThis.reports=[];addEventListener("message",event=>reports.push(event.data));</script>',
      {headers:{'content-type':'text/html'}});
    });
    for(const stage of stages)for(const kind of ['string','void','history','http','cross-origin']){
      const string=kind==='string',replacement=kind==='string'||kind==='http';
      const childURL=kind==='cross-origin'?'https://provisional-navigation-other.test/child':origin+'/child';
      await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');
      parentFrame=undefined;
      for(const frame of fixture.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url,origin+'/parent').catch(()=>false))parentFrame=frame;
      assert.ok(parentFrame,'The parent runtime did not load');
      await parentFrame.evaluate(({url,stage})=>{
        const send=MessagePort.prototype.postMessage;
        globalThis.restorePendingNavigation=()=>{MessagePort.prototype.postMessage=send;};
        MessagePort.prototype.postMessage=function(...args){
          const message=args[0];
          if(message?.type==='procedure'&&message.procedure===stage&&message.arguments[0]?.url===url){
            globalThis.pendingNavigationHeld=true;
            globalThis.releasePendingNavigation=()=>Reflect.apply(send,this,args);return;
          }
          return Reflect.apply(send,this,args);
        };
      },{url:childURL,stage});
      await read('localStorage.setItem("pending-seed","current");globalThis.childLoads=0;globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.src='+JSON.stringify(childURL)+';document.body.append(child);true');
      await parentFrame.waitForFunction(()=>globalThis.pendingNavigationHeld);
      if(stage==='html'){
        let childFrame;
        for(const frame of fixture.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url,childURL).catch(()=>false))childFrame=frame;
        assert.ok(childFrame,'The child context was not prepared before HTML delivery');
        const invalid=await childFrame.evaluate(async()=>{
          const {loader,rpc}=sandstone_frame,options={url:loader.url,frame_id:loader.frame_id,prepared_context:loader.beacon_context,html:'<script>throw new Error("Stale HTML executed")</script>'},errors=[];
          for(const overrides of [{prepared_context:'wrong'},{frame_id:'wrong'},{url:'https://wrong.test/'}])try{await rpc.rpc_handlers.html({...options,...overrides});errors.push('accepted');}catch(error){errors.push(error.name);}
          try{await rpc.rpc_handlers.prepare_document({});errors.push('accepted');}catch(error){errors.push(error.name);}
          return errors;
        });
        assert.deepEqual(invalid,['SecurityError','SecurityError','SecurityError','InvalidStateError']);
      }
      const markup='<!doctype html><body>Replacement<script>parent.postMessage({replacement:true,url:location.href,origin,stored:localStorage.getItem("pending-seed")},"*");</script>';
      const program=(kind==='history'?'history.replaceState({pending:true},"","/changed");':'')+'globalThis.provisionalMarker={stored:localStorage.getItem("pending-seed"),url:location.href,origin,referrer:document.referrer};void 0';
      const url=kind==='http'?origin+'/replacement':'javascript:'+encodeURIComponent(string?JSON.stringify(markup):program);
      await read('child.src='+JSON.stringify(url)+';true');
      await fixture.waitForTimeout(50);
      if(kind==='http')await parentFrame.waitForFunction(()=>reports.some(report=>report.replacement),undefined,{timeout:5000});
      await parentFrame.evaluate(()=>{restorePendingNavigation();releasePendingNavigation();});
      try{await parentFrame.waitForFunction(replacement=>reports.some(report=>replacement?report.replacement:report.old),replacement,{timeout:5000});}
      catch(error){
        const frames=[];
        for(const frame of fixture.frames())try{frames.push(await frame.evaluate(()=>({url:location.href,virtual:globalThis.sandstone_frame?.loader.url,loaded:globalThis.sandstone_frame?.loader.is_loaded,html:document.body?.textContent.slice(0,100)})));}catch{}
        throw new Error('Pending iframe navigation did not finish: '+JSON.stringify({stage,kind,reports:JSON.parse(await read('JSON.stringify(reports)')),diagnostics,frames}),{cause:error});
      }
      await fixture.waitForTimeout(50);
      await parentFrame.waitForFunction(()=>childLoads===1);
      const reports=JSON.parse(await read('JSON.stringify(reports)'));
      assert.deepEqual(reports,replacement?[{replacement:true,url:origin+(kind==='http'?'/replacement':'/child'),origin,stored:'current'}]:[{old:true,marker:kind==='cross-origin'?'missing':{stored:'current',url:origin+(kind==='history'?'/changed':'/child'),origin,referrer:origin+'/parent'}}],JSON.stringify({stage,kind}));
    }
    assert.deepEqual(direct,[],'Provisional navigation bypassed the relay');
    assert.deepEqual(errors,[],'Provisional navigation raised an error');
  }finally{
    await parentFrame?.evaluate(()=>{globalThis.restorePendingNavigation?.();globalThis.releasePendingNavigation?.();}).catch(()=>{});
    await fixture.close();
  }
  return ['JavaScript URLs arriving before iframe HTML delivery run in the intended document context','String results replace pending markup while non-string results retain the original document'];
}
