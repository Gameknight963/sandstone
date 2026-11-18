async page=>{
  const url='https://worker-vars.test/',html='<!doctype html><body>Worker global vars';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const run=`(async()=>{
    const results=[];
    for(const key of ['fetch','location','URL','Worker','setTimeout','postMessage','indexedDB','XMLHttpRequest','eval','globalThis','self','importScripts','close']){
      const inspect='var '+key+';const descriptor=Object.getOwnPropertyDescriptor(globalThis,'+JSON.stringify(key)+');savedPost({key:'+JSON.stringify(key)+',type:typeof '+key+',same:'+key+'===globalThis['+JSON.stringify(key)+'],own:Object.hasOwn(globalThis,'+JSON.stringify(key)+'),descriptor:descriptor?{configurable:descriptor.configurable,enumerable:descriptor.enumerable,writable:descriptor.writable,type:typeof descriptor.value}:null});';
      const code='globalThis.savedPost=postMessage.bind(self);importScripts('+JSON.stringify('data:text/javascript,'+encodeURIComponent(inspect))+');';
      const local=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(local);
      try{results.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker var timed out: '+key)),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error('Worker var failed: '+key+': '+event.message))}}))}
      finally{worker.terminate();URL.revokeObjectURL(local)}
    }
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),run));await native.close();
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),run));
    for(let index=0;index<expected.length;index++)if(JSON.stringify(expected[index])!==JSON.stringify(actual[index]))throw new Error('Worker var parity: '+JSON.stringify({expected:expected[index],actual:actual[index]}));
    return ['Classic worker var declarations preserve inherited API shadowing, own properties and native descriptors','Saved worker postMessage aliases survive later global declarations'];
  }finally{await context.close()}
}
