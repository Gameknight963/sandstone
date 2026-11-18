async(page,cases,globals)=>{
  const url='https://block-functions.test/',html='<!doctype html><body>Block function scope fixture';
  function matrix(strict=false){
    const operations=cases.map(test=>{
      const body=(test.module?'"use strict";':'')+test.body;
      let valid=true;if(strict)try{Function('"use strict";'+body);}catch{valid=false;}
      return '{name:'+JSON.stringify(test.name)+',body:'+JSON.stringify(body)+',run:'+(valid?'function(){'+body+'}':'null')+'}';
    });
    return `(async()=>{
      const saved=globalThis.fetch;globalThis.fetch=()=> 'virtual';
      const capture=async operation=>{try{return {value:await operation()??null};}catch(error){return {error:error.name};}};
      try{
        const results=[];
        for(const test of [${operations.join(',')}])results.push({name:test.name,authored:test.run?await capture(test.run):{error:'SyntaxError'},generated:await capture(()=>Function(test.body)())});
        return JSON.stringify(results);
      }finally{globalThis.fetch=saved;}
    })()`;
  }
  const source=matrix(),workerSources={classic:matrix(),module:matrix(true)};
  const workerBody=type=>'onmessage=async()=>{try{postMessage(await '+workerSources[type]+')}catch(error){postMessage(JSON.stringify({error:error.name}))}}';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>{const target=new URL(route.request().url()),worker=target.pathname==='/worker.js';return route.fulfill({contentType:worker?'text/javascript':'text/html',body:worker?workerBody(target.searchParams.get('mode')):html});});
  const workers=`(async()=>{const results=[];for(const type of ['classic','module']){const worker=new Worker('/worker.js?mode='+type,{type});try{results.push({type,value:await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Block function worker timed out')),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(JSON.parse(event.data))};worker.onerror=()=>{clearTimeout(timer);reject(new Error('Block function worker failed'))};worker.postMessage('run')})});}finally{worker.terminate();}}return JSON.stringify(results)})()`;
  try{
    await native.goto(url);
    const expected={frame:JSON.parse(await native.evaluate(source=>eval(source),source)),workers:JSON.parse(await native.evaluate(source=>eval(source),workers))};
    await page.evaluate(({url,html,bodies})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(target,options)=>{
        const parsed=new URL(target);if(parsed.origin!==new URL(url).origin)return previous(target,options);
        const worker=parsed.pathname==='/worker.js';return Promise.resolve(new Response(worker?bodies[parsed.searchParams.get('mode')]:html,{headers:{'Content-Type':worker?'text/javascript':'text/html'}}));
      };
    },{url,html,bodies:{classic:workerBody('classic'),module:workerBody('module')}});
    await page.evaluate(url=>main_frame.navigate_to(url),url);
    const actual={frame:JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source)),workers:JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),workers))};
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Block function scope parity: '+JSON.stringify({expected,actual}));
    for(let index=0;index<globals.length;index++){
      const test=globals[index],target=url+'global/'+index;
      await native.goto(target);await native.evaluate(()=>{globalThis.fetch=()=> 'virtual'});
      const check='(()=>{const value=(0,eval)('+JSON.stringify(test.body)+');return JSON.stringify({type:typeof value,value:typeof value==="function"?value.name:value??null,result:globalThis.result??null,following:fetch()})})()';
      const expected=await native.evaluate(source=>eval(source),check);
      await page.evaluate(target=>main_frame.navigate_to(target),target);await page.evaluate(()=>main_frame.eval_js('globalThis.fetch=()=>"virtual";true;'));
      const actual=await page.evaluate(source=>main_frame.eval_js(source),check);
      if(actual!==expected)throw new Error('Top-level block function parity ('+test.name+'): '+JSON.stringify({expected,actual}));
    }
    return ['Legacy block functions retain native hoisting, closure identity, lexical conflicts and strict-mode exclusions','Authored and generated block functions match native behavior in classic and module workers'];
  }finally{await context.close();}
}
