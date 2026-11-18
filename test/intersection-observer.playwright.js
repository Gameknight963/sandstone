async page=>{
  const url='https://intersection-observer.test/',html='<!doctype html><body><div id="target" style="width:20px;height:20px">Target</div>';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(async()=>{
    const results=[],capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}},get=Object.getOwnPropertyDescriptor(IntersectionObserver.prototype,'root').get;
    for(const root of [null,document,document.body.ownerDocument,document.body])results.push(capture(()=>{const observer=new IntersectionObserver(()=>{},{root,rootMargin:'5px',threshold:[.2,.5]});try{return {root:observer.root===root,borrow:get.call(observer)===root,instance:observer instanceof IntersectionObserver,constructor:observer.constructor===IntersectionObserver,own:Object.hasOwn(observer,'root'),margin:observer.rootMargin,thresholds:observer.thresholds};}finally{observer.disconnect();}}));
    results.push(capture(()=>{const observer=new IntersectionObserver(()=>{},Object.freeze({root:document}));observer.disconnect();return observer.root===document;}));
    const reads=[],options={};for(const key of ['delay','root','rootMargin','scrollMargin','threshold','trackVisibility'])Object.defineProperty(options,key,{get(){reads.push([key,this===options]);return key==='root'?document:undefined;}});
    results.push(capture(()=>{const observer=new IntersectionObserver(()=>{},options);observer.disconnect();return {reads,root:observer.root===document};}));
    let forgedReads=0;const forged={get __target__(){forgedReads++;return document;}};
    results.push(capture(()=>new IntersectionObserver(()=>{},{root:forged})),{forgedReads});
    for(const operation of [()=>new IntersectionObserver(),()=>new IntersectionObserver(42,{get root(){throw new Error('Invalid callbacks precede dictionary getters');}}),()=>new IntersectionObserver(()=>{},{root:new Proxy(document.body,{})}),()=>get.call({}),()=>IntersectionObserver(()=>{})])results.push(capture(operation));
    results.push(capture(()=>{class Custom extends IntersectionObserver{}const observer=new Custom(()=>{},{root:document});observer.disconnect();return [observer instanceof Custom,observer.root===document];}));
    results.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Intersection callback timed out')),3000),target=document.getElementById('target'),observer=new IntersectionObserver(function(entries,value){clearTimeout(timer);observer.disconnect();resolve({root:observer.root===document,observer:value===observer,receiver:this===observer,target:entries[0].target===target,intersecting:entries[0].isIntersecting});},{root:document});observer.observe(target);}));
    const frame=document.createElement('iframe');document.body.append(frame);const peer=frame.contentWindow;
    results.push(capture(()=>{const parentObserver=new IntersectionObserver(()=>{},{root:peer.document}),childObserver=new peer.IntersectionObserver(()=>{},{root:document}),peerGet=Object.getOwnPropertyDescriptor(peer.IntersectionObserver.prototype,'root').get;parentObserver.disconnect();childObserver.disconnect();return [get.call(childObserver)===document,peerGet.call(parentObserver)===peer.document];}));frame.remove();
    const original=IntersectionObserver;try{window.IntersectionObserver=undefined;results.push({disabled:typeof IntersectionObserver,window:typeof window.IntersectionObserver});}finally{window.IntersectionObserver=original;}results.push({restored:IntersectionObserver===original,name:IntersectionObserver.name,length:IntersectionObserver.length,getName:get.name});
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>String(target).startsWith(url)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{url,html});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('IntersectionObserver parity: '+JSON.stringify({expected,actual}));
    return ['IntersectionObserver accepts virtual document roots while retaining native dictionary conversions and callbacks','IntersectionObserver roots preserve authored identity across same-origin realms and borrowed getters'];
  }finally{await context.close();}
}
