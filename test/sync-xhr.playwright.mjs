import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {readFile} from 'node:fs/promises';

const worker=`onmessage=()=>{const results=[],form=new FormData();form.append('name','value');form.append('file',new Blob(['hello'],{type:'text/plain'}),'hello.txt');const cases=[['/text','',0,null],['/bytes','arraybuffer',0,null],['/json','json',0,null],['/echo','json',0,new URLSearchParams([['value','a b']])],['/echo','json',0,new Uint8Array([0,1,2,3]).subarray(1,3)],['/form','json',0,form],['/timeout','',20,null],['/text','',0,null],['/error','',0,null]];
for(const [path,type,timeout,body] of cases){const xhr=new XMLHttpRequest(),events=[];for(const target of [xhr,xhr.upload])for(const type of ['readystatechange','loadstart','progress','load','error','timeout','abort','loadend'])target.addEventListener(type,event=>events.push([target===xhr?'xhr':'upload',type,xhr.readyState,event.loaded??null,event.total??null]));xhr.open(body?'POST':'GET',path,false);xhr.responseType=type;xhr.timeout=timeout;let error;try{xhr.send(body)}catch(value){error=value.name}let response=xhr.response;if(response instanceof ArrayBuffer){const bytes=new Uint8Array(response);response={length:bytes.length,first:[...bytes.slice(0,5)],last:[...bytes.slice(-5)],sum:bytes.reduce((sum,value)=>sum+value,0)}}results.push({path,type,error,state:xhr.readyState,status:xhr.status,response,events});}postMessage(results)};`;
const bytes=Uint8Array.from({length:200000},(_,index)=>index%251);
export async function verifySyncXHR(page){
  const bundled=await readFile(new URL('../example/bundled.html',import.meta.url),'utf8');
  const server=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://local').pathname;
    response.setHeader('cross-origin-opener-policy','same-origin');response.setHeader('cross-origin-embedder-policy','require-corp');
    if(path==='/host'){response.setHeader('content-type','text/html');response.end(bundled);return;}
    if(path==='/native-worker.js'){response.setHeader('content-type','text/javascript');response.end(worker);return;}
    if(path==='/timeout'){setTimeout(()=>response.end('late'),100);return;}
    if(path==='/error'){request.socket.destroy();return;}
    if(path==='/text'){response.writeHead(200,{'content-type':'text/plain;charset=utf-8','content-length':'4'});response.write('a');setTimeout(()=>response.end('€'),5);return;}
    if(path==='/bytes'){response.writeHead(200,{'content-type':'application/octet-stream','content-length':String(bytes.length)});response.end(bytes);return;}
    if(path==='/json'){response.writeHead(200,{'content-type':'application/json','content-length':'12'});response.end('{"value":42}');return;}
    if(path==='/echo'||path==='/form'){const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks);let value={bytes:[...body],contentType:request.headers['content-type']||''};if(path==='/form'){const form=await new Request('http://localhost/form',{method:'POST',headers:request.headers,body,duplex:'half'}).formData();value={name:form.get('name'),file:{name:form.get('file').name,body:await form.get('file').text()}};}const result=JSON.stringify(value);response.writeHead(200,{'content-type':'application/json','content-length':String(Buffer.byteLength(result))});response.end(result);return;}
    response.setHeader('content-type','text/html');response.end('<body>Native synchronous XHR');
  });server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const native=await page.context().newPage(),fixture=await page.context().newPage(),fallback=await page.context().newPage(),direct=[],errors=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.goto(origin+'/page');const expected=await native.evaluate(()=>new Promise((resolve,reject)=>{const worker=new Worker('/native-worker.js');worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{worker.terminate();reject(new Error(event.message))};worker.postMessage('run')}));
    await fixture.goto(origin+'/host');await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async({worker,bytes})=>{
      sandstone.network.session.fetch=async(url,options={})=>{
        const path=new URL(url).pathname;
        if(path==='/timeout'){await new Promise(resolve=>setTimeout(resolve,100));return new Response('late');}
        if(path==='/error')throw new TypeError('Network failed');
        let body,contentType='text/plain';
        if(path==='/worker.js'){body=worker;contentType='text/javascript';}
        else if(path==='/text'){body='a€';contentType='text/plain;charset=utf-8';}
        else if(path==='/bytes'){body=Uint8Array.from(bytes);contentType='application/octet-stream';}
        else if(path==='/json'){body='{"value":42}';contentType='application/json';}
        else if(path==='/echo'){body=JSON.stringify({bytes:[...new Uint8Array(options.body||new ArrayBuffer(0))],contentType:new Headers(options.headers).get('content-type')||''});contentType='application/json';}
        else if(path==='/form'){const form=await new Request(url,{method:'POST',headers:options.headers,body:options.body}).formData();body=JSON.stringify({name:form.get('name'),file:{name:form.get('file').name,body:await form.get('file').text()}});contentType='application/json';}
        else {body='<body>Sync XHR';contentType='text/html';}
        return new Response(body,{statusText:'OK',headers:{'content-type':contentType,'content-length':String(new Blob([body]).size)}});
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to('https://sync-xhr.test/page');
    },{worker,bytes:[...bytes]});
    const actual=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{const worker=new Worker('/worker.js');let timer;try{return JSON.stringify(await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synchronous worker reply timed out')),10000);worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));worker.postMessage('run')}));}finally{clearTimeout(timer);worker.terminate();}})()`)));
    assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)));assert.equal(actual[0].response,'a€');assert.equal(actual[1].response.length,bytes.length);assert.equal(actual.find(item=>item.path==='/timeout').error,'TimeoutError');assert.equal(actual.at(-1).error,'NetworkError');assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    await fallback.goto(page.url());await fallback.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const localSource=`onmessage=()=>{const result={};try{const xhr=new XMLHttpRequest();xhr.open('GET','https://sync-xhr.test/text',false)}catch(error){result.remote=error.name}for(const [name,url] of [['data','data:text/plain,a%E2%82%AC'],['blob',URL.createObjectURL(new Blob(['local'],{type:'text/plain'}))]]){const xhr=new XMLHttpRequest();xhr.open('GET',url,false);xhr.send();result[name]={status:xhr.status,text:xhr.responseText};}postMessage(result)}`;
    const unavailable=JSON.parse(await fallback.evaluate(source=>main_frame.eval_js(`(async()=>{const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'})));let timer;try{return JSON.stringify(await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Local synchronous worker reply timed out')),10000);worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));worker.postMessage('run')}));}finally{clearTimeout(timer);worker.terminate();}})()`),localSource));
    assert.deepEqual(unavailable,{remote:'InvalidAccessError',data:{status:200,text:'a€'},blob:{status:200,text:'local'}});
    return ['Isolated static hosts relay synchronous worker XHR without direct requests','Synchronous XHR matches native events, text/binary/JSON responses and multipart uploads','Synchronous worker timeout and network errors reject without truncated success','File hosts support local synchronous blob/data requests while remote synchronous requests remain unavailable'];
  }finally{await Promise.all([native.close(),fixture.close(),fallback.close()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
