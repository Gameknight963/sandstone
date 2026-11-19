import assert from 'node:assert/strict';

export function module_requests_fixture(){
  const requests=[];
  const target=(origin,client,scope,cross=false)=>origin.replace('127.0.0.1',cross?'localhost':'127.0.0.1')+'/module-requests/redirect?'+new URLSearchParams({client,scope});
  const worker=(origin,client,scope)=>`onmessage=async()=>{try{
    const values=[];for(const cross of [false,true]){
      const url=${JSON.stringify(target(origin,client,scope))}.replace('127.0.0.1',cross?'localhost':'127.0.0.1');
      const code=await import(url),data=await import(url,{with:{type:'json'}});
      values.push([code.default.value,data.default.value,(await import(url,{with:{type:'json'}})).default===data.default]);
    }postMessage({values});
  }catch(error){postMessage({error:error.stack})}};`;
  const page=(origin,client)=>{
    let read='';
    for(const [index,cross] of [false,true].entries()){
      const url=JSON.stringify(target(origin,client,'page',cross));
      read+=`{const code=await import(${url}),data=await import(${url},{with:{type:'json'}}),sheet=await import(${url},{with:{type:'css'}});values.push([code.default.value,data.default.value,sheet.default.cssRules[0].style.color,(await import(${url},{with:{type:'json'}})).default===data.default]);}`;
    }
    const cross=JSON.stringify(target(origin,client,'page',true));
    return '<!doctype html><body><script type="module" onerror="globalThis.moduleRequestFailure=true">'+`try{const values=[];${read}
      const cachedJSON=await (await fetch(${cross},{headers:{Accept:'application/json,*/*;q=0.5'}})).json();
      const cachedCSS=await (await fetch(${cross},{headers:{Accept:'text/css,*/*;q=0.1'}})).text();
      globalThis.moduleRequestResult={values,cached:[cachedJSON.value,cachedCSS.includes('color:rgb(17,34,51)')]};
    }catch(error){globalThis.moduleRequestFailure=true;console.error(error)}</script>`;
  };
  const normalized=value=>{if(!value)return null;const url=new URL(value);url.searchParams.delete('client');return url.href;};
  return {
    handle(request,response,url){
      if(!url.pathname.startsWith('/module-requests/'))return false;
      const client=url.searchParams.get('client'),scope=url.searchParams.get('scope')||'page',origin='http://'+request.headers.host;
      const headers={'Access-Control-Allow-Origin':request.headers.origin||'*','Content-Type':'text/javascript'};
      if(url.pathname.endsWith('/page')){response.writeHead(200,{...headers,'Content-Type':'text/html'});response.end(page(origin,client));return true;}
      if(url.pathname.endsWith('/worker.js')){response.writeHead(200,headers);response.end(worker(origin,client,scope));return true;}
      requests.push({client,scope,path:url.pathname,host:request.headers.host,accept:request.headers.accept??null,origin:request.headers.origin??null,referrer:normalized(request.headers.referer)});
      if(url.pathname.endsWith('/redirect')){response.writeHead(302,{...headers,Vary:'Accept','Cache-Control':'no-store',Location:'/module-requests/representation'+url.search});response.end();return true;}
      const accept=request.headers.accept||'';
      const [type,body]=accept.startsWith('application/json')?['application/json','{"value":22}']:accept.startsWith('text/css')?['text/css','body{color:rgb(17,34,51)}']:['text/javascript','export default {value:11};'];
      response.writeHead(200,{...headers,'Content-Type':type,Vary:'Accept','Cache-Control':'max-age=3600'});response.end(body);return true;
    },
    values(client){return requests.filter(row=>row.client===client).map(({client,...row})=>row).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));},
    // Browser cache reuse can differ; compare headers for each distinct request
    // profile and verify the selected representations separately.
    profiles(client){return [...new Set(this.values(client).map(row=>JSON.stringify(row)))].sort().map(row=>JSON.parse(row));}
  };
}

export async function verify_module_requests(navigate,evaluate,origin,client){
  await navigate(origin+'/module-requests/page?'+new URLSearchParams({client}));
  const result=await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const check=()=>{if(globalThis.moduleRequestResult)resolve(globalThis.moduleRequestResult);else if(globalThis.moduleRequestFailure||Date.now()>deadline)reject(new Error('Negotiated module representations did not initialize'));else setTimeout(check,20)};check()})`);
  assert.deepEqual(result,{values:[[11,22,'rgb(17, 34, 51)',true],[11,22,'rgb(17, 34, 51)',true]],cached:[22,true]});
  const workers=[];
  for(const type of ['classic','module']){
    const url=origin+'/module-requests/worker.js?'+new URLSearchParams({client,scope:type});
    const result=await evaluate(`new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(url)},{type:${JSON.stringify(type)}});const timer=setTimeout(()=>{worker.terminate();reject(new Error('Negotiated worker modules timed out'))},10000);worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);worker.terminate();reject(new Error(event.message))};worker.postMessage(true)})`);
    assert.deepEqual(result,{values:[[11,22,true],[11,22,true]]});workers.push(result);
  }
  return {result,workers};
}
