async page => {
  const equal=(actual,expected)=>{
    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('XHR expected '+JSON.stringify(expected)+', got '+JSON.stringify(actual));
  };
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const read=async source=>JSON.parse(await evaluate(`(async()=>JSON.stringify(await (${source})))()`));
  await page.evaluate(async ()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.xhrRequests=[];
    globalThis.xhrCancellations=[];
    sandstone.network.session.fetch=async (url,options)=>{
      const path=new URL(url).pathname;
      if(!path.startsWith('/xhr-fixture/')) return previous(url,options);
      xhrRequests.push({url,headers:options.headers,method:options.method,body:options.body ? [...new Uint8Array(options.body)]:null});
      if(path.endsWith('/broken')) throw new TypeError('Fixture network failure');
      if(path.endsWith('/delay')) return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>resolve(new Response('late')),1000);
        options.signal.addEventListener('abort',()=>{clearTimeout(timer);xhrCancellations.push('headers');reject(new DOMException('Aborted','AbortError'));},{once:true});
      });
      if(path.endsWith('/stall')) return new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode('partial'));},
        cancel(){xhrCancellations.push('body');}
      }));
      if(path.endsWith('/stream')) return new Response(new ReadableStream({
        start(controller){
          controller.enqueue(new Uint8Array([65,0xe2]));
          setTimeout(()=>{controller.enqueue(new Uint8Array([0x82,0xac,66]));controller.close();},80);
        }
      }),{headers:{'Content-Type':'text/plain;charset=utf-8','Content-Length':'5'}});
      if(path.endsWith('/xml')) return new Response('<?xml version="1.0"?><root><value>42</value></root>',{headers:{'Content-Type':'application/xml'}});
      if(path.endsWith('/bad-xml')) return new Response('<root>',{headers:{'Content-Type':'application/xml'}});
      if(path.endsWith('/html')) return new Response('<!doctype html><title>XHR document</title><h1>Parsed</h1>',{headers:{'Content-Type':'text/html'}});
      if(path.endsWith('/latin')) return new Response(new Uint8Array([99,97,102,233]),{headers:{'Content-Type':'text/plain'}});
      if(path.endsWith('/bad-json')) return new Response('invalid',{headers:{'Content-Type':'application/json'}});
      if(path.endsWith('/binary')) return new Response(new Uint8Array([7,8,9]),{headers:{'Content-Type':'application/octet-stream'}});
      return new Response('{"value":42}',{status:path.endsWith('/missing')?404:200,headers:{'Content-Type':'application/json','X-Result':'yes'}});
    };
    main_frame.special_pages['https://fixture.test/xhr-fixture/page']='<!doctype html><base href="/xhr-fixture/base/"><body>XHR fixture</body>';
    await main_frame.navigate_to('https://fixture.test/xhr-fixture/page');
  });
  const json=await read(`new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),events=[];
    const upload=xhr.upload;
    xhr.onreadystatechange=()=>events.push(xhr.readyState);
    xhr.open('GET','json');xhr.responseType='json';
    xhr.onload=function(event){
      resolve({value:xhr.response.value,same:xhr.response===xhr.response,status:xhr.status,url:xhr.responseURL,
        receiver:this===xhr,target:event.target===xhr,events,header:xhr.getResponseHeader('X-Result'),
        upload:upload===xhr.upload && upload instanceof XMLHttpRequestUpload && xhr instanceof XMLHttpRequestEventTarget,
        constants:[XMLHttpRequest.DONE,xhr.OPENED]});
    };
    xhr.onerror=()=>reject(new Error('JSON XHR failed'));xhr.send();
  })`);
  equal(json,{value:42,same:true,status:200,url:'https://fixture.test/xhr-fixture/base/json',receiver:true,target:true,
    events:[1,2,3,4],header:'yes',upload:true,constants:[4,1]});
  equal(await read(`new Promise(resolve=>{
    const xhr=new XMLHttpRequest();xhr.open('GET','bad-json');xhr.responseType='json';xhr.onload=()=>resolve(xhr.response);xhr.send();
  })`),null);
  const streamed=await read(`new Promise(resolve=>{
    const xhr=new XMLHttpRequest(),partial=[],progress=[];
    xhr.onreadystatechange=()=>{if(xhr.readyState===3)partial.push(xhr.responseText);};
    xhr.onprogress=event=>progress.push([event.loaded,event.total,event.lengthComputable]);
    xhr.open('GET','stream');xhr.onload=()=>resolve({text:xhr.responseText,partial,progress});xhr.send();
  })`);
  equal(streamed.text,'A€B');
  if(!streamed.partial[0].startsWith('A') || streamed.partial.at(-1)!=='A€B') throw new Error('Partial XHR text failed: '+JSON.stringify(streamed));
  equal(streamed.progress.at(-1),[5,5,true]);
  const documents=await read(`(async()=>{
    const request=(path,type='')=>new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET',path);xhr.responseType=type;xhr.onload=()=>resolve(xhr);xhr.send();});
    const xml=await request('xml'),html=await request('html','document'),bad=await request('bad-xml');
    return {xml:xml.responseXML.querySelector('value').textContent,uri:xml.responseXML.documentURI,
      html:html.response.title,heading:html.response.querySelector('h1').textContent,
      same:html.response===html.responseXML,bad:bad.responseXML};
  })()`);
  equal(documents,{xml:'42',uri:'https://fixture.test/xhr-fixture/base/xml',html:'XHR document',heading:'Parsed',same:true,bad:null});
  const binary=await read(`(async()=>{
    const request=(path,type,override)=>new Promise(resolve=>{
      const xhr=new XMLHttpRequest();xhr.open('GET',path);xhr.responseType=type;if(override)xhr.overrideMimeType(override);
      xhr.onload=()=>resolve(xhr);xhr.send();
    });
    const bytes=await request('binary','arraybuffer'),blob=await request('binary','blob'),text=await request('latin','','text/plain;charset=windows-1252');
    let error;try{bytes.responseText;}catch(value){error=value.name;}
    return {bytes:Array.from(new Uint8Array(bytes.response)),blob:Array.from(new Uint8Array(await blob.response.arrayBuffer())),
      type:blob.response.type,same:blob.response===blob.response,text:text.responseText,error};
  })()`);
  equal(binary,{bytes:[7,8,9],blob:[7,8,9],type:'application/octet-stream',same:true,text:'café',error:'InvalidStateError'});
  const upload=await read(`new Promise(resolve=>{
    const xhr=new XMLHttpRequest(),events=[];
    for(const type of ['loadstart','progress','load','loadend'])xhr.upload.addEventListener(type,event=>events.push([type,event.loaded]));
    xhr.open('POST','upload');xhr.setRequestHeader('X-Test','one');xhr.setRequestHeader('X-Test','two');
    const body=new FormData();body.append('field','value');body.append('file',new Blob(['file-data']),'test.txt');
    xhr.onload=()=>resolve(events);xhr.send(body);
  })`);
  equal(upload.map(event=>event[0]),['loadstart','progress','load','loadend']);
  const submitted=await page.evaluate(()=>xhrRequests.find(request=>request.url.endsWith('/upload')));
  if(!submitted.headers['content-type'].startsWith('multipart/form-data; boundary=') ||
    !new TextDecoder().decode(new Uint8Array(submitted.body)).includes('filename="test.txt"')) throw new Error('XHR FormData serialization failed');
  equal(upload.at(-1)[1],submitted.body.length);equal(submitted.headers['x-test'],'one, two');
  const failures=await read(`(async()=>{
    const run=(path,timeout=0,abort=false)=>new Promise(resolve=>{
      const xhr=new XMLHttpRequest(),events=[];
      xhr.open('GET',path);xhr.timeout=timeout;
      for(const type of ['error','abort','timeout','load','loadend'])xhr.addEventListener(type,()=>events.push([type,xhr.readyState,xhr.status]));
      xhr.onloadend=()=>setTimeout(()=>resolve({events,state:xhr.readyState,text:xhr.responseText}),0);
      if(abort)xhr.onreadystatechange=()=>{if(xhr.readyState===3)xhr.abort();};
      xhr.send();
    });
    return {timeout:await run('delay',30),abort:await run('stall',0,true),network:await run('broken'),missing:await run('missing')};
  })()`);
  equal(failures.timeout,{events:[['timeout',4,0],['loadend',4,0]],state:4,text:''});
  equal(failures.abort,{events:[['abort',4,0],['loadend',4,0]],state:0,text:''});
  equal(failures.network,{events:[['error',4,0],['loadend',4,0]],state:4,text:''});
  equal(failures.missing,{events:[['load',4,404],['loadend',4,404]],state:4,text:'{"value":42}'});
  await page.waitForFunction(()=>xhrCancellations.includes('headers') && xhrCancellations.includes('body'));
  const worker=await read(`new Promise((resolve,reject)=>{
    const source="onmessage=()=>{const xhr=new XMLHttpRequest();xhr.open('GET','https://fixture.test/xhr-fixture/base/json');xhr.responseType='document';const ignored=xhr.responseType==='';xhr.responseType='json';xhr.onload=()=>postMessage({value:xhr.response.value,ignored});xhr.send();};";
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const worker=new Worker(url);
    worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage('start');
  })`);
  equal(worker,{value:42,ignored:true});
  return ['XHR JSON/binary/XML/HTML response types','XHR partial text and byte progress','XHR multipart uploads and event identity',
    'XHR abort/timeout/network error lifecycle through the relay','XHR in web workers'];
}
