async page=>{
  const cases=[
    {name:'shared let',scripts:['let fetch=()=>"lexical";','saved.result=[fetch(),saved.global.fetch()];fetch=()=>"assigned";saved.result.push(fetch(),fetch.name);']},
    {name:'const restriction',scripts:['const fetch=()=>"constant";','let error;try{fetch=()=>"changed"}catch(value){error=value.name}saved.result=[fetch(),saved.global.fetch(),error];']},
    {name:'class binding',scripts:['class URL{static value(){return "class"}}','saved.result=[URL.value(),URL===saved.global.URL];URL=()=>"assigned";saved.result.push(URL());']},
    {name:'TDZ through old closure',scripts:['saved.read=()=>fetch();saved.type=()=>typeof fetch;','let error,type;try{saved.read()}catch(value){error=value.name}try{saved.type()}catch(value){type=value.name}let fetch=()=>"ready";saved.result=[error,type,saved.read()];']},
    {name:'const pattern default',scripts:['const {fetch=()=>"pattern"}={};','saved.result=[fetch(),fetch.name,saved.global.fetch()];']},
    {name:'property remains separate',scripts:['let fetch=()=>"lexical";','saved.global.fetch=()=>"property";saved.result=[fetch(),saved.global.fetch()];']},
    {name:'generated function',scripts:['let fetch=()=>"lexical";','saved.result=[saved.Function("return fetch()")(),saved.Function("with({})return fetch()")(),saved.global.fetch()];']},
    {name:'eval does not leak lexicals',scripts:['saved.eval('+JSON.stringify('let fetch=()=>"eval";saved.local=fetch()')+');','saved.result=[saved.local,fetch(),saved.global.fetch()];']},
    {name:'eval uses global lexicals',scripts:['let fetch=()=>"lexical";','saved.result=[saved.eval("fetch()"),saved.eval('+JSON.stringify('fetch=()=>"written";fetch()')+'),fetch(),saved.global.fetch()];']},
    {name:'module reads global cell',scripts:['let fetch=()=>"lexical";','saved.pending=import("data:text/javascript,"+encodeURIComponent('+JSON.stringify('saved.result=[fetch(),saved.global.fetch()];fetch=()=>"module write";saved.result.push(fetch());')+'));']},
    {name:'globalThis lexical cell',scripts:['const globalThis=()=>"lexical global";','saved.result=[globalThis(),typeof saved.global.globalThis,globalThis===saved.global.globalThis];']},
    {name:'with fallback',scripts:['let fetch=()=>"lexical";','with({fetch:()=>"object"})saved.object=fetch();with({})saved.fallback=fetch();saved.result=[saved.object,saved.fallback,saved.global.fetch()];']}
  ];
  const url='https://worker-global-lexicals.test/',html='<!doctype html><body>Worker global lexicals';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const sources=cases.map(example=>{
    const scripts=example.scripts.map(source=>'data:text/javascript,'+encodeURIComponent(source));
    return 'var saved={global:globalThis,send:postMessage.bind(self),Function,eval,Promise};saved.global.fetch=()=>"property";importScripts('+scripts.map(source=>JSON.stringify(source)).join(',')+');saved.Promise.resolve(saved.pending).then(()=>saved.send(saved.result),error=>saved.send({error:error.name,message:error.message}));';
  });
  const run=`(async()=>{const results=[],sources=${JSON.stringify(sources)},names=${JSON.stringify(cases.map(item=>item.name))};for(let index=0;index<sources.length;index++){const local=URL.createObjectURL(new Blob([sources[index]],{type:'text/javascript'})),worker=new Worker(local);try{results.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker lexical timed out: '+names[index])),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error(names[index]+': '+event.message))}}))}finally{worker.terminate();URL.revokeObjectURL(local)}}return JSON.stringify(results)})()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),run));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),run));
    for(let index=0;index<cases.length;index++)if(JSON.stringify(actual[index])!==JSON.stringify(expected[index]))throw new Error('Worker lexical parity ('+cases[index].name+'): '+JSON.stringify({expected:expected[index],actual:actual[index]}));
    return ['Classic workers share lexical cells across importScripts while retaining native TDZ and const behavior','Worker modules, eval and generated functions resolve shared lexical cells without changing global properties'];
  }finally{await context.close()}
}
