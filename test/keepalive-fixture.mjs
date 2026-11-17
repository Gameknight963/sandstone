import {createHash} from 'node:crypto';

export function keepalive_fixture() {
  const requests=[],held=new Map();
  return {
    handle(request,response,url) {
      if (!url.pathname.startsWith('/keepalive/')) return false;
      const client=url.searchParams.get('client'),name=url.searchParams.get('name');
      if(url.pathname.endsWith('/page')||url.pathname.endsWith('/destination')){
        response.writeHead(200,{'Content-Type':'text/html','Referrer-Policy':'unsafe-url','Set-Cookie':'keep_session=own; HttpOnly; SameSite=Lax; Path=/'});
        response.end('<!doctype html><body>Keepalive fixture');return true;
      }
      if(url.pathname.endsWith('/worker.js')){
        response.writeHead(200,{'Content-Type':'application/javascript'});
        response.end('onmessage=()=>{fetch('+JSON.stringify('/keepalive/echo?client='+client+'&name=worker&hold=before')+',{method:"POST",body:"worker saved",keepalive:true}).catch(()=>{});postMessage("started");}');return true;
      }
      const cors={'Access-Control-Allow-Origin':request.headers.origin||'*','Access-Control-Allow-Credentials':'true'};
      if(request.method==='OPTIONS'){response.writeHead(204,{...cors,'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'content-type'});response.end();return true;}
      const chunks=[];
      request.on('data',chunk=>chunks.push(chunk));
      request.on('end',()=>{
        const entry={client,name,method:request.method,origin:request.headers.origin||null,referrer:request.headers.referer||null,
          cookie:(request.headers.cookie||'').split('; ').filter(value=>value.startsWith('keep_')).sort().join('; '),
          type:request.headers['content-type']||'',body:Buffer.concat(chunks),closed:false,aborted:false};
        requests.push(entry);
        response.on('close',()=>{entry.closed=true;entry.aborted=!response.writableEnded;});
        const finish=()=>{if(!response.headersSent)response.writeHead(200,{...cors,'Content-Type':'text/plain'});response.end('reply:'+name);};
        if(url.searchParams.has('hold')){
          held.set(client+':'+name,finish);
          if(url.searchParams.get('hold')!=='before'){response.writeHead(200,{...cors,'Content-Type':'text/plain'});response.flushHeaders();}
        }else finish();
      });
      return true;
    },
    async wait(client,names,closed=false) {
      const deadline=Date.now()+10000;
      while(!names.every(name=>requests.some(value=>value.client===client&&value.name===name&&(!closed||value.closed)))){
        if(Date.now()>deadline)throw new Error('Keepalive requests timed out: '+JSON.stringify(requests.filter(value=>value.client===client).map(({name,closed,aborted})=>({name,closed,aborted}))));
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    },
    release(client,name) { const key=client+':'+name;held.get(key)?.();held.delete(key); },
    async values(client) {
      const values=[];
      for(const value of requests.filter(value=>value.client===client)){
        let body,type=value.type;
        if(type.startsWith('multipart/form-data')){
          const form=await new Response(value.body,{headers:{'Content-Type':type}}).formData();
          body=await Promise.all([...form].map(async([key,value])=>[key,typeof value==='string'?value:{name:value.name,type:value.type,text:await value.text()}]));type='multipart/form-data';
        }else body=value.body.length>200?{size:value.body.length,hash:createHash('sha256').update(value.body).digest('hex')}:value.body.toString();
        values.push({name:value.name,method:value.method,origin:value.origin,
          referrer:value.referrer?.replace('client='+encodeURIComponent(client),'client=CLIENT')||null,cookie:value.cookie,type,body,
          // Chromium may finish an already-uploaded request on its pooled socket
          // after rejecting fetch with AbortError. Compare the observable API.
          ...(value.name==='abort'?{}:{aborted:value.aborted})});
      }
      return values.sort((a,b)=>a.name.localeCompare(b.name));
    }
  };
}

export const keepalive_quota_script=client=>`(async()=>{
  const endpoint=name=>'/keepalive/echo?client='+${JSON.stringify(client)}+'&name='+name;
  const first=fetch(endpoint('quota')+'&hold=1',{method:'POST',body:new Uint8Array(65536),keepalive:true});
  const beacon=navigator.sendBeacon(endpoint('blocked-beacon'),'x');
  const second=await fetch(endpoint('blocked-fetch'),{method:'POST',body:'x',keepalive:true}).then(()=>null,error=>error.name);
  const response=await first;
  window.keepaliveResponse=response;
  return JSON.stringify({beacon,second,status:response.status});
})()`;

export const keepalive_finish_script=client=>`(async()=>{
  const text=await window.keepaliveResponse.text();
  const request=new Request(location.origin+'/keepalive/echo?client='+${JSON.stringify(client)}+'&name=request',{method:'POST',body:'saved Request',keepalive:true});
  const requested=await (await fetch(request)).text();
  let oversized,stream;
  try{await fetch('/keepalive/echo',{method:'POST',body:new Uint8Array(65537),keepalive:true});}catch(error){oversized=error.name;}
  try{await fetch('/keepalive/echo',{method:'POST',body:new ReadableStream(),keepalive:true,duplex:'half'});}catch(error){stream=error.name;}
  return JSON.stringify({text,requested,oversized,stream});
})()`;

export const keepalive_unload_script=client=>`(()=>{
  const endpoint=name=>location.origin+'/keepalive/echo?client='+${JSON.stringify(client)}+'&name='+name+'&hold=before';
  fetch(endpoint('accepted'),{method:'POST',body:'accepted before navigation',keepalive:true}).catch(()=>{});
  const form=new FormData();form.append('message','saved');form.append('file',new Blob(['file data'],{type:'text/plain'}),'saved.txt');
  let sent=false;const leaving=()=>{
    if(sent)return;sent=true;
    fetch(endpoint('unload'),{method:'POST',body:'sent on unload',keepalive:true}).catch(()=>{});
    fetch(endpoint('form'),{method:'POST',body:form,keepalive:true}).catch(()=>{});
    form.set('message','changed');
  };
  addEventListener('pagehide',leaving);addEventListener('unload',leaving);
  return true;
})()`;

export const keepalive_abort_script=client=>`(()=>{
  window.keepaliveAbort=new AbortController();
  window.keepaliveAborted=fetch('/keepalive/echo?client='+${JSON.stringify(client)}+'&name=abort&hold=before',{
    method:'POST',body:'cancel me',keepalive:true,signal:keepaliveAbort.signal
  }).then(()=>null,error=>error.name);
  return true;
})()`;

export const keepalive_worker_script=client=>`new Promise((resolve,reject)=>{
  const worker=window.keepaliveWorker=new Worker('/keepalive/worker.js?client='+${JSON.stringify(client)});
  worker.onmessage=event=>resolve(event.data);worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage('start');
})`;
