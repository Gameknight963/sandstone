async page=>{
  const origin='https://fixture.test',relValues=['stylesheet','preload stylesheet','StyleSheet PRELOAD','\tpreload\nstylesheet\f','stylesheetx','preload'];
  const lazy=`as="style" onload="this.onload=null;this.rel='stylesheet'"`;
  const html=rel=>'<!doctype html><link rel="'+rel+'" '+(rel==='preload'?lazy:'')+' href="'+origin+'/stylesheet-rel/one.css"><body><div id="probe">Stylesheet tokens</div>';
  const css=path=>'#probe{padding-left:'+(path.endsWith('/two.css')?29:17)+'px}';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  await nativeContext.route(origin+'/stylesheet-rel/**',route=>{
    const url=new URL(route.request().url());
    return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/html',body:url.pathname.endsWith('.css')?css(url.pathname):html(url.searchParams.get('rel')||'')});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,`JSON.stringify(${source})`).then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Stylesheet relation did not apply: '+expression);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    const values=[];
    for(const rel of relValues){
      const url=origin+'/stylesheet-rel/page?rel='+encodeURIComponent(rel);
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
      const expected=rel==='stylesheetx'?'0px':'17px';
      await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==='+JSON.stringify(expected));
      values.push(await read(proxy,'({padding:getComputedStyle(document.getElementById("probe")).paddingLeft,sheet:!!document.querySelector("link").sheet})'));
    }
    for(const rel of relValues.slice(0,4)){
      await evaluate(proxy,`new Promise((resolve,reject)=>{
        document.querySelector('link')?.remove();const link=document.createElement('link');link.rel=${JSON.stringify(rel)};
        link.href=${JSON.stringify(origin+'/stylesheet-rel/one.css')};link.onload=()=>resolve(true);link.onerror=()=>reject(new Error('Dynamic stylesheet failed'));document.head.append(link);
      })`);
      values.push(await read(proxy,'({rel:document.querySelector("link").rel,href:document.querySelector("link").href,raw:document.querySelector("link").getAttribute("href"),has:document.querySelector("link").hasAttribute("href"),padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
      await evaluate(proxy,`new Promise((resolve,reject)=>{const link=document.querySelector('link');link.onload=()=>resolve(true);link.onerror=()=>reject(new Error('Updated stylesheet failed'));link.href=${JSON.stringify(origin+'/stylesheet-rel/two.css')};})`);
      await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="29px"');
      values.push(await read(proxy,'({href:document.querySelector("link").href,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
    }
    for(const method of ['property','attribute','tokens']){
      const before=JSON.parse(await evaluate(proxy,`new Promise((resolve,reject)=>{
        document.querySelector('link')?.remove();const link=document.createElement('link');
        link.rel='preload';link.as='style';link.href=${JSON.stringify(origin+'/stylesheet-rel/one.css')};
        const timer=setTimeout(()=>reject(new Error('Stylesheet preload did not complete')),5000);
        link.onerror=()=>{clearTimeout(timer);reject(new Error('Stylesheet preload failed'));};
        link.onload=()=>{
          clearTimeout(timer);const before={padding:getComputedStyle(document.getElementById('probe')).paddingLeft,rel:link.rel,href:link.href};link.onload=null;
          ${method==='property'?"link.rel='stylesheet'":method==='attribute'?"link.setAttribute('rel','stylesheet')":"link.relList.replace('preload','stylesheet')"};
          resolve(JSON.stringify(before));
        };
        document.head.append(link);
      })`));
      values.push(before);
      await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="17px"');
      values.push(await read(proxy,'({rel:document.querySelector("link").rel,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
    }
    for(const mode of ['property','attribute','tokens','as','href','attributes']){
      const initialRel=mode==='as'?'preload':mode==='attribute'?'prefetch':'';
      const result=JSON.parse(await evaluate(proxy,`new Promise((resolve,reject)=>{
        document.querySelector('link')?.remove();const link=document.createElement('link');link.rel=${JSON.stringify(initialRel)};
        link.href=${JSON.stringify(origin+'/stylesheet-rel/one.css')};
        const timer=setTimeout(()=>reject(new Error('Late stylesheet relation did not load: '+${JSON.stringify(mode)})),5000);
        let before,changes;
        link.onerror=()=>{clearTimeout(timer);reject(new Error('Late stylesheet relation failed'));};
        link.onload=()=>{
          if(link.rel==='preload'){link.rel='stylesheet';return;}
          clearTimeout(timer);link.onload=null;resolve(JSON.stringify({before,changes,rel:link.rel,href:link.href,padding:getComputedStyle(document.getElementById('probe')).paddingLeft}));
        };
        document.head.append(link);
        ${mode==='href'?"link.href='./two.css';":''}
        ${mode==='attributes'?`link.removeAttribute('HREF');changes={missing:{href:link.href,raw:link.getAttribute('href'),has:link.hasAttribute('href')},names:0,values:0};link.setAttribute({toString(){changes.names++;return 'HREF';}},{toString(){changes.values++;return './two.css';}});`:''}
        before={rel:link.rel,tokens:link.relList.value,href:link.href,raw:link.getAttribute('href'),has:link.hasAttribute('href'),padding:getComputedStyle(document.getElementById('probe')).paddingLeft};
        ${mode==='property'?"link.rel='stylesheet'":mode==='attribute'?"link.setAttribute('REL','StyleSheet')":mode==='as'?"link.as='style'":"link.relList.add('stylesheet')"};
      })`));
      values.push(result);
    }
    return values;
  };
  try{
    const expected=await run(false);
    await page.evaluate(()=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        const target=new URL(url);if(!target.pathname.startsWith('/stylesheet-rel/'))return previous(url,options);
        const rel=target.searchParams.get('rel')||'';
        const lazy=`as="style" onload="this.onload=null;this.rel='stylesheet'"`;
        return Promise.resolve(new Response(target.pathname.endsWith('.css')?'#probe{padding-left:'+(target.pathname.endsWith('/two.css')?29:17)+'px}':
          '<!doctype html><link rel="'+rel+'" '+(rel==='preload'?lazy:'')+' href="https://fixture.test/stylesheet-rel/one.css"><body><div id="probe">Stylesheet tokens</div>',
          {headers:{'Content-Type':target.pathname.endsWith('.css')?'text/css':'text/html'}}));
      };
    });
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Stylesheet relation parity: '+JSON.stringify({expected,actual}));
    return ['Stylesheet rel tokens support combined relations, ASCII case and whitespace', 'Dynamic combined-relation stylesheets and href updates stay behind the relay', 'Style preloads promote through inline load handlers, rel properties, attributes and relList', 'Links assigned rel/as after insertion upgrade without direct HTTP requests'];
  }finally{await nativeContext.close();}
}
