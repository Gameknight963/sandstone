import assert from 'node:assert/strict';

export function empty_headers_fixture(request,response,url){
  if(url.pathname!=='/empty-headers')return false;
  const chunks=[];
  request.on('data',chunk=>chunks.push(chunk));
  request.on('end',()=>{
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    response.end(JSON.stringify({method:request.method,accept:request.headers.accept??null,type:request.headers['content-type']??null,empty:request.headers['x-empty']??null,value:request.headers['x-value']??null,body:Buffer.concat(chunks).toString()}));
  });
  return true;
}

export function empty_headers_script(origin,client){
  return `(async()=>{
    const url=${JSON.stringify(origin+'/empty-headers?client='+client)},results=[];
    const read=async(input,options)=>results.push(await (await fetch(input,options)).json());
    await read(url);
    await read(url,{headers:{Accept:''}});
    await read(url,{method:'POST',body:'payload',headers:{Accept:'','Content-Type':'','X-Empty':'','X-Value':'sent'}});
    await read(new Request(url,{headers:new Headers([['X-Empty',''],['X-Value','request']])}));
    results.push(await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',url);xhr.responseType='json';for(const [key,value] of Object.entries({Accept:'','Content-Type':'','X-Empty':'','X-Value':'xhr'}))xhr.setRequestHeader(key,value);xhr.onload=()=>resolve(xhr.response);xhr.onerror=()=>reject(new Error('Empty-header XHR failed'));xhr.send('xhr payload')}));
    await read(url,{method:'POST',body:new Uint8Array([98,105,110]),headers:{'X-Value':'binary'}});
    await read(url,{method:'POST',body:new Blob(['blob']),headers:{'X-Value':'blob'}});
    await read(url,{method:'POST',body:'text',headers:{'X-Value':'string'}});
    return results;
  })()`;
}

export function verify_empty_headers(results){
  assert.deepEqual(results,[
    {method:'GET',accept:'*/*',type:null,empty:null,value:null,body:''},
    {method:'GET',accept:'',type:null,empty:null,value:null,body:''},
    {method:'POST',accept:'',type:'',empty:'',value:'sent',body:'payload'},
    {method:'GET',accept:'*/*',type:null,empty:'',value:'request',body:''},
    {method:'POST',accept:'',type:'',empty:'',value:'xhr',body:'xhr payload'},
    {method:'POST',accept:'*/*',type:null,empty:null,value:'binary',body:'bin'},
    {method:'POST',accept:'*/*',type:null,empty:null,value:'blob',body:'blob'},
    {method:'POST',accept:'*/*',type:'text/plain;charset=UTF-8',empty:null,value:'string',body:'text'}
  ]);
}
