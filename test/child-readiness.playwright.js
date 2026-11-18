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
    const encode=encodeURIComponent,rpc=sandstone_frame.rpc,post=rpc.host.postMessage;
    globalThis.childGate={enabled:false,held:[],registered:[],restore(){globalThis.encodeURIComponent=encode;rpc.host.postMessage=post;}};
    globalThis.encodeURIComponent=function(html){
      if(!childGate.enabled||typeof html!=='string'||!html.includes('data-sandstone-seed="'))return encode(html);
      // A physical document may load before its runtime is ready. Gate the
      // runtime itself, independently of how the iframe source is installed.
      const token=crypto.randomUUID();
      const source='<!doctype html><script>addEventListener("message",event=>{if(event.data?.token!=='+JSON.stringify(token)+')return;document.documentElement.innerHTML=event.data.html;const old=document.querySelector("script"),script=document.createElement("script");for(const attr of old.attributes)script.setAttribute(attr.name,attr.value);script.textContent=old.textContent;old.replaceWith(script);});<\/script>';
      const encoded=encode(source),url='data:text/html;charset=utf-8,'+encoded;
      childGate.held.push({url,release:()=>globalThis[0].postMessage({token,html},'*')});
      return encoded;
    };
    rpc.host.postMessage=function(message,...args){
      if(message.procedure==='frame_register')childGate.registered.push(message.arguments[2]);
      return Reflect.apply(post,this,[message,...args]);
    };
  });
  try{
    await evaluate(`window.childArrivals=[];addEventListener('message',event=>{if(event.data?.kind==='child-ready')childArrivals.push(event.data.path);});
      window.readyChild=document.createElement('iframe');readyChild.id='readiness-child';readyChild.src='https://child-runtime.test/child-readiness/old';document.body.append(readyChild);true`);
    await until(()=>evaluate('childArrivals.includes("/child-readiness/old")'));
    await root.evaluate(()=>childGate.enabled=true);
    await evaluate('readyChild.src="https://child-runtime.test/child-readiness/first";true');
    await until(()=>root.evaluate(()=>childGate.held.length===1));
    await page.waitForTimeout(100);
    const early=await root.evaluate(()=>childGate.registered);
    if(early.some(url=>url.endsWith('/first')))throw new Error('A stale child load event authorized the next runtime: '+JSON.stringify(early));
    await evaluate('readyChild.src="https://child-runtime.test/child-readiness/last";true');
    await until(()=>root.evaluate(()=>childGate.held.length===2));
    const urls=await root.evaluate(()=>childGate.held.map(item=>item.url));
    if(new Set(urls).size!==2)throw new Error('Child runtime documents reused readiness identity');
    await root.evaluate(()=>childGate.held.at(-1).release());
    await until(()=>evaluate('childArrivals.includes("/child-readiness/last")'));
    const state=await root.evaluate(()=>childGate.registered);
    const arrivals=JSON.parse(await evaluate('JSON.stringify(childArrivals)'));
    if(state.some(url=>url.endsWith('/first'))||JSON.stringify(arrivals)!==JSON.stringify(['/child-readiness/old','/child-readiness/last']))throw new Error('A superseded child runtime was initialized: '+JSON.stringify({state,arrivals}));
    return ['Stale child iframe load events cannot authorize runtime initialization','Superseded child readiness waits cancel before the intended runtime loads'];
  }catch(error){
    const bounded=operation=>Promise.race([operation,new Promise(resolve=>setTimeout(()=>resolve('unresponsive'),1000))]);
    console.log(JSON.stringify({fixture:'Child readiness',state:await bounded(root.evaluate(()=>({held:childGate.held.length,registered:childGate.registered}))),frames:await Promise.all(page.frames().filter(frame=>frame.parentFrame()===root).map(frame=>bounded(frame.evaluate(()=>({physical:location.href.slice(0,80),virtual:globalThis.sandstone_frame?.loader.url,attached:!!globalThis.sandstone_frame?.rpc.host.target,bootstrap:document.querySelector('script')?.getAttribute('data-sandstone-bootstrap')!==null})).catch(()=>({detached:true})))))}));
    throw error;
  }finally{await root.evaluate(()=>childGate.restore());}
}
