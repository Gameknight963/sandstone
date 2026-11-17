async page=>{
  const origin='https://svg-scripts.test',nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),direct=[];
  const code=`svgScriptLog.push({id:document.currentScript.id,origin:location.origin,href:document.currentScript.href.baseVal});`;
  const html='<!doctype html><body><svg id="fixture"></svg><template id="template"><svg><script id="template-script">'+code+'</script></svg></template>';
  const moduleCode=`svgScriptLog.push({current:document.currentScript,origin:location.origin,url:import.meta.url});`;
  const external=url=>url.endsWith('/module.js')?moduleCode:code+'svgScriptLog.at(-1).request='+JSON.stringify(new URL(url).pathname)+';';
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const navigate=async()=>{await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');};
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?external(route.request().url()):html}));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html,code,moduleCode})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(url.endsWith('/module.js')?moduleCode:url.endsWith('.js')?code+'svgScriptLog.at(-1).request='+JSON.stringify(new URL(url).pathname)+';':html,{headers:{'Content-Type':url.endsWith('.js')?'text/javascript':'text/html'}})):previous(url,options);},{origin,html,code,moduleCode});
    await navigate();
    const inline=`JSON.stringify((()=>{globalThis.svgScriptLog=[];const script=document.createElementNS('http://www.w3.org/2000/svg','script');script.id='inline';script.textContent=${JSON.stringify(code)};document.getElementById('fixture').append(script);return svgScriptLog;})())`;
    const expectedInline=await evaluate(false,inline),actualInline=await evaluate(true,inline);
    if(actualInline!==expectedInline)throw new Error('Dynamic inline SVG scripts differ: '+actualInline+' expected '+expectedInline);
    for(const [name,operation] of [
      ['fill connected',`fixture.append(script);script.textContent=code;`],
      ['append text',`fixture.append(script);script.append(document.createTextNode(code));`],
      ['append string',`fixture.append(script);script.append(code);`],
      ['replace children',`fixture.append(script);script.replaceChildren(code);`],
      ['range insertion',`fixture.append(script);const range=document.createRange();range.selectNodeContents(script);range.insertNode(document.createTextNode(code));`],
      ['adjacent text',`fixture.append(script);script.insertAdjacentText('beforeend',code);`],
      ['text before',`const text=document.createTextNode('');script.append(text);fixture.append(script);text.before(code);`],
      ['character data',`const text=document.createTextNode('');script.append(text);fixture.append(script);text.data=code;`],
      ['descendant text',`const child=document.createElementNS('http://www.w3.org/2000/svg','text');child.textContent=code;fixture.append(script);script.append(child);`],
      ['type change alone',`script.type='application/json';script.textContent=code;fixture.append(script);script.type='text/javascript';`],
      ['type then new text',`script.type='application/json';script.textContent=code;fixture.append(script);script.type='text/javascript';script.textContent=code;`],
      ['clone before insertion',`script.textContent=code;const copy=script.cloneNode(true);copy.id='copy';fixture.append(copy);`],
      ['clone after execution',`script.textContent=code;fixture.append(script);fixture.append(script.cloneNode(true));`],
      ['inert innerHTML',`fixture.innerHTML='<script id="fragment">'+code+'</script>';`],
      ['original template scripts',`fixture.append(document.importNode(document.getElementById('template').content,true));`]
    ]){
      await navigate();
      const source=`(async()=>{globalThis.svgScriptLog=[];const fixture=document.getElementById('fixture'),script=document.createElementNS('http://www.w3.org/2000/svg','script'),code=${JSON.stringify(code)};script.id='mutation';${operation}const sync=svgScriptLog.slice();await new Promise(resolve=>setTimeout(resolve,0));return JSON.stringify({sync,after:svgScriptLog});})()`;
      const expected=await evaluate(false,source),actual=await evaluate(true,source);
      if(actual!==expected)throw new Error('SVG script mutation differs for '+name+': '+actual+' expected '+expected);
    }
    for(const [name,operation] of [
      ['href',`script.href.baseVal=${JSON.stringify(origin+'/external.js')};`],
      ['xlink',`script.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',${JSON.stringify(origin+'/external.js')});`],
      ['connected href',`fixture.append(script);script.href.baseVal=${JSON.stringify(origin+'/external.js')};`],
      ['borrowed setAttribute',`fixture.append(script);Element.prototype.setAttribute.call(script,'href',${JSON.stringify(origin+'/external.js')});`],
      ['connected xlink',`fixture.append(script);script.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',${JSON.stringify(origin+'/external.js')});`],
      ['attribute node',`const attr=document.createAttribute('href');attr.value=${JSON.stringify(origin+'/external.js')};fixture.append(script);script.attributes.setNamedItem(attr);`],
      ['prepared URL',`fixture.append(script);script.href.baseVal=${JSON.stringify(origin+'/first.js')};script.href.baseVal=${JSON.stringify(origin+'/second.js')};`]
    ]){
      await navigate();
      const source=`(async()=>{globalThis.svgScriptLog=[];const fixture=document.getElementById('fixture'),script=document.createElementNS('http://www.w3.org/2000/svg','script');script.id='external';const done=new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(new Error('SVG request failed'));setTimeout(()=>reject(new Error('SVG script timed out')),3000);});
        ${operation}if(!script.isConnected)fixture.append(script);await done;return JSON.stringify(svgScriptLog);})()`;
      let expected,actual;
      try{expected=await evaluate(false,source);actual=await evaluate(true,source);}catch(error){throw new Error('SVG request case '+name+': '+error.message);}
      if(actual!==expected)throw new Error('Dynamic external SVG scripts differ for '+name+': '+actual+' expected '+expected);
    }
    await navigate();
    const moduleSource=`(async()=>{globalThis.svgScriptLog=[];for(let index=0;index<2;index++){const script=document.createElementNS('http://www.w3.org/2000/svg','script');script.type='module';script.href.baseVal=${JSON.stringify(origin+'/module.js')};const loaded=new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;setTimeout(()=>reject(new Error('SVG module timed out')),3000);});document.getElementById('fixture').append(script);await loaded;}return JSON.stringify(svgScriptLog);})()`;
    const expectedModule=await evaluate(false,moduleSource),actualModule=await evaluate(true,moduleSource);
    if(actualModule!==expectedModule)throw new Error('SVG module identity differs: '+actualModule+' expected '+expectedModule);
    if(direct.length)throw new Error('SVG scripts attempted direct HTTP: '+JSON.stringify(direct));
    return ['Dynamic SVG scripts retain native globals, currentScript, mutation timing and clone state','SVG href/xlink requests retain their prepared URL and stay on the relay','Dynamic SVG modules preserve module identity and import.meta'];
  }finally{await nativeContext.close();await page.unroute(/^https?:/,block);}
}
