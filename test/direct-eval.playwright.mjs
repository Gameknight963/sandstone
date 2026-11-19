import assert from 'node:assert/strict';
import {directEvalCases} from './direct-eval-cases.mjs';

export async function verifyDirectEval(page,{batch=0,batches=1}={}){
  const origin='https://direct-eval.test',requests=[],direct=[];
  const cases=directEvalCases.filter((_,index)=>index%batches===batch);
  const pages=Object.fromEntries(cases.map((example,index)=>['/case-'+index,
    '<!doctype html><script>try{'+(example.program?example.source:'window.result={value:('+example.source+')}')+'}catch(error){window.result={error:error.name}}<\/script>']));
  const worker='onmessage=async({data:value})=>{try{postMessage(await eval("fetch(\'./data\').then(r=>r.json()).then(data=>[value,data.value,location.pathname])"))}catch(error){postMessage({error:error.name})}}';
  const aliasWorker='onmessage=async({data:value})=>{try{const read=Function("eval","value",\'return eval("fetch(\\\'./data\\\').then(r=>r.json()).then(data=>[value,data.value,location.pathname])")\');postMessage(await read(globalThis.eval,value))}catch(error){postMessage({error:error.name})}}';
  const resources={
    '/network/start':['text/html','<!doctype html><body>Eval network fixture'],
    '/network/data':['application/json','{"value":7}'],
    '/network/module.js':['text/javascript','export const value=7;'],
    '/network/worker.js':['text/javascript',worker],
    '/network/alias-worker.js':['text/javascript',aliasWorker]
  };
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const record=request=>{if(request.url().startsWith(origin+'/'))direct.push(request.url());};
  page.on('request',record);
  await context.route(origin+'/**',route=>{
    const path=new URL(route.request().url()).pathname,[contentType,body]=resources[path]||['text/html',pages[path]||'<!doctype html>'];
    // Playwright itself evaluates through window.eval. A script-level eval
    // declaration may replace it; restore it after recording the native result.
    const nativeBody=cases[Number(path.slice('/case-'.length))]?.program&&path.startsWith('/case-')?
      body.replace('<script>','<script>const __fixture_native_eval__=window.eval;').replace('<\/script>',';window.eval=__fixture_native_eval__;<\/script>'):body;
    return route.fulfill({contentType,body:nativeBody});
  });
  try{
    await page.evaluate(({origin,pages,resources})=>{
      globalThis.__eval_fixture_fetch__=sandstone.network.session.fetch;globalThis.__eval_fixture_requests__=[];
      sandstone.network.session.fetch=(target,options)=>{
        const path=new URL(target);if(path.origin!==origin)return __eval_fixture_fetch__(target,options);
        __eval_fixture_requests__.push(path.pathname);
        const [type,body]=resources[path.pathname]||['text/html',pages[path.pathname]||'<!doctype html>'];
        return Promise.resolve(new Response(body,{headers:{'Content-Type':type}}));
      };
    },{origin,pages,resources});
    for(let index=0;index<cases.length;index++){
      const address=origin+'/case-'+index;
      await native.goto(address);const expected=await native.evaluate(()=>JSON.stringify(window.result));
      await page.evaluate(address=>main_frame.navigate_to(address),address);
      assert.equal(await page.evaluate(()=>main_frame.url.href),address,'Eval navigated the document: '+cases[index].name);
      const actual=await page.evaluate(()=>main_frame.eval_js('JSON.stringify(window.result)'));
      assert.equal(actual,expected,'Direct eval native parity: '+cases[index].name);
    }
    if(batch===batches-1){
      const address=origin+'/network/start';
      await native.goto(address);await page.evaluate(address=>main_frame.navigate_to(address),address);
      const source='(async()=>{function read(eval,value){return eval("fetch(\'./data\').then(r=>r.json()).then(data=>[value,data.value])")}function imported(eval,value){return eval("import(\'./module.js\').then(module=>module.value+value)")}const workers=[];for(const [type,url] of [["classic","./worker.js"],["module","./worker.js"],["classic","./alias-worker.js"],["module","./alias-worker.js"]])workers.push(await new Promise((resolve,reject)=>{const worker=new Worker(url,{type});worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=reject;worker.postMessage(7)}));return JSON.stringify({fetch:await read(globalThis.eval,7),imported:await imported(globalThis.eval,7),generated:Function("eval","value",\'return eval("value")\')(globalThis.eval,7),workers,aliasSource:read.toString(),source:eval("(function authored(value){return value})").toString()})})()';
      await native.addScriptTag({content:"globalThis.__eval_result__=("+source+");"});
      const expected=await native.evaluate(()=>__eval_result__);
      const actual=await page.evaluate(source=>main_frame.eval_js(source),source);
      assert.equal(actual,expected,'Eval network, worker and source identity parity');
      requests.push(...await page.evaluate(()=>__eval_fixture_requests__));
      for(const path of ['/network/data','/network/module.js','/network/worker.js'])assert.ok(requests.includes(path),'Missing relayed eval resource '+path);
      assert.deepEqual(direct,[],'Eval resources bypassed the relay');
    }
    return ['Direct eval caller scope, declarations, contextual syntax and native completion (batch '+(batch+1)+')',
      ...(batch===batches-1?['Eval Fetch, dynamic imports, classic/module workers and function source identity stay behind the relay']:[])];
  }finally{
    await page.evaluate(()=>{sandstone.network.session.fetch=__eval_fixture_fetch__;delete globalThis.__eval_fixture_fetch__;delete globalThis.__eval_fixture_requests__;});
    page.off('request',record);await context.close();
  }
}
