import assert from 'node:assert/strict';

function fragmentCommand(kind,url){
  const argument=JSON.stringify(url);
  switch(kind){
    case 'href':case 'href-after-history':return 'savedWindow.location.href='+argument;
    case 'assign':case 'replace':return 'savedWindow.location.'+kind+'('+argument+')';
    case 'hash':return 'savedWindow.location.hash="next"';
    case 'same-hash':return 'savedWindow.location.hash="start"';
    case 'empty-hash':case 'no-hash-empty':case 'repeat-empty':return 'savedWindow.location.hash=""';
    case 'no-hash-pound':return 'savedWindow.location.hash="#"';
    case 'own-empty-hash':return 'savedWindow.eval('+JSON.stringify('location.hash=""')+')';
    case 'own-no-fragment':return 'savedWindow.eval('+JSON.stringify('location.assign('+argument+')')+')';
    case 'reload':return 'savedWindow.location.reload()';
    case 'src':case 'src-after-history':return 'child.src='+argument;
    case 'open':return 'window.open('+argument+',"fragment-target")';
    case 'link':return 'globalThis.link=document.createElement("a");link.href='+argument+';link.target="fragment-target";document.body.append(link);link.click()';
    default:throw new Error('Unknown iframe fragment case: '+kind);
  }
}

export async function verifyIframeFragments(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://iframe-fragments.test',parentHTML='<!doctype html><body><script>globalThis.loads=0;</script>',childHTML='<!doctype html><body><div id="start">Start</div><div id="next">Next</div><script>globalThis.marker={};globalThis.events=[];for(const type of ["popstate","hashchange"])addEventListener(type,event=>events.push({type,...(type==="popstate"?{state:event.state}:{old:event.oldURL,url:event.newURL})}));</script>';
  const errors=[],direct=[],requests=[];
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(predicate,label)=>{const deadline=Date.now()+8000;while(!await predicate()){if(Date.now()>deadline)throw new Error(label);await fixture.waitForTimeout(20);}};
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>{
      const child=new URL(route.request().url()).pathname!=='/parent';
      if(child)requests.push(false);
      return route.fulfill({contentType:'text/html',body:child?childHTML:parentHTML});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.exposeFunction('recordFragmentRequest',()=>requests.push(true));
    await fixture.evaluate(({origin,parentHTML,childHTML})=>{
      main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>{
        const child=new URL(url).pathname!=='/parent';if(child)await recordFragmentRequest();
        return new Response(child?childHTML:parentHTML,{headers:{'content-type':'text/html'}});
      };
    },{origin,parentHTML,childHTML});
    for(const kind of ['href','assign','replace','hash','empty-hash','same-hash','src','link','open','no-hash-empty','no-hash-pound','repeat-empty','own-empty-hash','own-no-fragment','reload','src-after-history','href-after-history','inline-hash','inline-replace','inline-empty-hash','inline-own-empty-hash','inline-reload']){
      const results=[];
      const inline=kind.startsWith('inline-'),operation=inline?kind.slice(7):kind,base=inline?'about:srcdoc':origin+'/child';
      const initialHash=operation.startsWith('no-hash-')?'':operation==='repeat-empty'?'#':'#start';
      const reloaded=operation==='own-no-fragment'||operation==='reload',renamed=operation.endsWith('-after-history'),noChange=['same-hash','no-hash-empty','no-hash-pound','repeat-empty'].includes(operation);
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Iframe fragments',kind,proxy}));
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');else await native.goto(origin+'/parent');
        await read(proxy,'globalThis.child=document.createElement("iframe");child.name="fragment-target";child.onload=()=>loads++;'+(inline?'child.srcdoc='+JSON.stringify(childHTML):'child.src='+JSON.stringify(base+initialHash))+';document.body.append(child);true');
        await wait(()=>read(proxy,'loads===1'),'The fragment iframe did not load');
        if(inline){
          await read(proxy,'child.contentWindow.location.hash="start";true');
          await wait(()=>read(proxy,'child.contentWindow.events.some(event=>event.type==="hashchange")'),'The inline iframe fragment did not initialize');
        }
        await read(proxy,'globalThis.savedWindow=child.contentWindow;globalThis.savedDocument=savedWindow.document;globalThis.savedMarker=savedWindow.marker;globalThis.beforeHistory=savedWindow.history.length;savedWindow.history.replaceState({saved:true},"");savedWindow.events=[];true');
        const initialRequests=requests.filter(value=>value===proxy).length;
        const suffix=operation==='own-no-fragment'||operation.startsWith('no-hash-')?'':['empty-hash','own-empty-hash','repeat-empty'].includes(operation)?'#':['same-hash','reload'].includes(operation)?'#start':'#next';
        const url=(renamed?origin+'/renamed':base)+suffix;
        let command=fragmentCommand(operation,url);
        if(renamed)command='savedWindow.history.pushState({changed:true},"",'+JSON.stringify(origin+'/renamed#start')+');'+command;
        await read(proxy,command+';globalThis.immediateURL=savedWindow.location.href;true');
        await wait(()=>read(proxy,'savedWindow.location.href==='+JSON.stringify(url)),'The fragment URL did not change');
        if(!noChange)await wait(()=>read(proxy,reloaded?'loads===2':'savedWindow.events.some(event=>event.type==="hashchange")||savedWindow.document!==savedDocument'),'The fragment navigation did not finish');
        await fixture.waitForTimeout(60);
        const snapshot=JSON.parse(await read(proxy,'JSON.stringify({url:savedWindow.location.href,document:savedWindow.document===savedDocument,window:child.contentWindow===savedWindow,marker:savedWindow.marker===savedMarker,loads,history:savedWindow.history.length-beforeHistory,events:savedWindow.events,state:savedWindow.history.state,...('+JSON.stringify(!['src','src-after-history','link','open'].includes(operation))+'?{immediateURL}:{})})'));
        snapshot.requests=requests.filter(value=>value===proxy).length-initialRequests;results.push(snapshot);
      }
      assert.deepEqual(results[1],results[0],kind);
      assert.equal(results[0].document,!reloaded,kind);assert.equal(results[0].requests,reloaded&&!inline?1:0,kind);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await nativeContext.close();}
  return ['Parent Location, iframe src, links and Window.open preserve fragment document identity and JavaScript state','Iframe fragments preserve synchronous Location updates, history replacement and native load/event counts'];
}
