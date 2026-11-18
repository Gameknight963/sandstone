async page=>{
  const url='https://key-identity.test/',html='<!doctype html><body>Key identity fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(async()=>{
    const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']),independent=structuredClone(key);
    const graph={key,again:key,independent,map:new Map([[key,'original'],[independent,'clone']]),set:new Set([key,independent]),error:new Error('key aliases',{cause:{key,independent}})};graph.self=graph;
    const describe=async value=>{
      const bytes=new Uint8Array([1,2,3]),signature=await crypto.subtle.sign('HMAC',value.key,bytes);
      return {cycle:value.self===value,alias:value.key===value.again,independent:value.key!==value.independent,keys:[value.key instanceof CryptoKey,value.independent instanceof CryptoKey],mapSize:value.map.size,setSize:value.set.size,map:[value.map.get(value.key),value.map.get(value.independent)],set:value.set.has(value.key)&&value.set.has(value.independent),cause:value.error.cause.key===value.key&&value.error.cause.independent===value.independent,extractable:[value.key.extractable,value.independent.extractable],sameMaterial:await crypto.subtle.verify('HMAC',value.independent,signature,bytes)};
    };
    const local=await describe(structuredClone(graph));
    const sender=new BroadcastChannel('key-identity'),receiver=new BroadcastChannel('key-identity');let broadcast;
    try{broadcast=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Key identity broadcast timed out')),5000);receiver.onmessage=event=>{clearTimeout(timer);describe(event.data).then(resolve,reject);};receiver.onmessageerror=()=>{clearTimeout(timer);reject(new Error('Key identity message failed'));};sender.postMessage(graph);});}finally{sender.close();receiver.close();}
    const done=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const open=indexedDB.open('key-identity-fixture',1);open.onupgradeneeded=()=>open.result.createObjectStore('keys');const database=await done(open);let stored;
    try{
      await new Promise((resolve,reject)=>{const transaction=database.transaction('keys','readwrite');transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.objectStore('keys').put(graph,'graph');});
      stored=await describe(await done(database.transaction('keys').objectStore('keys').get('graph')));
    }finally{database.close();await done(indexedDB.deleteDatabase('key-identity-fixture'));}
    return JSON.stringify({local,broadcast,stored});
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Key identity parity: '+JSON.stringify({expected,actual}));
    return ['BroadcastChannel preserves distinct CryptoKey clones and shared aliases in cyclic graphs','IndexedDB key round-trips preserve Map/Set entries, Error causes and nonextractable key permissions'];
  }finally{await context.close();}
}
