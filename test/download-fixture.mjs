import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const bytes=Buffer.from([68,111,119,110,108,111,97,100,10,0,1,255]);
export const download_cases=['blob','revoked-blob','detached-revoked-blob','data','attribute','header','unicode','encoded','inline','attachment','binary','fallback','redirect','noreferrer','policy','detached','shadow','history'];

export function download_fixture(){
  const requests=[];
  return {
    handle(request,response,url){
      if(!url.pathname.startsWith('/downloads/'))return false;
      const client=url.searchParams.get('client'),name=url.searchParams.get('name');
      if(url.pathname.endsWith('/page')){
        response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Referrer-Policy':'unsafe-url','Set-Cookie':'download_session=own; HttpOnly; SameSite=Strict; Path=/downloads/'});
        response.end('<!doctype html><body><p id="download-marker">Original document</p><script>window.downloadMarker="original";</script>');return true;
      }
      requests.push({client,name,method:request.method,origin:request.headers.origin||null,referrer:request.headers.referer||null,
        cookies:(request.headers.cookie||'').split('; ').filter(value=>value.startsWith('download_')).sort()});
      if(url.pathname.endsWith('/view')){
        response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><body><p id="cross-view">Cross-origin navigation</p>');return true;
      }
      if(url.pathname.endsWith('/redirect')){
        response.writeHead(302,{Location:'/downloads/renamed.txt?client='+encodeURIComponent(client)+'&name=redirect-final','Set-Cookie':'download_redirect=seen; Path=/downloads/'});response.end();return true;
      }
      const headers={'Content-Type':name==='binary'?'application/zip':name==='attachment'?'application/octet-stream':'text/plain','Set-Cookie':'download_seen='+name+'; Path=/downloads/'};
      if(name==='header')headers['Content-Disposition']='attachment; filename="server.txt"';
      if(name==='unicode')headers['Content-Disposition']='attachment; filename="fallback.txt"; filename*=UTF-8\'\'caf%C3%A9.txt';
      if(name==='encoded')headers['Content-Disposition']='attachment; filename="caf%C3%A9%20report.txt"';
      if(name==='inline')headers['Content-Disposition']='inline; filename="inline.txt"';
      if(name==='attachment')headers['Content-Disposition']='attachment; filename="attachment.bin"';
      response.writeHead(200,headers);response.end(bytes);return true;
    },
    values(client){return requests.filter(value=>value.client===client).map(({client,...value})=>({...value,referrer:value.referrer?.replace('client='+encodeURIComponent(client),'client=CLIENT')||null}));}
  };
}

export const prepare_downloads=client=>`(()=>{
  const endpoint=name=>'/downloads/file?client='+${JSON.stringify(client)}+'&name='+name;
  window.downloadLinks={};
  for(const name of ${JSON.stringify(download_cases)}){
    const link=document.createElement('a');link.id='download-'+name;link.textContent=name;link.href=endpoint(name);
    if(!['attachment','binary'].includes(name))link.download=name+'.txt';
    if(name==='attribute'||name==='header'||name==='unicode'||name==='inline')link.download='client.txt';
    if(name==='fallback'){link.href='/downloads/fallback%20name.txt?client='+${JSON.stringify(client)}+'&name=fallback';link.download='';}
    if(name==='binary')link.href='/downloads/archive.zip?client='+${JSON.stringify(client)}+'&name=binary';
    if(name==='redirect'){link.href='/downloads/redirect?client='+${JSON.stringify(client)}+'&name=redirect';link.download='';}
    if(name==='noreferrer')link.rel='noreferrer';
    if(name==='policy')link.referrerPolicy='origin';
    if(name==='blob'||name.endsWith('revoked-blob'))link.href=URL.createObjectURL(new Blob(['local blob'],{type:'text/plain'}));
    if(name==='data')link.href='data:text/plain;charset=UTF-8,local%20data';
    if(name==='shadow'){const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).append(link);}
    else if(name!=='detached'&&name!=='detached-revoked-blob')document.body.append(link);
    downloadLinks[name]=link;
  }
  const canceled=document.createElement('a');canceled.href=endpoint('canceled');canceled.download='canceled.txt';canceled.addEventListener('click',event=>event.preventDefault());document.body.append(canceled);downloadLinks.canceled=canceled;
  const button=document.createElement('button');button.id='download-trigger';button.textContent='Export';button.onclick=()=>{const link=downloadLinks[window.downloadAction];link.click();if(window.downloadAction.endsWith('revoked-blob'))URL.revokeObjectURL(link.href);};document.body.append(button);
  return true;
})()`;

export async function verify_downloads(page,evaluate,client,activate){
  await evaluate(prepare_downloads(client));
  const results=[];
  for(const name of download_cases){
    // Exercise separate user exports rather than a burst that Chromium's
    // per-document download limiter can suppress before Playwright sees it.
    await new Promise(resolve=>setTimeout(resolve,300));
    if(name==='history')await evaluate('history.pushState({},"",'+JSON.stringify('/downloads/route?client='+client)+');true');
    const pending=page.waitForEvent('download',{timeout:10000}).catch(error=>{throw new Error('Download did not start: '+name,{cause:error});});
    await evaluate('window.downloadAction='+JSON.stringify(name)+';true');await activate();
    const download=await pending;
    assert.equal(await download.failure(),null,name);
    const content=await readFile(await download.path());
    const expected=name==='blob'||name.endsWith('revoked-blob')?Buffer.from('local blob'):name==='data'?Buffer.from('local data'):bytes;
    assert.deepEqual(content,expected,'Downloaded bytes differ for '+name);
    results.push({name,filename:download.suggestedFilename(),body:content.toString('base64')});
    assert.equal(await evaluate('downloadMarker'),'original','A download replaced the original document');
    if(!['blob','data'].includes(name)&&!name.endsWith('revoked-blob')){
      const seen=name==='redirect'?'redirect-final':name,deadline=Date.now()+2000;
      while(!await evaluate('document.cookie.split("; ").includes('+JSON.stringify('download_seen='+seen)+')')){
        if(Date.now()>deadline)throw new Error('Download response cookies were not reflected in the original page: '+name);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
  }
  let canceled=0;const listener=()=>{canceled++;};page.on('download',listener);
  try{await evaluate('window.downloadAction="canceled";true');await activate();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(canceled,0,'Canceled link triggered a download');}
  finally{page.off('download',listener);}
  return results;
}
