async page=>{
  const html='<!doctype html><body>Worker environment settings';
  const {createServer}=process.getBuiltinModule('node:http');
  const modes=['location','document','origin','all','document-null','document-getter'];
  let origin,requests=0;
  const source=mode=>{
    const replacements=[];
    if(mode==='location'||mode==='all')replacements.push('var location={href:"https://wrong.test/location/"};');
    if(mode==='document'||mode==='all')replacements.push('var document={baseURI:"https://wrong.test/document/"};');
    if(mode==='origin'||mode==='all')replacements.push('var origin="https://wrong.test";');
    if(mode==='document-null')replacements.push('var document=null;');
    if(mode==='document-getter')replacements.push('Object.defineProperty(self,"document",{get(){throw new Error("authored document getter was read")}});');
    return `const saved={fetch:fetch.bind(self),Request,XMLHttpRequest,EventSource,Worker,Function,send:postMessage.bind(self)};
      ${replacements.join('\n')}
      onmessage=async()=>{try{
        const request=new saved.Request('./request');
        const fetched=await saved.fetch('./fetch').then(response=>response.text());
        const xhr=await new Promise((resolve,reject)=>{const request=new saved.XMLHttpRequest();request.open('GET','./xhr');request.onload=()=>resolve(request.responseText);request.onerror=()=>reject(new Error('XHR failed'));request.send()});
        const stream=await new Promise((resolve,reject)=>{const events=new saved.EventSource('./events');events.onmessage=event=>{events.close();resolve(event.data)};events.onerror=()=>{events.close();reject(new Error('EventSource failed'))}});
        const module=await saved.Function('return import("./module.js")')();
        const child=new saved.Worker('./child.js');let nested;
        try{nested=await new Promise((resolve,reject)=>{child.onmessage=event=>resolve(event.data);child.onerror=event=>{event.preventDefault();reject(new Error(event.message))};child.postMessage('run')})}finally{child.terminate()}
        saved.send({request:request.url,fetched,xhr,stream,module:module.value,nested});
      }catch(error){saved.send({error:error.name,message:error.message})}};`;
  };
  const resource=path=>{
    const mode=modes.find(mode=>path==='/workers/'+mode+'.js');
    if(mode)return {type:'text/javascript',body:source(mode)};
    if(path==='/workers/child.js')return {type:'text/javascript',body:'onmessage=()=>postMessage("child ready")'};
    if(path==='/workers/module.js')return {type:'text/javascript',body:'export const value="module ready";'};
    if(path.endsWith('/events'))return {type:'text/event-stream',body:'data: '+path+'\n\n'};
    return {type:path==='/'?'text/html':'text/plain',body:path==='/'?html:path};
  };
  const server=createServer((request,response)=>{requests++;const result=resource(new URL(request.url,origin).pathname);response.writeHead(200,{'Content-Type':result.type});response.end(result.body)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const run='(async()=>{const results=[];for(const type of ["classic","module"])for(const mode of '+JSON.stringify(modes)+'){const worker=new Worker("/workers/"+mode+".js",{type});try{results.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Worker settings timed out: "+type+" "+mode)),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error(event.message))};worker.postMessage("run")}))}finally{worker.terminate()}}return JSON.stringify(results)})()';
  try{
    await native.goto(origin);const expected=JSON.parse(await native.evaluate(source=>eval(source),run));
    for(const result of expected)if(result.error)throw new Error('Native worker settings failed: '+JSON.stringify(result));
    await native.close();const nativeRequests=requests;
    await page.evaluate(({origin,files})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(target,options)=>{
        const url=new URL(target),result=files[url.pathname];
        if(url.origin===origin&&result)return Promise.resolve(new Response(result.body,{headers:{'Content-Type':result.type}}));
        if(url.hostname==='wrong.test')return Promise.resolve(new Response('wrong environment base'));
        return previous(target,options);
      };
    },{origin,files:Object.fromEntries(['/',...modes.map(mode=>'/workers/'+mode+'.js'),'/workers/request','/workers/fetch','/workers/xhr','/workers/events','/workers/module.js','/workers/child.js'].map(path=>[path,resource(path)]))});
    await page.evaluate(url=>main_frame.navigate_to(url),origin);
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),run));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Worker settings parity: '+JSON.stringify({expected,actual}));
    if(requests!==nativeRequests)throw new Error('A proxied worker made a direct HTTP request');
    return ['Worker fetch, Request, XHR and EventSource retain their environment URL base despite public global replacements','Generated worker imports and nested Worker construction retain private URL and origin settings'];
  }finally{try{await context.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
