async page=>{
  const origin='https://script-preparation.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const html='<!doctype html><body><script>globalThis.preparationLog=[];</script><script id="parsed" type="application/json">preparationLog.push("parsed");</script>';
  const code='preparationLog.push("executed:"+location.origin);';
  const cases=[
    ['empty then text',`document.body.append(script);script.textContent=code;`],
    ['empty then text node',`document.body.append(script);script.append(document.createTextNode(code));`],
    ['empty then character data',`const text=document.createTextNode('');script.append(text);document.body.append(script);text.data=code;`],
    ['empty then text property',`document.body.append(script);script.text=code;`],
    ['empty then innerText',`document.body.append(script);script.innerText=code;`],
    ['empty then borrowed text setter',`document.body.append(script);Object.getOwnPropertyDescriptor(Node.prototype,'textContent').set.call(script,code);`],
    ['empty then type and text',`document.body.append(script);script.type='application/json';script.textContent=code;`],
    ['data type change alone',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';`],
    ['data type then new text',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';script.textContent=code;`],
    ['data type then different text',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';script.textContent=code+'preparationLog.push("changed");';`],
    ['data type then identical text property',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';script.text=code;`],
    ['data type then identical borrowed text',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';Object.getOwnPropertyDescriptor(Node.prototype,'textContent').set.call(script,code);`],
    ['data type then appended text',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';script.append('preparationLog.push("second");');`],
    ['data type then reinsert',`script.type='application/json';script.textContent=code;document.body.append(script);script.remove();script.type='text/javascript';document.body.append(script);`],
    ['data type then source',`script.type='application/json';script.textContent=code;document.body.append(script);script.type='text/javascript';script.src='/code.js';`],
    ['data type then borrowed source',`script.type='application/json';document.body.append(script);script.type='text/javascript';Element.prototype.setAttribute.call(script,'src','/code.js');`],
    ['data type then source attribute node',`script.type='application/json';document.body.append(script);script.type='text/javascript';const attr=document.createAttribute('src');attr.value='/code.js';script.attributes.setNamedItem(attr);`],
    ['empty then language',`document.body.append(script);script.setAttribute('language','vbscript');script.textContent=code;`],
    ['language then executable text',`script.setAttribute('language','vbscript');script.textContent='';document.body.append(script);script.setAttribute('language','JavaScript');script.textContent=code;`],
    ['empty then nomodule',`document.body.append(script);script.noModule=true;script.textContent=code;script.noModule=false;script.append('preparationLog.push("again");');`],
    ['empty then module text',`document.body.append(script);script.type='module';script.textContent=code;`],
    ['data type then module source',`script.type='application/json';document.body.append(script);script.type='module';script.src='/code.js';`],
    ['parsed data then text',`script=document.getElementById('parsed');script.type='text/javascript';script.textContent=code;`],
    ['parsed data then source',`script=document.getElementById('parsed');script.type='text/javascript';script.src='/code.js';`],
    ['parsed data reinsert',`script=document.getElementById('parsed');script.remove();script.type='text/javascript';document.body.append(script);`]
  ];
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const run=async(proxy,operation)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
    const source=`(()=>{let script=document.createElement('script');const code=${JSON.stringify(code)};${operation};preparationLog.push('after');})()`;
    if(proxy)await page.evaluate(source=>main_frame.eval_js(source),source);else await native.evaluate(source=>eval(source),source);
    await new Promise(resolve=>setTimeout(resolve,100));
    return proxy?page.evaluate(()=>main_frame.eval_js('JSON.stringify(preparationLog)')):native.evaluate(()=>JSON.stringify(preparationLog));
  };
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('/code.js')?'text/javascript':'text/html',body:route.request().url().endsWith('/code.js')?code:html}));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html,code})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin!==origin?previous(url,options):Promise.resolve(new Response(String(url).endsWith('/code.js')?code:html,{headers:{'Content-Type':String(url).endsWith('/code.js')?'text/javascript':'text/html'}}));},{origin,html,code});
    const mismatches=[];
    for(const [name,operation] of cases){const expected=await run(false,operation),actual=await run(true,operation);if(actual!==expected)mismatches.push({name,expected,actual});}
    if(mismatches.length)throw new Error('Script preparation differs: '+JSON.stringify(mismatches));
    if(direct.length)throw new Error('Script preparation attempted direct HTTP: '+JSON.stringify(direct));
    return ['Initially empty and data scripts prepare on native mutation triggers','Parsed data scripts can become executable through the relay'];
  }finally{await context.close();await page.unroute(/^https?:/,block);}
}
