async page=>{
  const url='https://structured-clone.test/',html='<!doctype html><body>Structured clone fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(async()=>{
    const results=[],capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
    let messageReads=0;const authored={};Object.defineProperty(authored,'value',{enumerable:true,get(){messageReads++;return 1;}});
    const synthetic=new MessageEvent('message',{data:authored});
    results.push({syntheticIdentity:synthetic.data===authored,repeatedIdentity:synthetic.data===synthetic.data,messageReads});
    authored.later=2;results.push({liveData:synthetic.data.later,messageReads});
    const opaque=new Proxy({},{ownKeys(){throw new Error('Authored message data must not be traversed');}});
    results.push(capture(()=>new MessageEvent('message',{data:opaque}).data===opaque));
    const replacement={reinitialized:true};synthetic.initMessageEvent('message',false,false,replacement,'','',null);
    results.push({reinitializedIdentity:synthetic.data===replacement});
    const target=new EventTarget();let dispatched;target.addEventListener('message',event=>{dispatched=event.data===authored;});
    target.dispatchEvent(new MessageEvent('message',{data:authored}));results.push({dispatched,messageReads});
    for(const value of [new Proxy({value:1},{}),new Proxy([1],{}),history,localStorage])results.push(capture(()=>structuredClone(value)));
    let tagReads=0;const tagged={value:'ordinary'};Object.defineProperty(tagged,Symbol.toStringTag,{get(){tagReads++;throw new Error('Symbol tags are not serialized');}});
    results.push(capture(()=>structuredClone(tagged)),{tagReads});
    const map=new Map([['key','value']]),set=new Set(['value']);map[Symbol.iterator]=set[Symbol.iterator]=()=>{throw new Error('Authored iterators are not used');};
    results.push(capture(()=>({map:[...structuredClone(map)],set:[...structuredClone(set)]})));
    const originalTag=Object.getOwnPropertyDescriptor(Object.prototype,Symbol.toStringTag);try{Object.defineProperty(Object.prototype,Symbol.toStringTag,{configurable:true,get(){throw new Error('Inherited tags are not serialized');}});results.push(capture(()=>structuredClone({saved:true})));}finally{if(originalTag)Object.defineProperty(Object.prototype,Symbol.toStringTag,originalTag);else delete Object.prototype[Symbol.toStringTag];}
    const marker={__sandstone_crypto_key_v1__:'ordinary marker',value:'retained'};results.push(capture(()=>structuredClone(marker)));
    const order=[],value={};Object.defineProperties(value,{first:{enumerable:true,get(){order.push('first');delete value.second;value.third='added';return 1;}},second:{enumerable:true,configurable:true,value:2}});
    results.push(capture(()=>{const copy=structuredClone(value);return {copy,keys:Object.keys(copy),order};}));
    const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
    const data={key,again:key,map:new Map([[key,new Set([key])]]),sparse:new Array(4),marker};data.self=data;
    const describe=copy=>({key:copy.key instanceof CryptoKey,alias:copy.key===copy.again,cycle:copy.self===copy,map:copy.map.get(copy.key).has(copy.key),sparse:copy.sparse.length===4&&!(0 in copy.sparse),marker:copy.marker,extractable:copy.key.extractable,usages:[...copy.key.usages],tag:Object.prototype.toString.call(copy.key)});
    const copy=structuredClone(data);results.push(describe(copy));
    const errorCopy=structuredClone({key,error:new Error('key cause',{cause:{key}})});results.push({error:errorCopy.error instanceof Error,name:errorCopy.error.name,message:errorCopy.error.message,cause:errorCopy.error.cause.key===errorCopy.key,enumerable:Object.getOwnPropertyDescriptor(errorCopy.error,'cause').enumerable});
    results.push({nativeGetter:Object.getOwnPropertyDescriptor(CryptoKey.prototype,'type').get.call(key),constructor:key.constructor===CryptoKey,own:Reflect.ownKeys(key)});
    const signature=await crypto.subtle.sign('HMAC',copy.key,new Uint8Array([1,2,3]));results.push({signed:signature.byteLength===32,export:await crypto.subtle.exportKey('raw',copy.key).then(()=>false,error=>/^InvalidAccess/.test(error.name))});
    const port=async(value,transfer=[])=>{const channel=new MessageChannel();try{return await new Promise(resolve=>{const timeout=setTimeout(()=>resolve({error:'Timeout'}),2000);channel.port2.onmessage=event=>{clearTimeout(timeout);try{resolve({value:describe(event.data)})}catch(error){resolve({error:error.name})}};try{channel.port1.postMessage(value,transfer);}catch(error){clearTimeout(timeout);resolve({error:error.name});}});}finally{channel.port1.close();channel.port2.close();}};
    results.push(await port(data));
    const buffer=new ArrayBuffer(8);results.push(await port({bad:new Proxy({},{}),buffer},[buffer]),{failedTransferBytes:buffer.byteLength});
    results.push(await new Promise(resolve=>{const listener=event=>{removeEventListener('message',listener);try{resolve({value:describe(event.data),source:event.source===window})}catch(error){resolve({error:error.name})}};addEventListener('message',listener);postMessage(data,'*');}));
    const channel=new MessageChannel();try{const timeout=new Promise(resolve=>setTimeout(()=>resolve('timeout'),2000));const received=new Promise(resolve=>channel.port2.onmessage=event=>resolve(event.data));channel.port1.postMessage(marker);results.push({messageMarker:await Promise.race([received,timeout])});}finally{channel.port1.close();channel.port2.close();}
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Structured clone parity: '+JSON.stringify({expected,actual}));
    return ['Authored message events retain data identity without evaluating getters or proxies','Native structured cloning preserves getter order, container semantics and clone failures','Nonextractable CryptoKeys retain identity, permissions and message interoperability without marker collisions'];
  }finally{await context.close();}
}
