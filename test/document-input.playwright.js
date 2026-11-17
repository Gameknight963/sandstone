async page=>{
  const origin='https://document-input.test',nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),direct=[];
  const html='<!doctype html><body><main id="old">Old document</main>';
  const external='document.write("<b id=\\"external\\">External</b>");';
  const svgExternal='globalThis.svgExecutions.push({origin:location.origin,id:document.currentScript.id,tag:document.currentScript.localName,href:document.currentScript.href.baseVal});';
  const initialChunk='<p id="inserted">Initial write</p><script src="/external.js"></script>';
  const initialHTML='<!doctype html><body><main><script id="writer">globalThis.openResult=document.open()===document;document.write('+JSON.stringify(initialChunk).replace(/<\/script/gi,'<\\/script')+');document.close();</script><p id="static">Static</p></main><script>globalThis.tailRan=true;</script>';
  const retiringChunk='<script src="/slow.js"></script><p id="retired-tail">Old</p>';
  const retiringCode='globalThis.oldTailRan=false;setTimeout(()=>{document.open();document.write("<!doctype html><p id=\\"replacement\\">Replacement</p>");document.close();},0);document.write('+JSON.stringify(retiringChunk).replace(/<\/script/gi,'<\\/script')+');';
  const retiringHTML='<!doctype html><body><script>'+retiringCode+'</script><script>oldTailRan=true;</script>';
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const navigate=async()=>{await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');};
  try{
    await native.route(origin+'/**',async route=>{const path=new URL(route.request().url()).pathname,image=path.endsWith('.svg'),css=path.endsWith('.css'),script=path.endsWith('.js');if(path==='/slow.js')await new Promise(resolve=>setTimeout(resolve,80));try{return await route.fulfill({contentType:image?'image/svg+xml':css?'text/css':script?'text/javascript':'text/html',body:image?'<svg xmlns="http://www.w3.org/2000/svg" width="23" height="8"/>':css?'.paint{color:rgb(21,43,65)}':path==='/svg-script.js'?svgExternal:script?external:path==='/initial'?initialHTML:path==='/retiring'?retiringHTML:html});}catch(error){if(path!=='/slow.js')throw error;}});
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html,external,svgExternal,initialHTML,retiringHTML})=>{const previous=sandstone.network.session.fetch;globalThis.documentInputRequests=[];sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const path=new URL(url).pathname;documentInputRequests.push(path);const image=path.endsWith('.svg'),css=path.endsWith('.css'),script=path.endsWith('.js');
      const response=()=>new Response(image?'<svg xmlns="http://www.w3.org/2000/svg" width="23" height="8"/>':css?'.paint{color:rgb(21,43,65)}':path==='/svg-script.js'?svgExternal:script?external:path==='/initial'?initialHTML:path==='/retiring'?retiringHTML:html,{headers:{'Content-Type':image?'image/svg+xml':css?'text/css':script?'text/javascript':'text/html'}});
      return path==='/slow.js'?new Promise(resolve=>setTimeout(()=>resolve(response()),80)):Promise.resolve(response());
    };},{origin,html,external,svgExternal,initialHTML,retiringHTML});
    const cases=[
      ['replacement and split tokens',`const returned=document.open();document.write('<!doctype html><title>Written</title><p id="written" data-value="a&gt;b">one &am');const first=document.getElementById('written');document.write('p; two</p>');document.close();return {returned:returned===document,same:first===document.getElementById('written'),old:document.getElementById('old')===null,text:first.textContent,attribute:first.getAttribute('data-value'),title:document.title,mode:document.compatMode};`],
      ['quirks document',`document.open();document.write('<p>Quirks</p>');document.close();return {mode:document.compatMode,text:document.body.textContent};`],
      ['SVG script execution',`globalThis.svgWrittenCount=0;document.open();document.write('<!doctype html><svg><script>globalThis.svgWrittenOrigin=location.origin;svgWrittenCount++;</script></svg>');document.close();return {origin:globalThis.svgWrittenOrigin,count:svgWrittenCount};`],
      ['partial tag and writeln',`document.open();document.write('<!doctype html><p id="');const before=document.getElementById('written');document.write('written">');document.writeln('line',1);document.write('</p>');document.close();return {before:before===null,text:document.getElementById('written').textContent};`],
      ['implicit opening',`document.write('<!doctype html><p id="written">Implicit</p>');document.close();return {old:document.getElementById('old')===null,text:document.getElementById('written').textContent};`],
      ['synchronous readiness',`document.open();const states=[document.readyState];document.addEventListener('readystatechange',()=>states.push(document.readyState));document.write('<!doctype html><p>Written</p>');states.push('written:'+document.readyState);document.close();states.push('closed:'+document.readyState);return states;`],
      ['replacement from completion event',`globalThis.completionEvents=[];document.open();document.addEventListener('readystatechange',()=>{if(document.readyState!=='complete')return;document.open();addEventListener('load',()=>completionEvents.push('load'));addEventListener('pageshow',()=>completionEvents.push('show'));document.write('<!doctype html><p>Replacement</p>');document.close();});document.write('<!doctype html><p>Old</p>');document.close();return {events:completionEvents,text:document.body.textContent,ready:document.readyState};`],
      ['listener clearing and global preservation',`globalThis.keptValue=42;globalThis.listenerEvents=[];const callback=()=>listenerEvents.push('old');addEventListener('probe',callback);document.addEventListener('probe',callback);document.open();document.write('<!doctype html><p>New</p>');dispatchEvent(new Event('probe'));document.dispatchEvent(new Event('probe'));addEventListener('probe',callback,{once:true});dispatchEvent(new Event('probe'));dispatchEvent(new Event('probe'));document.close();return {events:listenerEvents,value:keptValue};`],
      ['storage and named properties',`localStorage.setItem('written-kept','value');document.cookie='written_kept=cookie';document.open();document.write('<!doctype html><p>New</p>');document.close();return {local:localStorage.getItem('written-kept'),cookie:document.cookie.includes('written_kept=cookie'),oldName:typeof window.old};`],
      ['listener options reset after open',`globalThis.clicks=0;const handler=event=>{clicks++;event.preventDefault();};addEventListener('click',handler,{once:true,passive:true});document.open();document.write('<!doctype html><a id="link" href="#target">Link</a>');addEventListener('click',handler,{passive:false});const link=document.getElementById('link'),results=[];for(let index=0;index<2;index++)results.push(link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));document.close();return {clicks,results,hash:location.hash};`],
      ['coercion failures preserve old content',`let reads=0,error;try{document.write({toString(){reads++;return 'first'}},Symbol('bad'))}catch(e){error=e.name}return {reads,error,old:!!document.getElementById('old')};`],
      ['receiver errors',`const results=[];for(const name of ['open','write','writeln','close'])try{Document.prototype[name].call({});results.push('ok')}catch(e){results.push(e.name)}return results;`]
    ];
    for(const [name,body] of cases){
      await navigate();const source='JSON.stringify((()=>{'+body+'})())';
      const expected=await evaluate(false,source),actual=await evaluate(true,source);
      if(actual!==expected)throw new Error('Document input differs for '+name+': '+actual+' expected '+expected);
    }
    for(const attributes of ['href="'+origin+'/svg-script.js"','xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="'+origin+'/svg-script.js"']){
      await navigate();
      const markup='<!doctype html><svg><script id="svg-external" '+attributes+'/><script type="module">svgExecutions.push("module:"+location.origin);</script></svg>';
      const source='(async()=>{globalThis.svgExecutions=[];document.open();document.write('+JSON.stringify(markup)+');document.close();const end=Date.now()+3000;while(document.readyState!=="complete"){if(Date.now()>end)throw new Error("SVG script did not finish");await new Promise(resolve=>setTimeout(resolve,10));}return JSON.stringify(svgExecutions);})()';
      const expected=await evaluate(false,source),actual=await evaluate(true,source);
      if(JSON.parse(expected).length!==2||actual!==expected)throw new Error('Written external SVG scripts differ: '+actual+' expected '+expected);
    }
    await navigate();
    const nested='<b id="nested">Nested</b><script>globalThis.nestedRan=true;</script>';
    const source='<!doctype html><script>const outer=document.currentScript;document.write('+JSON.stringify(nested).replace(/<\/script/gi,'<\\/script')+');globalThis.outerRestored=document.currentScript===outer;</script><p id="after">After</p>';
    await page.evaluate(source=>main_frame.eval_js('document.open();document.write('+JSON.stringify(source)+');document.close();true'),source);
    const end=Date.now()+5000;
    while(!JSON.parse(await evaluate(true,`JSON.stringify(document.readyState==='complete'&&globalThis.nestedRan&&globalThis.outerRestored&&!!document.getElementById('after'))`))){if(Date.now()>end)throw new Error('Nested document scripts or relay RPC did not survive replacement');await new Promise(resolve=>setTimeout(resolve,20));}
    await navigate();
    const resources='<!doctype html><link rel="stylesheet" href="/written.css"><p id="paint" class="paint">Paint</p><script>globalThis.styleAtScript=getComputedStyle(document.getElementById("paint")).color;</script><script src="/external.js"></script><img id="image" src="/written.svg">';
    for(const proxy of [false,true])await evaluate(proxy,'document.open();document.write('+JSON.stringify(resources)+');document.close();true');
    const resourceEnd=Date.now()+5000;
    while(!await evaluate(true,`document.readyState==='complete'&&document.getElementById('image')?.naturalWidth===23&&!!document.getElementById('external')`)){if(Date.now()>resourceEnd)throw new Error('Written resources or script loads did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
    const resourceSnapshot=`JSON.stringify({color:styleAtScript,image:document.getElementById('image').naturalWidth,external:document.getElementById('external').textContent})`;
    const nativeResources=await evaluate(false,resourceSnapshot),proxyResources=await evaluate(true,resourceSnapshot);
    if(nativeResources!==proxyResources)throw new Error('Written resources differ: '+proxyResources+' expected '+nativeResources);
    await navigate();
    const based='<!doctype html><base href="/assets/"><img id="base-image" src="base-image.svg"><link rel="stylesheet" href="base-style.css"><p class="paint">Base resources</p>';
    for(const proxy of [false,true])await evaluate(proxy,'document.open();document.write('+JSON.stringify(based)+');document.close();true');
    const baseEnd=Date.now()+5000;
    while(!await evaluate(true,`document.readyState==='complete'&&document.getElementById('base-image').naturalWidth===23`)){if(Date.now()>baseEnd)throw new Error('Written base resources did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
    const baseRequests=await page.evaluate(()=>documentInputRequests);
    for(const path of ['/assets/base-image.svg','/assets/base-style.css'])if(!baseRequests.includes(path))throw new Error('Written base was not applied before resource preparation: '+path);
    await native.goto(origin+'/initial');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/initial');
    const initialSnapshot='JSON.stringify({open:openResult,tail:tailRan,ids:Array.from(document.querySelector("main").children,node=>node.id).filter(Boolean),written:document.getElementById("inserted").textContent,external:document.getElementById("external").textContent})';
    const expectedInitial=await evaluate(false,initialSnapshot),actualInitial=await evaluate(true,initialSnapshot);
    if(expectedInitial!==actualInitial)throw new Error('Initial document writes differ: '+actualInitial+' expected '+expectedInitial);
    await native.goto(origin+'/retiring');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/retiring');await new Promise(resolve=>setTimeout(resolve,120));
    const retiringSnapshot=`JSON.stringify({text:document.body.textContent,tail:oldTailRan,stale:!!document.getElementById('retired-tail'),ready:document.readyState})`;
    const expectedRetired=await evaluate(false,retiringSnapshot),actualRetired=await evaluate(true,retiringSnapshot);
    if(expectedRetired!==actualRetired)throw new Error('Retired initial parser resumed: '+actualRetired+' expected '+expectedRetired);
    await navigate();
    const lifecycle=`(async()=>{document.open();const events=[];document.addEventListener('readystatechange',()=>events.push('state:'+document.readyState));document.addEventListener('DOMContentLoaded',()=>events.push('dom'));document.addEventListener('load',()=>events.push('document load'));addEventListener('load',event=>events.push('window load:'+String(event.target===document)));addEventListener('pageshow',event=>events.push('show:'+event.persisted));document.write('<!doctype html><p>New</p>');document.close();await new Promise(resolve=>setTimeout(resolve,20));return JSON.stringify(events);})()`;
    const expectedLifecycle=await evaluate(false,lifecycle),actualLifecycle=await evaluate(true,lifecycle);
    if(expectedLifecycle!==actualLifecycle)throw new Error('Document lifecycle differs: '+actualLifecycle+' expected '+expectedLifecycle);
    await navigate();
    const cancelled=`(async()=>{document.open();document.write('<!doctype html><script src="/external.js"></script><p id="stale">Old</p>');document.close();document.open();document.write('<!doctype html><p id="replacement">Replacement</p>');document.close();await new Promise(resolve=>setTimeout(resolve,40));return JSON.stringify({text:document.body.textContent,stale:!!document.getElementById('stale'),external:!!document.getElementById('external'),ready:document.readyState});})()`;
    for(const source of [cancelled,cancelled.replace('document.close();document.open();','document.open();')]){
      await navigate();
      const expectedCancelled=await evaluate(false,source),actualCancelled=await evaluate(true,source);
      if(expectedCancelled!==actualCancelled)throw new Error('Retired document input resumed: '+actualCancelled+' expected '+expectedCancelled);
    }
    if(direct.length)throw new Error('Document input attempted direct HTTP: '+JSON.stringify(direct));
    return ['Document open/write/writeln/close preserve native replacement and partial parsing behavior','Document replacement clears page listeners while retaining globals and relay RPC','Nested written scripts execute in insertion order and retain currentScript','Written scripts wait for styles and external resources stay on the relay','Initial inline writes use their insertion point and retired input cannot resume'];
  }finally{await nativeContext.close();await page.unroute(/^https?:/,block);}
}
