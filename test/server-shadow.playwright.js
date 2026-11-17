async page=>{
  const origin='https://server-shadow.test',native=await page.context().newPage(),direct=[];
  const html=`<!doctype html><html><head><base href="/assets/"></head><body>
    <script>globalThis.serverOrder=['before'];</script>
    <x-server id="open"><script>serverOrder.push('light-before');</script><template shadowrootmode="open" shadowrootclonable shadowrootserializable shadowrootdelegatesfocus>
      <link rel="stylesheet" href="shadow.css"><span class="paint">Server content</span><img src="image.svg">
      <div id="nested"><template shadowrootmode="open"><b>Nested shadow</b></template></div>
      <script async defer>serverOrder.push('shadow');</script><script src="shadow.js"></script>
    </template><i>Light content</i><script>serverOrder.push('light-after');</script></x-server>
    <x-server id="closed"><template shadowrootmode="closed" shadowrootclonable shadowrootserializable><img src="closed.svg"><b>Closed shadow</b></template></x-server>
    <div id="plain-closed"><template shadowrootmode="closed" shadowrootserializable><img src="plain.svg"><b>Private content</b></template></div>
    <template id="ordinary"><div><template shadowrootmode="open"><b>Inert declaration</b></template></div><script>serverOrder.push('inert');</script></template>
    <noscript><div id="no-script-host"><template shadowrootmode="open"><b>No script</b></template></div></noscript>
    <script>customElements.define('x-server',class extends HTMLElement {constructor(){super();this.internals=this.attachInternals();this.initialShadow=this.internals.shadowRoot?.mode;}});serverOrder.push('after');</script>
  </body></html>`;
  const external="serverOrder.push('external:'+(document.currentScript===null));";
  const response=url=>{
    const path=new URL(url).pathname;
    return path.endsWith('.svg')?{body:'<svg xmlns="http://www.w3.org/2000/svg" width="17" height="9"/>',contentType:'image/svg+xml'}:
      path.endsWith('.css')?{body:'.paint{color:rgb(23,45,67)}',contentType:'text/css'}:
        path.endsWith('.js')?{body:external,contentType:'text/javascript'}:{body:html,contentType:'text/html'};
  };
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    await native.route(origin+'/**',route=>route.fulfill(response(route.request().url())));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html,external})=>{
      const previous=sandstone.network.session.fetch;globalThis.serverShadowRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;serverShadowRequests.push(path);
        const image=path.endsWith('.svg'),css=path.endsWith('.css'),script=path.endsWith('.js');
        return Promise.resolve(new Response(image?'<svg xmlns="http://www.w3.org/2000/svg" width="17" height="9"/>':css?'.paint{color:rgb(23,45,67)}':script?external:html,{headers:{'Content-Type':image?'image/svg+xml':css?'text/css':script?'text/javascript':'text/html'}}));
      };
    },{origin,html,external});
    await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    const snapshot=`JSON.stringify((()=>{const open=document.getElementById('open'),closed=document.getElementById('closed'),root=open.internals.shadowRoot,secret=closed.internals.shadowRoot,ordinary=document.getElementById('ordinary');return {order:serverOrder,open:root&&{mode:root.mode,clonable:root.clonable,serializable:root.serializable,focus:root.delegatesFocus,nested:root.getElementById('nested').shadowRoot.textContent,children:open.children.length,initial:open.initialShadow},closed:secret&&{mode:secret.mode,hidden:closed.shadowRoot===null,initial:closed.initialShadow,text:secret.textContent},ordinary:ordinary.content.firstElementChild.shadowRoot===null,template:!!ordinary.content.querySelector('template[shadowrootmode]'),noscript:document.querySelector('noscript').innerHTML};})())`;
    const expected=await evaluate(false,snapshot),actual=await evaluate(true,snapshot);
    if(actual!==expected)throw new Error('Server shadow hydration differs: '+actual+' expected '+expected);
    const ready=`(()=>{const root=document.getElementById('open').internals.shadowRoot,secret=document.getElementById('closed').internals.shadowRoot;return root.querySelector('img').naturalWidth===17&&secret.querySelector('img').naturalWidth===17&&getComputedStyle(root.querySelector('.paint')).color==='rgb(23, 45, 67)';})()`;
    const deadline=Date.now()+5000;
    while(!await evaluate(true,ready)){if(Date.now()>deadline)throw new Error('Server shadow resources did not render through relay');await new Promise(resolve=>setTimeout(resolve,20));}
    const paths=await page.evaluate(()=>serverShadowRequests);
    for(const path of ['/assets/shadow.css','/assets/image.svg','/assets/closed.svg','/assets/plain.svg','/assets/shadow.js'])if(!paths.includes(path))throw new Error('Server shadow resource missing: '+path);
    const disabled=await page.context().browser().newContext({javaScriptEnabled:false});
    const allowJS=await page.evaluate(()=>main_frame.default_settings.allow_js);
    try{
      const noJS=await disabled.newPage();await noJS.route(origin+'/**',route=>route.fulfill(response(route.request().url())));
      await noJS.goto(origin+'/no-js');
      await page.evaluate(url=>{main_frame.default_settings.allow_js=false;return main_frame.navigate_to(url);},origin+'/no-js');
      const snapshot=`JSON.stringify({scripts:typeof serverOrder,open:document.getElementById('open').shadowRoot?.mode,closed:document.getElementById('plain-closed').getHTML({serializableShadowRoots:true}),noscript:document.getElementById('no-script-host').shadowRoot?.textContent,ordinary:document.getElementById('ordinary').content.firstElementChild.shadowRoot?.textContent})`;
      const expected=await noJS.evaluate(source=>eval(source),snapshot),actual=await evaluate(true,snapshot);
      if(actual!==expected)throw new Error('Scripting-disabled server shadow differs: '+actual+' expected '+expected);
    }finally{await page.evaluate(value=>{main_frame.default_settings.allow_js=value;},allowJS);await disabled.close();}
    if(direct.length)throw new Error('Server shadow attempted direct HTTP: '+JSON.stringify(direct));
    return ['Initial server-rendered shadow roots hydrate with native flags and script ordering','Nested and closed server shadow resources load through the relay','Scripting-disabled server shadows retain native noscript and template behavior'];
  }finally{await native.close();await page.unroute(/^https?:/,block);}
}
