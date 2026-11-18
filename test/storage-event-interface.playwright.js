async page=>{
  const url='https://storage-event-interface.test/',html='<!doctype html><body>Storage event interface';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(()=>{
    const results=[],capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
    const getter=Object.getOwnPropertyDescriptor(StorageEvent.prototype,'storageArea').get;
    const describe=event=>({type:event.type,key:event.key,old:event.oldValue,value:event.newValue,url:event.url,area:event.storageArea===localStorage?'local':event.storageArea===sessionStorage?'session':event.storageArea===null?'null':'wrong',borrowed:getter.call(event)===event.storageArea,own:Object.hasOwn(event,'storageArea'),instance:event instanceof StorageEvent,constructor:event.constructor===StorageEvent,bubbles:event.bubbles,cancelable:event.cancelable,composed:event.composed});
    for(const area of [null,localStorage,sessionStorage])results.push(capture(()=>describe(new StorageEvent('storage',{key:'key',oldValue:'old',newValue:'new',url:location.href,storageArea:area,bubbles:true,cancelable:true,composed:true}))));
    results.push(capture(()=>{class Custom extends StorageEvent{}const event=new Custom('storage',{storageArea:localStorage});return [event instanceof Custom,event instanceof Event,getter.call(event)===localStorage];}));
    const reads=[],init={};for(const key of ['bubbles','cancelable','composed','key','newValue','oldValue','storageArea','url'])Object.defineProperty(init,key,{get(){reads.push([key,this===init]);return key==='storageArea'?localStorage:undefined;}});
    results.push(capture(()=>{const event=new StorageEvent('storage',init);return {reads,event:describe(event)};}));
    results.push(capture(()=>describe(new StorageEvent('storage',Object.freeze({storageArea:sessionStorage})))));
    for(const area of [{},new Proxy(localStorage,{}),42])results.push(capture(()=>new StorageEvent('storage',{storageArea:area})));
    const event=document.createEvent('StorageEvent');
    results.push(capture(()=>{event.initStorageEvent('storage',true,true,'legacy','before','after',location.href,localStorage);return describe(event);}));
    results.push(capture(()=>{event.initStorageEvent('storage',false,false,null,null,null,'',sessionStorage);return describe(event);}));
    results.push(capture(()=>{event.initStorageEvent('reset',false,false);return describe(event);}));
    results.push(capture(()=>{event.initStorageEvent('storage',false,false,null,null,null,'',localStorage);event.initStorageEvent('invalid',false,false,null,null,null,'',{});return describe(event);}));
    results.push(describe(event));
    results.push(capture(()=>getter.call({})),capture(()=>StorageEvent.prototype.initStorageEvent.call({},'storage')),capture(()=>StorageEvent('storage')));
    results.push(capture(()=>{event.initStorageEvent('storage',false,false,'initial',null,null,'',localStorage);let during;const listener=()=>{event.initStorageEvent('changed',true,true,'changed',null,null,'',sessionStorage);during=describe(event);};addEventListener('storage',listener,{once:true});dispatchEvent(event);return {during,after:describe(event)};}));
    results.push(capture(()=>{localStorage.removeItem('synthetic');let observed;addEventListener('storage',event=>{observed=[event.key,event.newValue,event.storageArea===localStorage,getter.call(event)===localStorage];},{once:true});dispatchEvent(new StorageEvent('storage',{key:'synthetic',newValue:'notification',storageArea:localStorage}));return {observed,value:localStorage.getItem('synthetic')};}));
    const frame=document.createElement('iframe');document.body.append(frame);const peer=frame.contentWindow;
    results.push(capture(()=>{const event=new peer.StorageEvent('storage',{storageArea:localStorage});const reverse=new StorageEvent('storage',{storageArea:peer.sessionStorage});StorageEvent.prototype.initStorageEvent.call(event,'storage',false,false,null,null,null,'',sessionStorage);peer.StorageEvent.prototype.initStorageEvent.call(reverse,'storage',false,false,null,null,null,'',localStorage);return [getter.call(event)===sessionStorage,Object.getOwnPropertyDescriptor(peer.StorageEvent.prototype,'storageArea').get.call(reverse)===localStorage];}));
    const detached=peer.localStorage;frame.remove();results.push(capture(()=>getter.call(new StorageEvent('storage',{storageArea:detached}))===detached));
    results.push({metadata:[StorageEvent.name,StorageEvent.length,StorageEvent.prototype.initStorageEvent.name,StorageEvent.prototype.initStorageEvent.length,getter.name,getter.length]});
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('StorageEvent interface parity: '+JSON.stringify({expected,actual}));
    return ['StorageEvent constructors and legacy initialization accept virtual storage areas with native conversions','StorageEvent storageArea getters retain identity across dispatch and same-origin realms'];
  }finally{await context.close();}
}
