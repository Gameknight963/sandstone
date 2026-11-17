async (page,allowWarnings)=>{
  const source=`(()=>{
    const values=[],base=document.createElement('base');
    const sample=label=>{const link=document.createElement('a');link.href='child';values.push({label,url:location.href,href:base.href,base:document.baseURI,node:document.body.baseURI,link:link.href});};
    sample('missing');base.href='./assets/';document.head.append(base);sample('inserted');
    history.pushState(null,'','/base/changed/deep');sample('history-frozen');
    base.setAttribute('href',base.getAttribute('href'));sample('same-attribute');
    for(const value of ['javascript:void(0)','data:text/plain,x','blob:https://fixture.test/token','about:blank','http://[','','#fragment']){base.href=value;sample(value);}
    base.href='./relative/';history.replaceState(null,'','/base/new/path');sample('relative-frozen');
    document.head.append(base);sample('reinserted');
    const earlier=document.createElement('base');earlier.href='/first/';document.head.prepend(earlier);sample('earlier');
    base.href='/hidden/';sample('hidden-write');earlier.remove();sample('promoted');
    base.removeAttribute('href');sample('removed-attribute');base.setAttributeNS(null,'href','../ns/');sample('namespaced-write');
    base.attributes.getNamedItem('href').value='../attribute-node/';history.replaceState(null,'','/base/after-attribute/path');sample('attribute-before-history');
    base.remove();sample('removed-element');
    const template=document.createElement('template');template.innerHTML='<base href="https://ignored.test/">';document.body.append(template);sample('inert-template');template.remove();
    return JSON.stringify(values);
  })()`;
  const url='https://fixture.test/base/start/path?query=1#old',native=await page.context().newPage();
  const initialHTML=href=>'<!doctype html><base href='+JSON.stringify(href)+'><script src="resource.js"></script><body>Initial base';
  const nativeResources=[];native.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/resource.js'))nativeResources.push(request.url());});
  const warnings=[];native.on('console',message=>{if(message.type()==='error')warnings.push(message.text());});
  await native.route('https://fixture.test/base/**',route=>{
    const target=new URL(route.request().url());
    return route.fulfill(target.pathname.endsWith('/resource.js')?{contentType:'application/javascript',body:'globalThis.initialBaseResource=42;'}:{contentType:'text/html',body:target.searchParams.has('initial')?initialHTML(target.searchParams.get('initial')):'<!doctype html><body>Base URLs'});
  });
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await native.waitForTimeout(50);
    allowWarnings(warnings);
    await page.evaluate(async url=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>new URL(url).pathname.startsWith('/base/')?Promise.resolve(new Response('<!doctype html><body>Base URLs',{headers:{'Content-Type':'text/html'}})):previous(url,options);
      await main_frame.navigate_to(url);
    },url);
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    await page.waitForTimeout(50);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Base URL parity: '+JSON.stringify({expected,actual}));
    const inputs=['javascript:void(0)','data:text/plain,x','./assets/'],initial=[];
    for(const href of inputs){
      await native.goto('https://fixture.test/base/initial?initial='+encodeURIComponent(href));
      initial.push(await native.evaluate(()=>({base:document.baseURI,resource:initialBaseResource})));
    }
    await page.evaluate(html=>{
      const previous=sandstone.network.session.fetch;
      globalThis.baseResourceRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        const target=new URL(url);
        if(target.pathname.endsWith('/resource.js')){baseResourceRequests.push(url);return Promise.resolve(new Response('globalThis.initialBaseResource=42;',{headers:{'Content-Type':'application/javascript'}}));}
        if(target.searchParams.has('initial'))return Promise.resolve(new Response(html[target.searchParams.get('initial')],{headers:{'Content-Type':'text/html'}}));
        return previous(url,options);
      };
    },Object.fromEntries(inputs.map(href=>[href,initialHTML(href)])));
    for(let index=0;index<inputs.length;index++){
      await page.evaluate(url=>main_frame.navigate_to(url),'https://fixture.test/base/initial?initial='+encodeURIComponent(inputs[index]));
      const loaded=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify({base:document.baseURI,resource:initialBaseResource})')));
      if(JSON.stringify(loaded)!==JSON.stringify(initial[index]))throw new Error('Initial base resource resolution differs: '+JSON.stringify(loaded));
    }
    const resources=await page.evaluate(()=>baseResourceRequests);
    if(JSON.stringify(resources)!==JSON.stringify(nativeResources))throw new Error('Initial script request URLs differ: '+JSON.stringify({nativeResources,resources}));
    await page.waitForTimeout(50);
    return ['Frozen base URLs across history changes and reinsertion','Base precedence, unsafe/invalid schemes and native node baseURI'];
  }finally{await native.close();}
}
