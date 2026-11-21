import assert from 'node:assert/strict';

const profiles=[
  {sandbox:null,after:'allow-scripts'},
  {sandbox:'allow-scripts',after:null},
  {sandbox:'allow-scripts allow-same-origin',after:'allow-scripts'},
  {sandbox:'allow-scripts',after:'allow-scripts allow-same-origin'},
  {sandbox:'allow-scripts allow-same-origin allow-modals',after:'allow-scripts'},
  {sandbox:'allow-same-origin',after:'allow-scripts allow-same-origin'},
  {sandbox:'allow-scripts allow-same-origin',after:'allow-same-origin'},
  {sandbox:null,after:'allow-scripts',cross:true},
  {sandbox:'allow-scripts',after:null,cross:true},
  {sandbox:'allow-scripts allow-same-origin allow-modals',after:'allow-scripts',cross:true}
];
export async function verifyIframeSandboxSnapshot(page,{custom=false,batch=0,batches=1}={}){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://sandbox-snapshot.test',other='https://sandbox-other.test',errors=[],direct=[];
  const root='<!doctype html><body>Sandbox navigation snapshot',child='<!doctype html><script>globalThis.snapshotRan=true;alert("snapshot modal");</script><body>Child';
  let held,dialogs=0;for(const surface of [native,fixture]){surface.on('pageerror',error=>errors.push(error.message));surface.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});}
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const measure=async proxy=>{
    const parent=proxy?fixture.frames().find(frame=>frame.parentFrame()===fixture.mainFrame()):native.mainFrame();
    const frame=(proxy?fixture:native).frames().find(frame=>frame.parentFrame()===parent);
    return frame.evaluate(proxy=>{
      const view=proxy?sandstone_frame.context.get_runtime_context():globalThis;
      let storage;try{view.localStorage.setItem('snapshot-key','works');storage={value:view.localStorage.getItem('snapshot-key')};}catch(error){storage={error:error.name};}
      return {ran:!!view.snapshotRan,origin:view.origin,storage};
    },proxy);
  };
  const wait=async operation=>{const deadline=Date.now()+8000;while(!await operation()){if(Date.now()>deadline)throw new Error('Iframe sandbox snapshot did not complete');await fixture.waitForTimeout(10);}};
  try{
    await native.route(/^https:\/\/sandbox-(?:snapshot|other)\.test\//,async route=>{const isChild=new URL(route.request().url()).pathname==='/child';if(isChild){held.started=true;await held.promise;}await route.fulfill({contentType:'text/html',body:isChild?child:root});});
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({root,child})=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>{const isChild=new URL(url).pathname==='/child';if(isChild){snapshotHeld.started=true;await snapshotHeld.promise;}return new Response(isChild?child:root,{headers:{'content-type':'text/html','cache-control':'no-store'}});};},{root,child});
    const selected=(custom?profiles.slice(0,3):profiles).filter((_,index)=>index%batches===batch);
    for(const profile of selected){const results=[];
      for(const proxy of [false,true]){
        dialogs=0;held={started:false};held.promise=new Promise(resolve=>{held.release=resolve;});
        console.log(JSON.stringify({fixture:'Iframe sandbox snapshot',...profile,custom,proxy}));
        if(proxy){await fixture.evaluate(()=>{globalThis.snapshotHeld={started:false};snapshotHeld.promise=new Promise(resolve=>{snapshotHeld.release=resolve;});});await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');}
        else await native.goto(origin+'/root');
        const start=function(profile,custom,url){
          globalThis.snapshotSandboxEvents=0;globalThis.snapshotChecks=[];globalThis.snapshotLoads=0;
          if(custom){customElements.define('snapshot-frame',class extends HTMLIFrameElement{
            static observedAttributes=['sandbox','src'];
            attributeChangedCallback(name){if(name==='sandbox')snapshotSandboxEvents++;if(globalThis.snapshotSaved!==undefined)snapshotChecks.push({same:this.getAttributeNode('sandbox')===snapshotSaved,value:this.getAttribute('sandbox'),owner:snapshotSaved===null||snapshotSaved.ownerElement===this});}
          },{extends:'iframe'});}
          const subject=globalThis.subject=custom?document.createElement('iframe',{is:'snapshot-frame'}):document.createElement('iframe');
          if(profile.sandbox!==null)subject.sandbox=profile.sandbox;subject.onload=()=>snapshotLoads++;subject.src=url;document.body.append(subject);
        };
        await read(proxy,'('+start.toString()+')('+JSON.stringify(profile)+','+custom+','+JSON.stringify((profile.cross?other:origin)+'/child')+')');
        await wait(()=>proxy?fixture.evaluate(()=>snapshotHeld.started):held.started);
        await read(proxy,'if('+JSON.stringify(profile.after)+'===null)subject.removeAttribute("sandbox");else subject.sandbox='+JSON.stringify(profile.after)+';globalThis.snapshotSaved=subject.getAttributeNode("sandbox");globalThis.snapshotBeforeEvents=snapshotSandboxEvents;globalThis.snapshotChecks=[];globalThis.snapshotMutations=[];globalThis.snapshotObserver=new MutationObserver(records=>snapshotMutations.push(...records));snapshotObserver.observe(subject,{attributes:true,attributeFilter:["sandbox"]});');
        if(proxy)await fixture.evaluate(()=>snapshotHeld.release());else held.release();
        await wait(()=>read(proxy,'snapshotLoads>0'));
        const parent=JSON.parse(await read(proxy,'JSON.stringify({sandbox:subject.getAttribute("sandbox"),same:subject.getAttributeNode("sandbox")===snapshotSaved,owner:snapshotSaved===null||snapshotSaved.ownerElement===subject,events:snapshotSandboxEvents-snapshotBeforeEvents,allEvents:snapshotSandboxEvents,checks:snapshotChecks,mutations:snapshotMutations.length+snapshotObserver.takeRecords().length})'));
        assert.equal(parent.sandbox,profile.after);assert.equal(parent.same,true);assert.equal(parent.owner,true);assert.equal(parent.events,0);assert.equal(parent.mutations,0);
        if(custom)assert.equal(parent.allEvents,(profile.sandbox===null?0:1)+1,'An internal sandbox update triggered a custom-element callback');
        assert.ok(parent.checks.every(check=>check.same&&check.owner&&check.value===profile.after),'An internal sandbox write escaped into an author reaction');
        const first={...await measure(proxy),dialogs};dialogs=0;
        await read(proxy,'snapshotSaved=undefined;snapshotLoads=0;subject.src='+JSON.stringify((profile.cross?other:origin)+'/child?next=1')+';');
        await wait(()=>read(proxy,'snapshotLoads>0'));
        assert.equal(await read(proxy,'snapshotMutations.length+snapshotObserver.takeRecords().length'),0,'The next navigation emitted an internal sandbox mutation');
        assert.equal(await read(proxy,'snapshotSandboxEvents-snapshotBeforeEvents'),0,'The next navigation emitted an internal sandbox reaction');
        results.push({first,next:{...await measure(proxy),dialogs}});
      }
      assert.deepEqual(results[1],results[0],JSON.stringify(profile));
      for(const [stage,sandbox] of [['first',profile.sandbox],['next',profile.after]]){
        assert.equal(results[0][stage].ran,sandbox===null||sandbox.includes('allow-scripts'));
        assert.equal(results[0][stage].origin,sandbox!==null&&!sandbox.includes('allow-same-origin')?'null':profile.cross?other:origin);
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{held?.release();await fixture.evaluate(()=>globalThis.snapshotHeld?.release()).catch(()=>{});await fixture.close();await context.close();}
  return [custom?'Temporary sandbox application preserves Attr identity and hides internal customized-iframe reactions':'Iframe requests retain navigation-time origin, script and modal permissions when sandbox attributes change'];
}

export async function verifyBlankSandboxSnapshot(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://blank-sandbox-snapshot.test',html='<!doctype html><script>onmessage=e=>{if(e.data?.done)globalThis.blankResult=e.data.result;};</script><body>Blank sandbox snapshots';
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(html=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html','cache-control':'no-store'}});},html);
    for(const sandbox of [null,'allow-scripts allow-same-origin']){const after=sandbox===null?'allow-scripts allow-same-origin':null,results=[];
      for(const proxy of [false,true]){
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');else await native.goto(origin+'/root');
        await read(proxy,'globalThis.subject=document.createElement("iframe");if('+JSON.stringify(sandbox)+'!==null)subject.sandbox='+JSON.stringify(sandbox)+';document.body.append(subject);void subject.contentWindow;');
        const ready=async()=>{
          if(!proxy)return;
          const parent=fixture.frames().find(frame=>frame.parentFrame()===fixture.mainFrame()),child=fixture.frames().find(frame=>frame.parentFrame()===parent);
          await child.waitForFunction(()=>globalThis.sandstone_frame?.loader.is_loaded);
        };
        await ready();
        await read(proxy,'subject.remove();if('+JSON.stringify(after)+'===null)subject.removeAttribute("sandbox");else subject.sandbox='+JSON.stringify(after)+';document.body.append(subject);void subject.contentWindow;');
        await ready();
        const javascript='javascript:try{top.location.hash="after";parent.postMessage({done:true,result:"allowed"},"*");}catch(error){parent.postMessage({done:true,result:error.name},"*");}void 0';
        await read(proxy,'subject.src='+JSON.stringify(javascript)+';');
        const deadline=Date.now()+8000;
        while(!await read(proxy,'!!globalThis.blankResult')){if(Date.now()>deadline)throw new Error('Reinserted blank sandbox did not complete');await fixture.waitForTimeout(10);}
        results.push(JSON.parse(await read(proxy,'JSON.stringify({result:blankResult,hash:location.hash})')));
      }
      assert.deepEqual(results[1],results[0]);assert.deepEqual(results[0],after===null?{result:'allowed',hash:'#after'}:{result:'SecurityError',hash:''});
    }
  }finally{await fixture.close();await context.close();}
  return ['Reinserted blank frames capture fresh sandbox flags for JavaScript execution and ancestor navigation'];
}
