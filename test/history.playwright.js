async page => {
  const equal = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`History: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const evaluate = source => page.evaluate(source => main_frame.eval_js(source), source);
  const read = async source => JSON.parse(await evaluate(`JSON.stringify(${source})`));
  const until = async source => {
    const deadline = Date.now() + 10000;
    while (!await evaluate(source)) {
      if (Date.now() > deadline) throw new Error('History condition timed out: ' + source);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await page.evaluate(async () => {
    const previous = sandstone.network.session.fetch;
    sandstone.network.session.fetch = async (url, options) => {
      if (!new URL(url).pathname.startsWith('/history/')) return previous(url, options);
      const nested = new URL(url).pathname === '/history/child' ? '<iframe src="https://fixture.test/history/grandchild"></iframe>' : '';
      return new Response(`<!doctype html><body style="height:4000px">${nested}
        <a id="jump" href="#section">Jump</a><div id="section" style="margin-top:1500px">Section</div>
        <a id="inline-cancel" href="/history/unwanted" onclick="window.inlineClick={type:event.type,id:this.id}; return false;">Cancel inline</a>
        <script>
          window.instance = Math.random(); window.events = [];
          addEventListener('popstate', event => events.push({type:'popstate',state:event.state}));
          addEventListener('hashchange', event => events.push({type:'hashchange',old:event.oldURL,url:event.newURL}));
        <\/script>`, {headers:{'Content-Type':'text/html'}});
    };
    await main_frame.navigate_to('https://fixture.test/history/start');
  });
  const inlineHandler=await read(`(()=>{
    const inline=document.getElementById('inline-cancel');inline.click();
    const original=inlineClick;
    inline.onclick=function(event){window.inlineReplacement=this===inline&&event.type==='click';return false;};
    inline.click();
    return {inline:inlineClick,replaced:inlineReplacement&&inlineClick===original,path:location.pathname};
  })()`);
  equal(inlineHandler,{inline:{type:'click',id:'inline-cancel'},replaced:true,path:'/history/start'});
  const initial = await read('({length:history.length,instance})');
  const mutated = await read(`(() => {
    const state={page:1,bytes:new Uint8Array([3,4])};
    history.pushState(state,'','?one'); state.page=99;
    const first={url:location.href,page:history.state.page,bytes:[...history.state.bytes],length:history.length};
    history.replaceState({page:2},'','?two#old');
    history.pushState({page:3},'','?three#new');
    return {first,url:document.URL,page:history.state.page,length:history.length,events};
  })()`);
  equal(mutated, {first:{url:'https://fixture.test/history/start?one',page:1,bytes:[3,4],length:initial.length+1},
    url:'https://fixture.test/history/start?three#new',page:3,length:initial.length+2,events:[]});
  await evaluate('history.back(); true');
  await until('events.length===2');
  equal(await read('({url:location.href,page:history.state.page,instance,types:events.map(event=>event.type)})'),
    {url:'https://fixture.test/history/start?two#old',page:2,instance:initial.instance,types:['popstate','hashchange']});
  await evaluate('events=[]; history.forward(); true');
  await until('events.length===2');
  equal(await read('history.state.page'), 3);
  equal(await read(`(() => {
    const errors=[];
    for(const [state,url] of [[{},'https://other.test/'],[()=>{},'?invalid']]) {
      try { history.pushState(state,'',url); } catch(error) { errors.push(error.name); }
    }
    return errors;
  })()`), ['SecurityError','DataCloneError']);
  await evaluate("events=[]; location.hash='section'; true");
  await until('events.length===2');
  equal(await read('({hash:location.hash,state:history.state,types:events.map(event=>event.type),scrolled:scrollY>1000})'),
    {hash:'#section',state:null,types:['popstate','hashchange'],scrolled:true});
  const hashLength = await read('history.length');
  await evaluate("events=[]; location.replace('#replaced'); true");
  await until('events.length===2');
  equal(await read('history.length'), hashLength);
  await evaluate("events=[]; document.getElementById('jump').click(); true");
  await until('events.length===2');
  equal(await read('location.hash'), '#section');
  await evaluate("history.replaceState({saved:42},''); true");
  const savedURL = await read('location.href');
  // Return from the old realm before it is replaced by the navigation.
  await evaluate("setTimeout(()=>location.assign('/history/next'),0); true");
  await page.waitForFunction(() => !main_frame.is_navigating && main_frame.url.pathname==='/history/next');
  equal(await read('history.length'), hashLength+2);
  await evaluate('setTimeout(()=>history.back(),0); true');
  await page.waitForFunction(url => !main_frame.is_navigating && main_frame.url.href===url, savedURL);
  equal(await read('({url:location.href,state:history.state,types:events.map(event=>event.type)})'),
    {url:savedURL,state:{saved:42},types:['popstate']});
  let restored = await read('instance');
  await evaluate('events=[]; history.back(); true');
  await until('events.length===2');
  equal(await read('({instance,hash:location.hash})'), {instance:restored,hash:'#replaced'});
  const navigation = await page.evaluate(()=>main_frame.navigation_id);
  const reloadLength = await read('history.length');
  await evaluate("history.replaceState({reload:7},''); scrollTo(0,800); setTimeout(()=>location.reload(),0); true");
  await page.waitForFunction(id=>main_frame.navigation_id>id && !main_frame.is_navigating,navigation);
  equal(await read('({state:history.state,length:history.length,scroll:scrollY,events})'), {state:{reload:7},length:reloadLength,scroll:800,events:[]});
  restored=await read('instance');
  await evaluate('history.back(); true');
  await until('events.length===2');
  equal(await read('({instance,hash:location.hash})'), {instance:restored,hash:'#new'});
  await evaluate(`(() => { const child=document.createElement('iframe'); child.src='/history/child'; document.body.append(child); return true; })()`);
  const findChild = async path => {
    const deadline=Date.now()+10000;
    while (Date.now()<deadline) {
      for (const frame of page.frames()) {
        try {
          if (await frame.evaluate(path => globalThis.sandstone_frame?.loader.url=== 'https://fixture.test'+path &&
              sandstone_frame.context.run_script('typeof instance')==='number', path)) return frame;
        } catch {}
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const frames=[];
    for(const frame of page.frames()) {
      try { frames.push(await frame.evaluate(()=>({url:globalThis.sandstone_frame?.loader.url,body:document.body?.innerText.slice(0,300)}))); } catch {}
    }
    throw new Error('Nested history frame not ready: '+path+' '+JSON.stringify(frames));
  };
  let child = await findChild('/history/grandchild');
  const childEval = source => child.evaluate(source=>sandstone_frame.context.run_script(source),source);
  await childEval("history.pushState({child:1},'','?one'); history.replaceState({child:2},''); true");
  equal(JSON.parse(await childEval('JSON.stringify({state:history.state,length:history.length})')), {state:{child:2},length:2});
  await childEval("setTimeout(()=>location.assign('/history/grandchild-next'),0); true");
  child=await findChild('/history/grandchild-next');
  equal(await childEval('history.length'),3);
  await childEval('setTimeout(()=>history.back(),0); true');
  child=await findChild('/history/grandchild?one');
  equal(JSON.parse(await childEval('JSON.stringify(history.state)')), {child:2});
  equal(await read('instance'),restored);
  for(const fail of [false,true]){
    await page.evaluate(fail=>{
      const send=main_frame.send_page,fetch=sandstone.network.session.fetch,onLoad=main_frame.on_load;
      const first='https://fixture.test/navigation-race/first',next='https://fixture.test/navigation-race/next';
      globalThis.navigationRace={first,next,loads:[],errors:[],calls:[],restore(){main_frame.send_page=send;sandstone.network.session.fetch=fetch;main_frame.on_load=onLoad;}};
      main_frame.special_pages[first]='<!doctype html><title>First document</title><body>First document</body>';
      main_frame.on_load=()=>navigationRace.loads.push(main_frame.url.href);
      main_frame.send_page=async options=>{
        navigationRace.calls.push({url:options.url,error:!!options.error});
        const result=await send(options);
        if(options.url===first){
          navigationRace.arrived=true;await new Promise(resolve=>navigationRace.releaseOld=resolve);
          if(fail)throw new Error('Superseded document failed');
        }
        return result;
      };
      sandstone.network.session.fetch=async(url,options)=>{
        if(url!==next)return fetch(url,options);
        navigationRace.waiting=true;await new Promise(resolve=>navigationRace.releaseNext=resolve);
        return new Response('<!doctype html><title>Current document</title><body>Current document</body>',{headers:{'Content-Type':'text/html'}});
      };
      main_frame.navigate_to(first).then(()=>navigationRace.oldDone=true).catch(error=>navigationRace.errors.push(error.message));
    },fail);
    await page.waitForFunction(()=>navigationRace.arrived);
    await page.evaluate(()=>{main_frame.navigate_to(navigationRace.next).catch(error=>navigationRace.errors.push(error.message));});
    await page.waitForFunction(()=>navigationRace.waiting);
    await page.evaluate(()=>navigationRace.releaseOld());
    await page.waitForFunction(()=>navigationRace.oldDone);
    equal(await page.evaluate(()=>({loading:main_frame.is_navigating,loads:navigationRace.loads,calls:navigationRace.calls.length,errors:navigationRace.errors})),{loading:true,loads:[],calls:1,errors:[]});
    await page.evaluate(()=>navigationRace.releaseNext());
    await page.waitForFunction(()=>!main_frame.is_navigating&&navigationRace.loads.length===1);
    equal(await read('document.title'),'Current document');
    equal(await page.evaluate(()=>navigationRace.calls),[{url:'https://fixture.test/navigation-race/first',error:false},{url:'https://fixture.test/navigation-race/next',error:false}]);
    await page.evaluate(()=>navigationRace.restore());
  }
  return ['History state cloning and URL validation', 'Same-document traversal and fragment events', 'Cross-document history restoration', 'Nested iframe navigation and history', 'Superseded document replies cannot finish or overwrite a newer navigation'];
}
