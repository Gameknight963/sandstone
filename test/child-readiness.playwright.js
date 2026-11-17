async page=>{
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const until=async predicate=>{
    const deadline=Date.now()+5000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error('Child readiness fixture timed out');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await page.evaluate(async()=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,options)=>{
      if(!new URL(url).pathname.startsWith('/child-readiness/'))return previous(url,options);
      const html=url.endsWith('/parent')?'<!doctype html><body>Parent':
        '<!doctype html><body>Child<script>parent.postMessage({kind:"child-ready",path:location.pathname},"*");<\/script>';
      return Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}}));
    };
    await main_frame.navigate_to('https://fixture.test/child-readiness/parent');
  });
  const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
  await root.evaluate(()=>{
    const property=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src'),rpc=sandstone_frame.rpc,post=rpc.host.postMessage;
    globalThis.childGate={enabled:false,held:[],registered:[],restore(){Object.defineProperty(HTMLIFrameElement.prototype,'src',property);rpc.host.postMessage=post;}};
    Object.defineProperty(HTMLIFrameElement.prototype,'src',{...property,set(value){
      if(childGate.enabled&&this.id==='readiness-child'){
        if(value==='')return; // Retain the previous runtime while navigation is held.
        if(value.startsWith('blob:')){
          childGate.held.push({url:value,release:()=>property.set.call(this,value)});
          // Reproduce a load notification left over from a previous document.
          this.dispatchEvent(new Event('load'));
          return;
        }
      }
      property.set.call(this,value);
    }});
    rpc.host.postMessage=function(message,...args){
      if(message.procedure==='frame_register')childGate.registered.push(message.arguments[2]);
      return Reflect.apply(post,this,[message,...args]);
    };
  });
  try{
    await evaluate(`window.childArrivals=[];addEventListener('message',event=>{if(event.data?.kind==='child-ready')childArrivals.push(event.data.path);});
      window.readyChild=document.createElement('iframe');readyChild.id='readiness-child';readyChild.src='/child-readiness/old';document.body.append(readyChild);true`);
    await until(()=>evaluate('childArrivals.includes("/child-readiness/old")'));
    await root.evaluate(()=>childGate.enabled=true);
    await evaluate('readyChild.src="/child-readiness/first";true');
    await until(()=>root.evaluate(()=>childGate.held.length===1));
    await page.waitForTimeout(100);
    const early=await root.evaluate(()=>childGate.registered);
    if(early.some(url=>url.endsWith('/first')))throw new Error('A stale child load event authorized the next runtime: '+JSON.stringify(early));
    await evaluate('readyChild.src="/child-readiness/last";true');
    await until(()=>root.evaluate(()=>childGate.held.length===2));
    const urls=await root.evaluate(()=>childGate.held.map(item=>item.url));
    if(new Set(urls).size!==2)throw new Error('Child runtime documents reused readiness identity');
    await root.evaluate(()=>childGate.held.at(-1).release());
    await until(()=>evaluate('childArrivals.includes("/child-readiness/last")'));
    const state=await root.evaluate(()=>childGate.registered);
    const arrivals=JSON.parse(await evaluate('JSON.stringify(childArrivals)'));
    if(state.some(url=>url.endsWith('/first'))||JSON.stringify(arrivals)!==JSON.stringify(['/child-readiness/old','/child-readiness/last']))throw new Error('A superseded child runtime was initialized: '+JSON.stringify({state,arrivals}));
    return ['Stale child iframe load events cannot authorize runtime initialization','Superseded child readiness waits cancel before the intended runtime loads'];
  }finally{await root.evaluate(()=>childGate.restore());}
}
