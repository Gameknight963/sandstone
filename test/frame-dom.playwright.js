async page=>{
  const origin='https://frame-dom.test',other='https://different-frame.test',start=origin+'/parent';
  const parent='<!doctype html><title>Parent document</title><body><h1 id="heading">Parent heading</h1>';
  const child='<!doctype html><title>Child document</title><body><p id="content">Child content</p><script>window.childRead=()=>({text:document.getElementById("content").textContent,parent:parent.document.title,url:document.URL,parentURL:parent.location.href});parent.postMessage({domReady:true,path:location.pathname},"*");<\/script>';
  const native=await page.context().newPage();
  for(const host of [origin,other])await native.route(host+'/**',route=>route.fulfill({contentType:'text/html',body:route.request().url()===start?parent:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async(proxy,source)=>{const end=Date.now()+10000;while(!await evaluate(proxy,source)){if(Date.now()>end)throw new Error('Frame DOM timed out: '+source);await new Promise(resolve=>setTimeout(resolve,20));}};
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),start);else await native.goto(start);
    await evaluate(proxy,`globalThis.domReady=[];globalThis.domLoads=[];addEventListener('message',event=>{if(event.data?.domReady)domReady.push(event.data.path);});
      for(const [name,url,sandbox] of ${JSON.stringify([['same',origin+'/child',null],['sibling',origin+'/sibling',null],['cross',other+'/cross',null],['opaque',origin+'/opaque','allow-scripts']])}){
        const frame=document.createElement('iframe');frame.id=name;if(sandbox!==null)frame.sandbox=sandbox;frame.addEventListener('load',()=>domLoads.push({name,title:frame.contentDocument?.title||null}),true);frame.src=url;document.body.append(frame);
      }true`);
    await until(proxy,'domReady.length===4');
    await until(proxy,'domLoads.length>=4');
    const first=await read(proxy,`(()=>{
      const same=document.getElementById('same'),doc=same.contentDocument,win=same.contentWindow,node=doc.getElementById('content');
      const events=[];node.addEventListener('edited',event=>events.push(event.detail));node.textContent='Changed by parent';node.dispatchEvent(new CustomEvent('edited',{detail:42}));
      const span=doc.createElement('span');span.id='added';span.textContent='Added by parent';doc.body.append(span);
      win.eval('globalThis.globalReads=0;Object.defineProperty(window,"frameGetter",{configurable:true,get(){globalReads++;return 42;}});');
      const getter={value:win.frameGetter,reads:win.globalReads};
      const attempt=callback=>{try{return callback();}catch(error){return error.name;}};
      return {documentIdentity:doc===win.document,nodeIdentity:node===win.document.querySelector('#content'),ownerBody:node.ownerDocument.body===doc.body,
        metadata:{url:doc.URL,base:doc.baseURI,title:doc.title},child:win.childRead(),events,getter,added:win.document.getElementById('added').textContent,
        crossDocument:document.getElementById('cross').contentDocument,opaqueDocument:document.getElementById('opaque').contentDocument,
        crossAccess:attempt(()=>document.getElementById('cross').contentWindow.document.title),opaqueAccess:attempt(()=>document.getElementById('opaque').contentWindow.document.title),
        loads:domLoads.slice().sort((a,b)=>a.name.localeCompare(b.name)),source:{src:same.src,attribute:same.getAttribute('src'),srcdoc:same.srcdoc,inline:same.hasAttribute('srcdoc')}};
    })()`);
    const sibling=await read(proxy,`document.getElementById('same').contentWindow.eval('({text:parent.frames[1].document.getElementById("content").textContent,title:parent.document.title})')`);
    await evaluate(proxy,`globalThis.domSavedWindow=document.getElementById('same').contentWindow;globalThis.domSavedDocument=document.getElementById('same').contentDocument;domReady=[];document.getElementById('same').src=${JSON.stringify(other+'/after')};true`);
    await until(proxy,'domReady.includes("/after")');
    const cross=await read(proxy,`(()=>{const frame=document.getElementById('same');let access;try{access=domSavedWindow.document.title;}catch(error){access=error.name;}return {stable:domSavedWindow===frame.contentWindow,doc:frame.contentDocument,access};})()`);
    await evaluate(proxy,`domReady=[];document.getElementById('same').src=${JSON.stringify(origin+'/return')};true`);
    await until(proxy,'domReady.includes("/return")');
    const restored=await read(proxy,`(()=>{const frame=document.getElementById('same');return {stable:domSavedWindow===frame.contentWindow,fresh:frame.contentDocument!==domSavedDocument,body:frame.contentDocument.getElementById('content').textContent,url:frame.contentDocument.URL};})()`);
    await evaluate(proxy,`domReady=[];globalThis.inlineDOM=document.createElement('iframe');inlineDOM.srcdoc=${JSON.stringify(child)};document.body.append(inlineDOM);true`);
    await until(proxy,'domReady.length===1');
    const inline=await read(proxy,`({same:inlineDOM.contentDocument===inlineDOM.contentWindow.document,text:inlineDOM.contentDocument.getElementById('content').textContent,parent:inlineDOM.contentWindow.childRead().parent})`);
    return {first,sibling,cross,restored,inline};
  };
  try{
    const expected=await run(false);
    await page.evaluate(({start,parent,child,origin,other})=>{
      main_frame.special_pages[start]=parent;const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>[origin,other].includes(new URL(url).origin)?Promise.resolve(new Response(child,{headers:{'Content-Type':'text/html'}})):previous(url,options);
    },{start,parent,child,origin,other});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Frame DOM differs from native: '+JSON.stringify({expected,actual}));
    const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    if(await root.evaluate(()=>{try{parent.document.title;return false;}catch(error){return error.name==='SecurityError';}})!==true)throw new Error('The virtual root could access its host document');
    return ['Same-origin frame documents expose real DOM nodes, edits, events and virtual document metadata','Same-origin children can read parent/sibling documents while cross-origin and sandboxed documents remain isolated','Frame documents change across navigation while WindowProxy references remain stable and host files stay inaccessible'];
  }finally{await native.close();}
}
