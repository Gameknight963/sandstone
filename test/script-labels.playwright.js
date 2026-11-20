async page=>{
  const origin='https://fixture.test',start=origin+'/script-labels/index';
  // This is the stack-based asset lookup used by bundlers such as Parcel.
  const capture=String.raw`
    function scriptFile(){const match=new Error().stack.match(/https?:\/\/[^)\s]+/);return match?.[0].replace(/:\d+:\d+$/,'')||null;}
    function scriptBase(){function first(){return second();}function second(){return third();}function third(){
      const files=new Error().stack.match(/https?:\/\/[^)\n]+/g);return files?.[2]?.replace(/\/[^/]+$/,'/')||null;
    }return first();}
  `;
  const sample=key=>capture+`globalThis.stackLabels??={};stackLabels[${JSON.stringify(key)}]={file:scriptFile(),base:scriptBase()};`;
  const sources={
    '/script-labels/assets/classic.js':sample('classic'),
    '/script-labels/assets/redirected.js':sample('redirect'),
    '/script-labels/assets/named.js':sample('named')+'\n//# sourceURL= https://authored.test/chunks/custom.js  ',
    '/script-labels/assets/legacy.js':sample('legacy')+'\n//@ sourceURL=https://authored.test/legacy.js',
    '/script-labels/assets/marker.js':'const marker="//# sourceURL=https://fake.test/ignored.js";'+sample('marker'),
    '/script-labels/assets/module.mjs':sample('module'),
    '/script-labels/assets/worker.js':capture+`postMessage({kind:'classic',file:scriptFile(),base:scriptBase()});importScripts('./imported.js');`,
    '/script-labels/assets/imported.js':capture+`postMessage({kind:'imported',file:scriptFile(),base:scriptBase()});`,
    '/script-labels/assets/worker.mjs':`import {sample} from './module-dep.mjs';postMessage({kind:'module',...sample()});`,
    '/script-labels/assets/module-dep.mjs':capture+`export function sample(){return {file:scriptFile(),base:scriptBase()};}`
  };
  const html='<!doctype html><base href="/different-base/"><body>'+Object.keys(sources).slice(0,6).map(path=>
    '<script '+(path.endsWith('.mjs')?'type="module" ':'')+'src="'+(path.endsWith('redirected.js')?'/script-labels/redirect':path)+'"></script>'
  ).join('')+'<script>'+sample('inline')+'<\/script>';
  const nativeContext=await page.context().browser().newContext();
  const diagnostics=[];
  // Playwright routing does not intercept redirect follow-ups. Compare native
  // execution of the final script URL; the relay side exercises the 302 chain.
  const nativeHTML=html.replace('src="/script-labels/redirect"','src="/script-labels/assets/redirected.js"');
  await nativeContext.route(origin+'/script-labels/**',route=>{
    const path=new URL(route.request().url()).pathname;
    diagnostics.push(path);
    return route.fulfill({contentType:path.endsWith('/index')?'text/html':'application/javascript',body:path.endsWith('/index')?nativeHTML:sources[path]||''});
  });
  const native=await nativeContext.newPage();
  const stage=value=>console.log(JSON.stringify({fixture:'Script filenames',stage:value}));
  const workerLog=message=>{if(message.text().startsWith('SCRIPT_LABEL '))stage(message.text());};
  page.on('console',workerLog);native.on('console',workerLog);
  native.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
  native.on('requestfailed',request=>diagnostics.push({url:request.url(),error:request.failure()}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const snapshot=async proxy=>JSON.parse(await evaluate(proxy,`(async()=>{
    const workers={};
    console.log('SCRIPT_LABEL '+${JSON.stringify(proxy?'proxy':'native')}+' snapshot started');
    for(const [path,type,count] of [['worker.js','classic',2],['worker.mjs','module',1]]){
      await new Promise((resolve,reject)=>{
        const worker=new Worker('${origin}/script-labels/assets/'+path,{type});let received=0;
        console.log('SCRIPT_LABEL '+${JSON.stringify(proxy?'proxy':'native')}+' constructed '+path);
        const timer=setTimeout(()=>{console.log('SCRIPT_LABEL worker timeout '+path);worker.terminate();reject(new Error('Stack label worker timed out: '+path));},10000);
        worker.onmessage=event=>{console.log('SCRIPT_LABEL message '+event.data.kind);workers[event.data.kind]=event.data;if(++received===count){clearTimeout(timer);worker.terminate();resolve();}};
        worker.onerror=event=>{console.log('SCRIPT_LABEL worker error '+path+': '+event.message);clearTimeout(timer);event.preventDefault();worker.terminate();reject(new Error(event.message));};
      });
    }
    return JSON.stringify({scripts:stackLabels,workers});
  })()`));
  try{
    stage('native navigation');await native.goto(start);
    stage('native workers');const expected=await snapshot(false);
    stage('proxy navigation');
    await page.evaluate(async({origin,start,html,sources})=>{
      const previous=sandstone.network.session.fetch;
      globalThis.scriptLabelRequests=[];
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname;
        if(!path.startsWith('/script-labels/'))return previous(url,options);
        scriptLabelRequests.push(path);
        if(path.endsWith('/redirect'))return new Response(null,{status:302,headers:{location:origin+'/script-labels/assets/redirected.js'}});
        return new Response(path.endsWith('/index')?html:sources[path]||'',{headers:{'Content-Type':path.endsWith('/index')?'text/html':'application/javascript'}});
      };
      await main_frame.navigate_to(start);
    },{origin,start,html,sources});
    stage('proxy workers');const actual=await snapshot(true);
    const requests=await page.evaluate(()=>scriptLabelRequests);
    if(!requests.includes('/script-labels/redirect')||!requests.includes('/script-labels/assets/redirected.js'))throw new Error('Script redirect chain was not exercised: '+JSON.stringify(requests));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Virtual script filename parity: '+JSON.stringify({expected,actual,diagnostics}));
    return ['Virtual filenames and stack-derived asset URLs for classic/module scripts', 'Redirected script filenames, authored sourceURL labels and inline document URLs', 'Virtual filenames in classic/module workers and importScripts dependencies'];
  }catch(error){stage('failure: '+(error.stack||error));throw error;}
  finally{page.off('console',workerLog);stage('native context cleanup');await nativeContext.close();}
}
