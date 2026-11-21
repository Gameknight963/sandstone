import assert from 'node:assert/strict';

export async function verifyInitialJavascriptQueue(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://initial-queue.test',html='<!doctype html><body><script>globalThis.reports=[];globalThis.loads=0;addEventListener("message",event=>reports.push(event.data));</script>',errors=[],direct=[];
  const documentHTML=label=>'<!doctype html><body>'+label+'<script>parent.postMessage({document:'+JSON.stringify(label)+',binding:typeof sequenceValue,value:typeof sequenceValue==="number"?sequenceValue:null},"*");</script>';
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(predicate,label)=>{
    const deadline=Date.now()+8000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error(label);
      await fixture.waitForTimeout(20);
    }
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(html=>{
      main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});
    },html);
    for(const kind of ['initial-src','connected-src','initial-location','reinsert','repeated-source','second-document','first-document','first-document-location','both-documents']){
      const results=[];
      const firstDocument=kind==='first-document'||kind==='first-document-location'||kind==='both-documents',secondDocument=kind==='second-document'||kind==='both-documents',repeated=kind==='repeated-source';
      const first='javascript:'+encodeURIComponent(repeated?'var sequenceValue=(globalThis.sequenceValue||0)+1;parent.postMessage({program:"repeat",value:sequenceValue},"*");void 0':'let sequenceValue=11;parent.postMessage({program:"first",value:sequenceValue},"*");'+(firstDocument?JSON.stringify(documentHTML('first')):'void 0'));
      const second=repeated?first:'javascript:'+encodeURIComponent('parent.postMessage({program:"second",binding:typeof sequenceValue,value:typeof sequenceValue==="number"?++sequenceValue:null},"*");'+(secondDocument?JSON.stringify(documentHTML('second')):'void 0'));
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Initial JavaScript queue',kind,proxy}));
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');else await native.goto(origin+'/parent');
        const useLocation=kind==='initial-location'||kind==='first-document-location';
        const source='globalThis.child=document.createElement("iframe");child.onload=()=>loads++;'+(kind==='connected-src'?'':'child.src='+JSON.stringify(first)+';')+'document.body.append(child);'+(kind==='connected-src'?'child.src='+JSON.stringify(first)+';':'')+(useLocation?'child.contentWindow.location.href=':'child.src=')+JSON.stringify(second)+';true';
        await read(proxy,source);
        try{await wait(()=>read(proxy,repeated?'reports.filter(report=>report.program==="repeat").length===2':firstDocument?'reports.some(report=>report.document==="first")':secondDocument?'reports.some(report=>report.document==="second")':'reports.some(report=>report.program==="second")'),'The initial JavaScript queue did not finish: '+JSON.stringify({kind,proxy}));}
        catch(error){console.log({errors,snapshot:await read(proxy,'JSON.stringify({reports,loads,src:child.getAttribute("src")})')});throw error;}
        if(kind==='reinsert'){
          await wait(()=>read(proxy,'loads>0'),'The initial frame never loaded before reinsertion');
          await read(proxy,'child.remove();document.body.append(child);true');
          await wait(()=>read(proxy,'reports.filter(report=>report.program==="second").length===2'),'Reinsertion did not replay the current JavaScript source');
        }
        await wait(()=>read(proxy,'loads>0'),'The initial JavaScript queue did not dispatch load');
        await fixture.waitForTimeout(60);
        const snapshot=JSON.parse(await read(proxy,'JSON.stringify({reports,loads,src:child.getAttribute("src")})'));
        results.push(snapshot);
      }
      assert.deepEqual(results[1],results[0],kind);
      assert.equal(results[0].loads,kind==='reinsert'?2:1,kind);
      assert.deepEqual(results[0].reports.slice(0,firstDocument?1:2),repeated?[{program:'repeat',value:1},{program:'repeat',value:2}]:firstDocument?[{program:'first',value:11}]:[{program:'first',value:11},{program:'second',binding:'number',value:12}],kind);
    }
    assert.deepEqual(direct,[],'An initial JavaScript queue bypassed the relay');
    assert.deepEqual(errors,[],'An initial JavaScript queue raised a script error');
  }finally{await fixture.close();await nativeContext.close();}
  return ['Initial iframe JavaScript URLs keep native queue ordering, lexical bindings, string-result cancellation and load counts','Reinserted frames replay the current JavaScript source without replaying superseded initial sources'];
}
