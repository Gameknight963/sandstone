async page=>{
  const url='https://javascript-asi.test/';
  const files={
    '/classic.js':"(function(){const description=`classic`\nthis.asiResults.classic=description\nthis.asiResults.count++}).call(window)",
    '/dependency.js':"export class Controller{#count=0\nconstructor(parent){this.parent=parent}\nrender(){const node=document.createElement('p')\nthis.node=node\nthis.#count++\nconst text=`module-${this.#count}`\nthis.node.id='module-result'\nthis.node.textContent=text\nthis.parent.insertBefore(node,null)}}",
    '/module.js':"import {Controller} from './dependency.js'\nconst view=new Controller(document.body)\nview.render()\nwindow.asiResults.module=view.node.textContent",
    '/worker.js':"onmessage=function(){const response={value:'worker'}\nthis.postMessage(response)}"
  };
  const inline="'use strict';(function(){const options={value:'inline'}\nthis.asiResults={inline:options.value,count:0}\nfunction stopAfterReturn(){return {value:'stopped'}\nthis.asiResults.unreachable=true}\nthis.asiResults.returned=stopAfterReturn().value}).call(window)";
  const html='<!doctype html><body><script>'+inline+'<\/script><script src="classic.js"><\/script><script type="module" src="module.js"><\/script>';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path==='/'?'text/html':'text/javascript',body:path==='/'?html:files[path]||''});});
  const source=`(async()=>{const deadline=Date.now()+5000;while(!globalThis.asiResults?.module){if(Date.now()>deadline)throw new Error('ASI scripts did not finish');await new Promise(resolve=>setTimeout(resolve,20));}const worker=new Worker('/worker.js');try{const value=await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data.value);worker.onerror=()=>reject(new Error('ASI worker failed'));worker.postMessage('run')});return JSON.stringify({...asiResults,worker:value,unreachable:!!asiResults.unreachable,dom:document.getElementById('module-result').textContent});}finally{worker.terminate();}})()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,files,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const parsed=new URL(target);return parsed.origin===new URL(url).origin?Promise.resolve(new Response(parsed.pathname==='/'?html:files[parsed.pathname]||'',{headers:{'Content-Type':parsed.pathname==='/'?'text/html':'text/javascript'}})):previous(target,options);};},{url,files,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Browser ASI parity: '+JSON.stringify({expected,actual}));
    return ['Semicolon-free classic and module scripts preserve initializer, return and class-field boundaries','Semicolon-free worker handlers preserve native receiver and message behavior'];
  }finally{await context.close();}
}
