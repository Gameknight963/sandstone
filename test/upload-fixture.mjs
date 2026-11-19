import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const size=1024*1024,bytes=new Uint8Array(size);
for(let index=0;index<bytes.length;index++)bytes[index]=index%251;
const digest=createHash('sha256').update(bytes).digest('hex');

export function upload_fixture(request,response,url){
  if(url.pathname!=='/upload-body')return false;
  let length=0;const hash=createHash('sha256');
  request.on('data',chunk=>{length+=chunk.length;hash.update(chunk);});
  request.on('end',()=>{
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    response.end(JSON.stringify({size:length,hash:hash.digest('hex'),type:request.headers['content-type']??null,name:request.headers['x-upload']}));
  });
  return true;
}

export function upload_script(){
  return `(async()=>{
    const buffer=new Uint8Array(${size+16}).fill(251),view=buffer.subarray(7,buffer.length-9),results=[];
    for(let index=0;index<view.length;index++)view[index]=index%251;
    results.push(await(await fetch('/upload-body',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload':'fetch'},body:view})).json());
    results.push(await(await fetch(new Request('/upload-body',{method:'POST',headers:{'X-Upload':'request'},body:new Blob([view],{type:'application/octet-stream'})}))).json());
    results.push(await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/upload-body');xhr.responseType='json';xhr.setRequestHeader('X-Upload','xhr');xhr.onload=()=>resolve(xhr.response);xhr.onerror=()=>reject(new Error('Upload XHR failed'));xhr.send(view);}));
    return JSON.stringify(results);
  })()`;
}

export function verify_uploads(results){
  assert.deepEqual(results,['fetch','request','xhr'].map(name=>({size,hash:digest,type:name==='xhr'?null:'application/octet-stream',name})));
}

export async function verify_relay_uploads(page,origin,native){
  await page.evaluate(()=>{
    const session=sandstone.network.session;globalThis.uploadMetrics=[];globalThis.uploadRequestAsync=session.request_async;
    session.request_async=function(url,params,body){
      if(url.endsWith('/upload-body'))uploadMetrics.push({body:body.byteLength,metadata:JSON.stringify(params).length});
      return uploadRequestAsync.call(this,url,params,body);
    };
  });
  try{
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),upload_script()));
    verify_uploads(actual);assert.deepEqual(actual,native,'Large Fetch/Request/XHR uploads differ from native');
    const direct=await page.evaluate(async origin=>{
      const body=new Uint8Array(1024*1024);for(let index=0;index<body.length;index++)body[index]=index%251;
      return(await sandstone.network.session.fetch(origin+'/upload-body',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Upload':'fetch'},body})).json();
    },origin);
    assert.deepEqual(direct,native[0]);
    const metrics=await page.evaluate(()=>uploadMetrics);assert.equal(metrics.length,4);
    assert.ok(metrics.every(value=>value.body===size&&value.metadata<1024),'Upload bytes expanded into native request metadata');
  }finally{
    await page.evaluate(()=>{sandstone.network.session.request_async=uploadRequestAsync;delete globalThis.uploadRequestAsync;delete globalThis.uploadMetrics;});
  }
}
