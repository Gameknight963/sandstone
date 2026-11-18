async page=>{
  const origin='https://global-descriptors.test',nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),direct=[];
  const html='<!doctype html><title>Descriptors</title><body><main id="fixture"></main>';
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const navigate=async()=>{await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');};
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('/start')?'text/html':'text/plain',body:route.request().url().endsWith('/start')?html:'echo'}));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(url.endsWith('/start')?html:'echo',{headers:{'Content-Type':url.endsWith('/start')?'text/html':'text/plain'}})):previous(url,options);},{origin,html});
    const cases=[
      ['API descriptor identity',`const keys=['fetch','WebSocket','Worker','XMLHttpRequest','EventSource','Request','URL','BroadcastChannel','MutationObserver','Range'];return keys.map(key=>{const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);return [key,descriptor?.value===globalThis[key],descriptor?.writable,descriptor?.enumerable,descriptor?.configurable];});`],
      ['lazy virtual storage accessors',`const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');localStorage.setItem('descriptor-kept','yes');return {same:descriptor.get.call(globalThis)===localStorage,getter:descriptor.get===Object.getOwnPropertyDescriptor(globalThis,'localStorage').get,value:descriptor.get.call(globalThis).getItem('descriptor-kept')};`],
      ['descriptor fetch instrumentation',`const original=Object.getOwnPropertyDescriptor(globalThis,'fetch');let calls=0;const patched=function(...args){calls++;return Reflect.apply(original.value,this,args);};try{Object.defineProperty(globalThis,'fetch',{...original,value:patched});const identity=fetch===patched&&Object.getOwnPropertyDescriptors(globalThis).fetch.value===patched;const text=await Reflect.apply(Object.getOwnPropertyDescriptors(globalThis).fetch.value,globalThis,[${JSON.stringify(origin+'/echo')}]).then(response=>response.text());return {calls,identity,text};}finally{Object.defineProperty(globalThis,'fetch',original);}`],
      ['write protection and restoration',`const original=Object.getOwnPropertyDescriptor(globalThis,'fetch');try{Object.defineProperty(globalThis,'fetch',{writable:false});let error;try{(()=>{'use strict';fetch=null;})()}catch(e){error=e.name;}const result={error,same:fetch===original.value,writable:Object.getOwnPropertyDescriptor(globalThis,'fetch').writable};Object.defineProperty(globalThis,'fetch',original);result.restored=fetch===original.value;return result;}finally{Object.defineProperty(globalThis,'fetch',original);}`],
      ['delete and recreate',`const original=Object.getOwnPropertyDescriptor(globalThis,'fetch'),symbol=Symbol('metadata');globalThis[symbol]=true;try{const saved=fetch;delete globalThis.fetch;const state={type:typeof fetch,present:'fetch'in globalThis,own:Object.hasOwn(globalThis,'fetch'),key:Reflect.ownKeys(globalThis).includes('fetch')};state.text=await saved('data:text/plain,kept').then(response=>response.text());Object.defineProperty(globalThis,'fetch',original);state.restored=fetch===original.value;const keys=Reflect.ownKeys(globalThis);state.order=keys.indexOf('fetch')<keys.indexOf(symbol);return state;}finally{Object.defineProperty(globalThis,'fetch',original);delete globalThis[symbol];}`],
      ['fixed reflected API',`const original=Object.getOwnPropertyDescriptor(globalThis,'fetch');Object.defineProperty(globalThis,'fetch',{configurable:false,writable:false});const descriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch');return {same:fetch===original.value&&descriptor.value===fetch,writable:descriptor.writable,configurable:descriptor.configurable,text:await fetch('data:text/plain,fixed').then(response=>response.text())};`],
      ['read-only currentScript',`let error;try{(()=>{'use strict';document.currentScript={};})()}catch(e){error=e.name;}return {error,value:document.currentScript===null};`],
      ['currentScript property overrides',`Object.defineProperty(document,'currentScript',{value:{label:'override'},configurable:true});const script=document.createElement('script');script.textContent='globalThis.descriptorCurrentScript=document.currentScript.label;';document.body.append(script);delete document.currentScript;return {seen:descriptorCurrentScript,restored:document.currentScript===null};`]
    ];
    for(const [name,body] of cases){
      await navigate();const source='(async()=>{'+body+'})().then(JSON.stringify)';
      const expected=await evaluate(false,source),actual=await evaluate(true,source);
      if(actual!==expected)throw new Error('Global descriptor parity for '+name+': '+actual+' expected '+expected);
    }
    if(direct.length)throw new Error('Reflected APIs attempted direct HTTP: '+JSON.stringify(direct));
    return ['Reflected globals retain virtual API identity and lazy storage getters','Descriptor-based API instrumentation, restoration, deletion and fixed flags match native behavior','Reflected fetch stays behind the relay and runtime script state survives public overrides'];
  }finally{await nativeContext.close();await page.unroute(/^https?:/,block);}
}
