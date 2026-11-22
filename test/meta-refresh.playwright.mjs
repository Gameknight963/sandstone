import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verifyMetaRefresh(page){
  const origin='https://meta-refresh.test',native=await page.context().newPage(),nativeRequests=[];
  const direct=[],onRequest=request=>{if(request.url().startsWith(origin))direct.push(request.url());};
  page.on('request',onRequest);
  const cases=[
    {content:'0',target:'/deep/page?q=1'},
    {content:'0; URL = "next?q=2"',target:'/base/next?q=2'},
    {content:".1, '/done'",target:'/done'},
    {content:'0 /plain',target:'/plain'},
    {content:'garbage',target:null},
    {content:'-1;url=/invalid',target:null}
  ];
  await native.route(origin+'/**',route=>{
    if(route.request().resourceType()!=='document')return route.fulfill({status:204});
    const path=new URL(route.request().url()).pathname+new URL(route.request().url()).search;
    nativeRequests.push(path);
    return route.fulfill({contentType:'text/html',body:nativeRequests.length===1?nativeBody:'<!doctype html><title>Done</title>'});
  });
  let nativeBody;
  try{
    await page.evaluate(origin=>{
      globalThis.refreshPrevious=sandstone.network.session.fetch;
      globalThis.refreshRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        const parsed=new URL(url);
        if(parsed.origin!==origin)return refreshPrevious(url,options);
        if(parsed.pathname==='/favicon.ico')return Promise.resolve(new Response(null,{status:204}));
        refreshRequests.push(parsed.pathname+parsed.search);
        return Promise.resolve(new Response(refreshRequests.length===1?refreshBody:'<!doctype html><title>Done</title>',{headers:{'content-type':'text/html'}}));
      };
    },origin);
    for(const entry of cases){
      const escaped=entry.content.replaceAll('&','&amp;').replaceAll('"','&quot;');
      nativeBody='<!doctype html><base href="/base/"><meta http-equiv="refresh" content="'+escaped+'"><title>Initial</title>';
      nativeRequests.length=0;
      await native.goto(origin+'/deep/page?q=1');
      await page.evaluate(async({origin,html})=>{refreshRequests=[];globalThis.refreshBody=html;await main_frame.navigate_to(origin+'/deep/page?q=1');},{origin,html:nativeBody});
      if(entry.target){
        await wait_for(async()=>nativeRequests.length>=2&&await page.evaluate(()=>refreshRequests.length>=2));
        assert.equal(nativeRequests[1],entry.target,entry.content);
        assert.deepEqual(await page.evaluate(()=>refreshRequests.slice(0,2)),nativeRequests.slice(0,2),entry.content);
      }else{
        await native.waitForTimeout(150);
        assert.equal(nativeRequests.length,1,entry.content);
        assert.equal(await page.evaluate(()=>refreshRequests.length),1,entry.content);
      }
    }
    assert.deepEqual(direct,[],'A refresh bypassed the relay');
    return ['Meta refresh parsing, current-document reloads and base URL targets match Chromium'];
  }finally{
    page.off('request',onRequest);
    await page.evaluate(()=>{sandstone.network.session.fetch=refreshPrevious;delete globalThis.refreshPrevious;delete globalThis.refreshBody;delete globalThis.refreshRequests;});
    await native.close();
  }
}
