async(page,batch=0)=>{
  const globals=['URL','Object','Reflect','JSON','Promise','Function','Proxy','Array','Map','Set','WeakMap','WeakSet','String','Number','Boolean','Symbol','Date','Math','RegExp','Error','TypeError','Uint8Array','ArrayBuffer','DataView','Blob','File','FormData','Headers','Request','Response','AbortController','AbortSignal','ReadableStream','TextEncoder','TextDecoder','MessageChannel','Event','EventTarget','DOMException','Worker','crypto','eval','globalThis','self','structuredClone','URLSearchParams','setTimeout','encodeURIComponent','Document','Element','Node','postMessage','importScripts','close'];
  globals.push('Image','Audio','FontFace','StorageEvent','CryptoKey','SubtleCrypto');
  const cases=[...globals.map(name=>({name,mode:'function'})),...['URL','Object','JSON','Promise','Uint8Array','globalThis','self','crypto'].map(name=>({name,mode:'lexical'}))];
  if(cases.length>72||!Number.isInteger(batch)||batch<0||batch>=Math.ceil(cases.length/24))throw new Error('Runtime global batches do not cover these cases');
  const url='https://runtime-globals.test/',pages={},payload='native globals';
  for(let index=0;index<cases.length;index++){
    const {name,mode}=cases[index];
    const setup='window.saved={JSON,Object,Promise,URL,Uint8Array,Blob,Headers,Request,AbortController,Worker,fetch:fetch.bind(window),structuredClone,setTimeout:setTimeout.bind(window)};';
    const replace=(mode==='function'?'function '+name+'(){return "authored"}':'const '+name+'=()=>"authored";')+'window.visible=['+name+'(),window['+JSON.stringify(name)+']==='+name+'];';
    const workerDeclaration=(mode==='function'?'function '+name+'(){return "worker authored"}':'const '+name+'=()=>"worker authored";')+'saved.visible=['+name+'(),saved.realm['+JSON.stringify(name)+']==='+name+'];';
    const workerSource='var saved={realm:globalThis,send:postMessage.bind(self),fetch:fetch.bind(self),Uint8Array,Headers,Request};importScripts('+JSON.stringify('data:text/javascript,'+encodeURIComponent(workerDeclaration))+');(async()=>{try{const request=new saved.Request('+JSON.stringify(url+'payload')+',{method:"POST",headers:new saved.Headers({"Content-Type":"application/octet-stream"}),body:new saved.Uint8Array([65,66,67]).subarray(1)});const response=await saved.fetch(request);saved.send({visible:saved.visible,text:await response.text(),status:response.status})}catch(error){saved.send({error:error.name,message:error.message})}})();';
    const probe=`(async()=>{const saved=window.saved;try{
      const controller=new saved.AbortController(),headers=new saved.Headers({'Content-Type':'application/octet-stream'});
      const request=new saved.Request('/payload',{method:'POST',headers,body:new saved.Uint8Array([65,66,67]).subarray(1),signal:controller.signal});
      const response=await saved.fetch(request);const text=await response.text();
      history.pushState({value:42},'',location.href+'#state');
      const workerSource=${JSON.stringify(workerSource)},local=saved.URL.createObjectURL(new saved.Blob([workerSource],{type:'text/javascript'})),worker=new saved.Worker(local);
      let workerValue;try{workerValue=await new saved.Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=event=>{event.preventDefault();reject(new Error(event.message))}})}finally{worker.terminate();saved.URL.revokeObjectURL(local)}
      window.result={visible:window.visible,text,status:response.status,state:history.state.value,worker:workerValue};
    }catch(error){window.result={error:error.name,message:error.message,visible:window.visible}}})()`;
    pages['/case/'+index]='<!doctype html><body><script>'+setup+'<\/script><script>'+replace+'<\/script><script>'+probe+'<\/script>';
  }
  const context=await page.context().browser().newContext(),native=await context.newPage(),cdp=await context.newCDPSession(native);
  await context.route(url+'**',route=>{const request=route.request(),path=new URL(request.url()).pathname;return route.fulfill({contentType:path==='/payload'?'text/plain':'text/html',body:path==='/payload'?request.postData()||payload:pages[path]||'<!doctype html>'})});
  const read='window.saved.JSON.stringify(window.result)';
  try{
    await page.evaluate(({url,pages,payload})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const parsed=new URL(target);return parsed.origin===new URL(url).origin?Promise.resolve(new Response(parsed.pathname==='/payload'?(options?.body==null?payload:typeof options.body==='string'?options.body:new TextDecoder().decode(options.body)):pages[parsed.pathname]||'<!doctype html>',{headers:{'Content-Type':parsed.pathname==='/payload'?'text/plain':'text/html'}})):previous(target,options)};},{url,pages,payload});
    for(let index=0;index<cases.length;index++){
      if(Math.floor(index/24)!==batch)continue;
      console.log(JSON.stringify({fixture:'Runtime global replacement',...cases[index]}));
      const target=url+'case/'+index;await native.goto(target);
      const query=await cdp.send('Runtime.evaluate',{expression:'new window.saved.Promise(resolve=>{const check=()=>window.result?resolve('+read+'):window.saved.setTimeout(check,10);check()})',awaitPromise:true,returnByValue:true});if(query.exceptionDetails)throw new Error('Native globals query failed: '+cases[index].name);const expected=JSON.parse(query.result.value);
      await page.evaluate(target=>main_frame.navigate_to(target),target);
      const actual=JSON.parse(await page.evaluate(()=>main_frame.eval_js('new window.saved.Promise(resolve=>{const check=()=>window.result?resolve(window.saved.JSON.stringify(window.result)):window.saved.setTimeout(check,10);check()})')));
      if(expected.error||expected.worker?.error||expected.text!=='BC'||expected.worker?.text!=='BC'||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Runtime global replacement parity ('+cases[index].mode+' '+cases[index].name+'): '+JSON.stringify({expected,actual}));
    }
    return ['Runtime global replacements preserve native API behavior, batch '+(batch+1),'Worker global replacements preserve native requests and startup, batch '+(batch+1)];
  }finally{await context.close()}
}
