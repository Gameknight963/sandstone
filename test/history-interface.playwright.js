async page=>{
  const url='https://history-interface.test/',html='<!doctype html><body>History interface';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(async()=>{
    const results=[],capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}},proto=History.prototype;
    results.push({instance:history instanceof History,prototype:Object.getPrototypeOf(history)===proto,constructor:history.constructor===History,own:Reflect.ownKeys(history),tag:Object.prototype.toString.call(history)});
    for(const key of ['pushState','replaceState','go','back','forward'])results.push({key,method:history[key]===proto[key],name:history[key].name,length:history[key].length,receiver:capture(()=>proto[key].call({}))});
    for(const key of ['state','length','scrollRestoration']){const get=Object.getOwnPropertyDescriptor(proto,key).get;results.push({key,borrow:capture(()=>get.call(history)===history[key]),receiver:capture(()=>get.call({}))});}
    results.push(capture(()=>new History()),capture(()=>proto.replaceState.call(new Proxy(history,{}),{},'')));
    results.push(capture(()=>{const state={value:1};proto.replaceState.call(history,state,'','?borrowed');state.value=2;return {state:history.state,stable:history.state===history.state,path:location.search};}));
    results.push(capture(()=>{const length=history.length;proto.pushState.call(history,{pushed:true},'','?pushed');return {added:history.length-length,state:history.state,path:location.search};}));
    results.push(capture(()=>{const original=proto.replaceState,calls=[];try{proto.replaceState=function(...args){calls.push(this===history);return original.apply(this,args);};history.replaceState({patched:true},'');return {calls,state:history.state};}finally{proto.replaceState=original;}}));
    for(const value of ['manual','invalid',undefined,null,{toString(){return 'auto';}},Symbol('restoration')])results.push({restoration:capture(()=>history.scrollRestoration=value),value:history.scrollRestoration});
    for(const value of [1n,Symbol('delta')])results.push(capture(()=>proto.go.call(history,value)));
    const order=[],state={get saved(){order.push('state');return true;}},title={toString(){order.push('title');return '';}},next={toString(){order.push('url');return '?converted';}};
    results.push(capture(()=>{history.replaceState(state,title,next);return {order,state:history.state,search:location.search};}));
    results.push(capture(()=>history.replaceState(()=>{},Symbol('title'),'?bad')),capture(()=>history.replaceState(()=>{},'',Symbol('url'))));
    results.push(capture(()=>history.replaceState({},Symbol('title'),'?bad')),capture(()=>history.replaceState({},'',Symbol('url'))),capture(()=>history.replaceState({})));
    const frame=document.createElement('iframe');await new Promise(resolve=>{frame.onload=resolve;frame.src='${url}child';document.body.append(frame);});const peer=frame.contentWindow,other=peer.history;
    results.push(capture(()=>{proto.replaceState.call(other,{child:true},'','?child');peer.History.prototype.replaceState.call(history,{parent:true},'','?parent');return {child:other.state,parent:history.state,childURL:peer.location.search,parentURL:location.search,getter:Object.getOwnPropertyDescriptor(peer.History.prototype,'state').get.call(history)===history.state,instance:other instanceof peer.History,foreign:other instanceof History};}));
    const cached={state:Object.getOwnPropertyDescriptor(proto,'state').get,length:Object.getOwnPropertyDescriptor(proto,'length').get,restoration:Object.getOwnPropertyDescriptor(proto,'scrollRestoration').get};frame.remove();
    results.push({detached:Object.fromEntries(Object.entries(cached).map(([key,get])=>[key,capture(()=>get.call(other))])),write:capture(()=>proto.replaceState.call(other,{},'')),invalid:capture(()=>proto.replaceState.call(other,{},Symbol('title'))),missing:capture(()=>proto.replaceState.call(other)),restoration:capture(()=>Object.getOwnPropertyDescriptor(proto,'scrollRestoration').set.call(other,'invalid'))});
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('History interface parity: '+JSON.stringify({expected,actual}));
    return ['History preserves native prototypes, borrowed methods and same-origin receiver identity','History argument conversions and detached-document access match native browser behavior'];
  }finally{await context.close();}
}
