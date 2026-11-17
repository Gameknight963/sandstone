async page=>{
  const origin='https://shadow-navigation.test',native=await page.context().newPage(),direct=[],nativeRequests=[];
  const cases=[['initial','closed',false],['initial','closed',true],['setter','closed',false],['clone','closed',true],['import','closed',true],['initial','open',false]];
  const documents=cases.map(([operation,mode,clonable],index)=>{
    const markup=`<x-shadow-router id="host"><template shadowrootmode="${mode}" ${clonable?'shadowrootclonable':''}><a id="link" href="#target">Follow link</a><form action="/received-${index}" target="sink"><input name="field" value="shadow"><button id="send">Submit</button></form></template></x-shadow-router>`;
    return `<!doctype html><body><iframe name="sink" style="display:none"></iframe>${operation==='initial'?markup:'<main id="fixture"></main>'}<script>
      customElements.define('x-shadow-router',class extends HTMLElement {constructor(){super();this.internals=this.attachInternals();}});
      ${operation==='initial'?'':`const container=document.createElement('div');container.setHTMLUnsafe(${JSON.stringify(markup)});let host=container.firstElementChild;${operation==='clone'?'host=host.cloneNode(true);':operation==='import'?'host=document.importNode(host,true);':''}document.getElementById('fixture').append(host);`}
      globalThis.routerRoot=document.getElementById('host').internals.shadowRoot;
      globalThis.routerEvents=[];routerRoot.addEventListener('submit',event=>routerEvents.push([event.isTrusted,event.defaultPrevented]));
    </script>`;
  });
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const click=async(proxy,id)=>{
    const point=JSON.parse(await evaluate(proxy,`JSON.stringify((()=>{const r=routerRoot.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})())`));
    const offset=proxy?await page.evaluate(()=>{const f=main_frame.iframe,r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop};}):{x:0,y:0};
    await (proxy?page:native).mouse.click(point.x+offset.x,point.y+offset.y);
  };
  const wait=async(predicate,label)=>{const end=Date.now()+2500;while(!await predicate()){if(Date.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,20));}};
  try{
    await native.route(origin+'/**',route=>{
      const parsed=new URL(route.request().url()),path=parsed.pathname,index=Number(path.slice(1));nativeRequests.push(path+parsed.search);
      return route.fulfill({contentType:'text/html',body:documents[index]||'<!doctype html><p>Received</p>'});
    });
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,documents})=>{const previous=sandstone.network.session.fetch;globalThis.shadowNavigationRequests=[];sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const parsed=new URL(url);shadowNavigationRequests.push(parsed.pathname+parsed.search);
      const index=Number(parsed.pathname.slice(1));return Promise.resolve(new Response(documents[index]||'<!doctype html><p>Received</p>',{headers:{'Content-Type':'text/html'}}));
    };},{origin,documents});
    for(let index=0;index<cases.length;index++){
      const name=cases[index].join(' '),url=origin+'/'+index;
      await native.goto(url);await page.evaluate(url=>main_frame.navigate_to(url),url);
      await click(false,'link');await click(true,'link');
      await wait(async()=>await evaluate(true,'location.hash')==='#target','Trusted shadow link did not use virtual navigation: '+name);
      if(await evaluate(false,'location.hash')!==await evaluate(true,'location.hash'))throw new Error('Shadow link differs: '+name);
      for(const proxy of [false,true])await evaluate(proxy,`routerRoot.getElementById('link').href='#cancelled';routerRoot.addEventListener('click',event=>event.preventDefault(),{once:true});true`);
      await click(false,'link');await click(true,'link');await new Promise(resolve=>setTimeout(resolve,30));
      for(const proxy of [false,true])if(await evaluate(proxy,'location.hash')!=='#target')throw new Error('Cancelled shadow link navigated: '+name);
      for(const proxy of [false,true])await evaluate(proxy,`routerRoot.getElementById('link').href='#stopped';routerRoot.addEventListener('click',event=>event.stopImmediatePropagation(),{once:true,capture:true});true`);
      await click(false,'link');await click(true,'link');
      await wait(async()=>await evaluate(true,'location.hash')==='#stopped','Stopped shadow link lost default activation: '+name);
      const path='/received-'+index+'?field=shadow';
      const received=()=>page.evaluate(path=>shadowNavigationRequests.filter(url=>url===path).length,path);
      await click(false,'send');await click(true,'send');
      await wait(async()=>await received()===1,'Trusted shadow form did not use relay: '+name);
      for(const proxy of [false,true])await evaluate(proxy,`routerRoot.addEventListener('submit',event=>event.preventDefault(),{once:true});true`);
      await click(false,'send');await click(true,'send');await new Promise(resolve=>setTimeout(resolve,30));
      if(await received()!==1)throw new Error('Cancelled shadow form submitted: '+name);
      for(const proxy of [false,true])await evaluate(proxy,`routerRoot.addEventListener('submit',event=>event.stopImmediatePropagation(),{once:true,capture:true});true`);
      await click(false,'send');await click(true,'send');
      await wait(async()=>await received()===2,'Stopped shadow form lost default submission: '+name);
      await wait(async()=>nativeRequests.filter(url=>url===path).length===2,'Native shadow submission baseline did not settle: '+name);
      const expected=await evaluate(false,'JSON.stringify(routerEvents)'),actual=await evaluate(true,'JSON.stringify(routerEvents)');
      if(actual!==expected)throw new Error('Shadow submit event differs: '+name+' '+actual+' expected '+expected);
    }
    if(direct.length)throw new Error('Shadow navigation attempted direct HTTP: '+JSON.stringify(direct));
    return ['Trusted links in declarative and copied closed roots use virtual navigation','Trusted forms in declarative and copied shadow roots submit through the relay','Shadow navigation preserves cancellation and stopped propagation without duplicate requests'];
  }finally{await native.close();await page.unroute(/^https?:/,block);}
}
