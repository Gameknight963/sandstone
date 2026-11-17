async page=>{
  const native=await page.context().newPage(),base='https://ancestor.test',cross='https://ancestor-other.test',leaf='https://ancestor-leaf.test';
  const parent='<!doctype html><body>Ancestor windows';
  const child=`<!doctype html><body><script>
    const label=location.pathname.slice(1);
    const flags={self:window===self,frames:window===frames,top:top===parent.top,
      topSelf:top===top.window&&top===top.self&&top===top.frames,
      topParent:top===top.parent&&top===top.top,
      depth:label==='child'?parent===top:label==='grandchild'?parent!==top&&parent.parent===top:parent!==top&&parent.parent!==top&&parent.parent.parent===top};
    let detached;
    addEventListener('message',event=>{
      if(event.data?.kind==='root-reply')top.postMessage({kind:'ack',label,source:event.source===top,origin:event.origin,trusted:event.isTrusted,detached},${JSON.stringify(base)});
      if(event.data?.kind==='intermediate')event.source.postMessage({kind:'intermediate-reply'},'*');
      if(event.data?.kind==='intermediate-reply')top.postMessage({kind:'intermediate-ack',source:event.source===parent.parent,origin:event.origin,trusted:event.isTrusted},${JSON.stringify(base)});
    });
    const bytes=new Uint8Array([label.length]).buffer;
    top.postMessage({kind:'ready',label,flags,bytes},${JSON.stringify(base)},[bytes]);detached=bytes.byteLength;
    top.postMessage({kind:'wrong'},'https://wrong.test');
    if(label==='leaf')parent.parent.postMessage({kind:'intermediate'},'*');
    if(label!=='leaf'){
      const child=document.createElement('iframe');child.src=label==='child'?${JSON.stringify(base+'/grandchild')}:${JSON.stringify(leaf+'/leaf')};document.body.append(child);
    }
  <\/script>`;
  for(const origin of [base,cross,leaf])await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/start'?parent:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,url,opaque)=>{
    await evaluate(proxy,`globalThis.replies=[];globalThis.sources=new Map();globalThis.wrong=0;globalThis.intermediate=null;
      addEventListener('message',event=>{
        if(event.data?.kind==='wrong')wrong++;
        if(event.data?.kind==='ready'){
          const value=event.data,source=event.source;
          sources.set(value.label,source);
          replies.push({kind:'ready',label:value.label,flags:value.flags,bytes:Array.from(new Uint8Array(value.bytes)),origin:event.origin,trusted:event.isTrusted,
            source:value.label==='child'?source===child.contentWindow:value.label==='grandchild'?source.parent===child.contentWindow:source.parent.parent===child.contentWindow,
            top:source.top===window});
          source.postMessage({kind:'root-reply'},event.origin==='null'?'*':event.origin);
        }
        if(event.data?.kind==='ack')replies.push({...event.data,stable:event.source===sources.get(event.data.label)});
        if(event.data?.kind==='intermediate-ack')intermediate=event.data;
      });
      globalThis.child=document.createElement('iframe');${opaque?"child.sandbox='allow-scripts';":''}
      child.src=${JSON.stringify(url)};document.body.append(child);true`);
    const expires=Date.now()+10000;
    while(!await evaluate(proxy,"replies.filter(reply=>reply.kind==='ack').length===3&&intermediate!==null")){
      if(Date.now()>expires)throw new Error('Ancestor windows timed out: '+await evaluate(proxy,'JSON.stringify({replies,intermediate,wrong})'));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return JSON.parse(await evaluate(proxy,'JSON.stringify({root:top===window&&parent===window,replies:replies.sort((a,b)=>(a.label+a.kind).localeCompare(b.label+b.kind)),intermediate,wrong})'));
  };
  try{
    await page.evaluate(({base,cross,leaf,parent,child})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>[base,cross,leaf].includes(new URL(url).origin)?Promise.resolve(new Response(new URL(url).pathname==='/start'?parent:child,{headers:{'Content-Type':'text/html'}})):previous(url,options);
    },{base,cross,leaf,parent,child});
    for(const [origin,opaque] of [[base,false],[cross,false],[cross,true]]){
      await native.goto(base+'/start');const expected=await run(false,origin+'/child',opaque);
      await page.evaluate(url=>main_frame.navigate_to(url),base+'/start');const actual=await run(true,origin+'/child',opaque);
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Ancestor Window parity: '+JSON.stringify({expected,actual}));
    }
    return ['Nested parent/top Window identities stop at the virtual root','Direct ancestor messages preserve source, virtual origin, transfers and trusted events','Same/cross/opaque-origin descendants can receive direct replies from ancestors'];
  }finally{await native.close();}
}
