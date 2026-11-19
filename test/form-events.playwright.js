async page=>{
  const origin='https://form-events.test',prefix='/form-events/';
  const html=`<!doctype html><body><iframe name="sink"></iframe>
    <dialog id="dialog" open><form id="subject" method="post" target="sink" action="${prefix}received">
      <input id="field" name="field" value="before"><button id="send" name="go" value="yes">Send</button>
    </form></dialog><script>
      globalThis.form=document.getElementById('subject');globalThis.button=document.getElementById('send');
      globalThis.field=document.getElementById('field');globalThis.dialog=document.getElementById('dialog');
      globalThis.events=[];globalThis.submission=null;
      form.addEventListener('submit',event=>{submission=event;events.push(['submit',event.isTrusted,event.defaultPrevented,event.submitter===button]);});
      form.addEventListener('formdata',event=>events.push(['data',Array.from(event.formData)]));
    <\/script>`;
  const multiline='('+function(){
    const text=document.createElement('textarea');
    text.name='text\nname';text.value='first\r\nsecond\rthird\nfourth';form.append(text);
    form.addEventListener('formdata',event=>{
      event.formData.append('added\rkey\nline','value\rnext\nlast\r\nend');
      event.formData.append('file\nkey',new File(['bytes'],'file\rname\n.txt'));
      event.formData.append('duplicate',String.fromCodePoint(0x96ea));event.formData.append('duplicate','second');
    });
  }.toString()+')();';
  const cases=[
    ...[["get","application/x-www-form-urlencoded"],["post","application/x-www-form-urlencoded"],["post","text/plain"]].map(([method,enctype])=>({
      name:method+" "+enctype+" multiline encoding",setup:"form.acceptCharset=\"utf-8\";form.method="+JSON.stringify(method)+";form.enctype="+JSON.stringify(enctype)+";"+multiline
    })),
    {name:'stop propagation',setup:"form.addEventListener('submit',e=>e.stopPropagation())"},
    {name:'stop immediate propagation',setup:"form.addEventListener('submit',e=>e.stopImmediatePropagation());form.addEventListener('submit',()=>events.push('unexpected'))"},
    {name:'cancel stopped submit',setup:"form.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();events.push(['cancelled',e.defaultPrevented,e.returnValue]);})",count:0},
    {name:'window cancellation',setup:"addEventListener('submit',e=>e.preventDefault())",count:0},
    {name:'late window mutation',setup:"addEventListener('submit',()=>field.value='window')"},
    {name:'passive cancellation',setup:"form.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();events.push(['passive',e.defaultPrevented]);},{passive:true})"},
    {name:'property cancellation',setup:"const handler=function(e){events.push(['property',this===form,form.onsubmit===handler]);return false;};form.onsubmit=handler",count:0},
    {name:'inline cancellation',setup:"form.setAttribute('onsubmit','events.push(\"inline\");return false')",count:0},
    {name:'removed listener',setup:"const cancel=e=>e.preventDefault();form.addEventListener('submit',cancel);form.removeEventListener('submit',cancel)"},
    {name:'aborted listener',setup:"const abort=new AbortController();form.addEventListener('submit',e=>e.preventDefault(),{signal:abort.signal});abort.abort()"},
    {name:'once cancellation',setup:"form.addEventListener('submit',e=>e.preventDefault(),{once:true})",invoke:"form.requestSubmit(button);form.requestSubmit(button)"},
    {name:'event type listener identity',setup:"const cancel=e=>{if(e.type==='submit')e.preventDefault()};form.addEventListener('click',cancel,{once:true,passive:true});form.addEventListener('submit',cancel)",invoke:'button.click()',count:0},
    {name:'listener coercion',setup:"let reads=0;const type={toString(){reads++;return 'submit';}},cancel=e=>e.preventDefault();form.addEventListener(type,cancel);form.removeEventListener(type,cancel);events.push(['type reads',reads])"},
    {name:'synthetic submit',invoke:"events.push(['dispatch',form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}))])",count:0},
    {name:'synthetic cancelled submit',setup:"form.addEventListener('submit',e=>e.preventDefault())",invoke:"events.push(['dispatch',form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}))])",count:0},
    {name:'removed submitter',setup:"form.addEventListener('submit',()=>button.remove())"},
    {name:'removed form',setup:"form.addEventListener('submit',()=>form.remove())",count:0},
    {name:'detached prototype submit',invoke:'form.remove();HTMLFormElement.prototype.submit.call(form)',count:0},
    {name:'recursive formdata submit',setup:"form.addEventListener('formdata',()=>HTMLFormElement.prototype.submit.call(form))"},
    {name:'formdata action mutation',setup:"form.addEventListener('formdata',()=>form.action='/form-events/changed')"},
    {name:'formdata method mutation',setup:"form.addEventListener('formdata',()=>form.method='get')"},
    {name:'formdata detached form',setup:"form.addEventListener('formdata',()=>form.remove())",count:0},
    {name:'requestSubmit snapshots',invoke:"form.requestSubmit(button);events.push('returned');field.value='after';button.value='after';form.action='/unexpected'"},
    {name:'click snapshots',invoke:"button.click();events.push('returned');field.value='after';button.value='after';form.action='/unexpected'"},
    {name:'late cancellation',invoke:"form.requestSubmit(button);submission.preventDefault();events.push(['after',submission.defaultPrevented])"},
    {name:'dialog submit',setup:"form.method='dialog';dialog.returnValue='seed'",count:0},
    {name:'dialog without submitter',setup:"form.method='dialog';dialog.returnValue='seed'",invoke:'form.requestSubmit()',count:0},
    {name:'change to dialog',setup:"form.addEventListener('submit',()=>form.method='dialog')",count:0},
    {name:'change from dialog',setup:"form.method='dialog';form.addEventListener('submit',()=>form.method='post')"},
    {name:'cancel dialog',setup:"form.method='dialog';form.addEventListener('submit',e=>e.preventDefault())",count:0},
    {name:'closed shadow stopped submit',setup:"globalThis.shadow=document.createElement('div');document.body.append(shadow);shadow.attachShadow({mode:'closed'}).append(form);form.addEventListener('submit',e=>e.stopPropagation())"}
  ];
  cases.push(
    {name:'trusted stopped submit',trusted:true,setup:"form.addEventListener('submit',e=>e.stopPropagation())"},
    {name:'trusted cancelled submit',trusted:true,setup:"form.addEventListener('submit',e=>{e.preventDefault();e.stopImmediatePropagation()})",count:0},
    {name:'trusted immediate submit snapshots',trusted:true,setup:"form.addEventListener('submit',e=>e.stopImmediatePropagation());button.addEventListener('click',()=>setTimeout(()=>field.value='after',0))"},
    {name:'trusted capture stop',trusted:true,setup:"document.addEventListener('submit',e=>e.stopPropagation(),true)"},
    {name:'trusted target capture stop',trusted:true,setup:"form.addEventListener('submit',e=>e.stopPropagation(),true)"},
    {name:'trusted window capture immediate stop',trusted:true,setup:"addEventListener('submit',e=>e.stopImmediatePropagation(),true)"},
    {name:'trusted immediate microtask cancellation',trusted:true,setup:"form.addEventListener('submit',e=>{e.stopImmediatePropagation();queueMicrotask(()=>e.preventDefault())})",count:0},
    {name:'trusted dynamic window listener',trusted:true,setup:"form.addEventListener('submit',()=>addEventListener('submit',()=>field.value='late-window'))"},
    {name:'trusted same-phase registration',trusted:true,setup:"addEventListener('submit',()=>addEventListener('submit',e=>e.preventDefault()))"},
    {name:'trusted inline immediate stop',trusted:true,setup:"form.setAttribute('onsubmit','event.stopImmediatePropagation()');button.addEventListener('click',()=>setTimeout(()=>field.value='after',0))"},
    {name:'trusted click snapshots',trusted:true,setup:"button.addEventListener('click',()=>setTimeout(()=>{field.value='after';form.action='/unexpected'},0))"},
    {name:'trusted closed shadow submit',trusted:true,setup:"const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'closed'}).append(form);form.addEventListener('submit',e=>e.stopPropagation())"}
  );
  const native=await page.context().newPage(),requests=[];
  await native.route(origin+'/**',async route=>{
    const request=route.request();
    if(new URL(request.url()).pathname!==prefix+'start'&&new URL(request.url()).pathname!=='/favicon.ico')requests.push({path:new URL(request.url()).pathname+new URL(request.url()).search,method:request.method(),body:request.postData()||''});
    await route.fulfill({contentType:'text/html',body:new URL(request.url()).pathname===prefix+'start'?html:'<!doctype html><body>Received'});
  });
  const direct=[],routePattern=/^https?:/,block=route=>{direct.push(route.request().url());return route.abort();};
  await page.route(routePattern,block);
  try{
    await page.evaluate(({origin,prefix,html})=>{
      const previous=sandstone.network.session.fetch;globalThis.formEventRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;
        if(path!==prefix+'start'&&path!=='/favicon.ico')formEventRequests.push({path:path+new URL(url).search,method:options.method||'GET',body:options.body?new TextDecoder().decode(options.body):''});
        return Promise.resolve(new Response(path===prefix+'start'?html:'<!doctype html><body>Received',{headers:{'Content-Type':'text/html'}}));
      };
    },{origin,prefix,html});
    const run=async(proxy,test)=>{
      if(proxy)await page.evaluate(async url=>{formEventRequests=[];await main_frame.navigate_to(url);},origin+prefix+'start');
      else{requests.length=0;await native.goto(origin+prefix+'start');}
      const source=`(()=>{${test.setup||''};${test.invoke||'form.requestSubmit(button)'};return true;})()`;
      const evaluate=source=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
      if(test.trusted){
        await evaluate(`(()=>{${test.setup||''};return true;})()`);
        await (proxy?page:native).bringToFront();
        let frame=native;
        if(proxy){
          frame=undefined;
          for(const candidate of page.frames())if(await candidate.evaluate(()=>globalThis.sandstone_frame?.loader.url==='https://form-events.test/form-events/start').catch(()=>false)){frame=candidate;break;}
          if(!frame)throw new Error('Missing form frame');
        }
        const handle=await frame.evaluateHandle(proxy?()=>sandstone_frame.context.run_script('button'):()=>button);
        try{await handle.asElement().click();}finally{await handle.dispose();}
      }else await evaluate(source);
      const getRequests=()=>proxy?page.evaluate(()=>formEventRequests):Promise.resolve([...requests]);
      const expected=test.count??1,deadline=Date.now()+3000;
      if(expected)while((await getRequests()).length<expected){if(Date.now()>deadline)throw new Error(test.name+' request timed out; proxy='+proxy+' direct='+JSON.stringify(direct));await new Promise(resolve=>setTimeout(resolve,10));}
      // Drain the native navigation task, including cases expected to cancel.
      await new Promise(resolve=>setTimeout(resolve,40));
      const result=JSON.parse(await evaluate("JSON.stringify({events,open:dialog.open,value:dialog.returnValue})"));
      result.requests=await getRequests();
      if(result.requests.length!==expected)throw new Error(test.name+' unexpected request count; proxy='+proxy+' '+JSON.stringify(result));
      return result;
    };
    for(const test of cases){
      const expected=await run(false,test),actual=await run(true,test);
      if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Form event parity '+test.name+': '+JSON.stringify({expected,actual}));
    }
    if(direct.length)throw new Error('Forms bypassed relay: '+JSON.stringify(direct));
    return ['Stopped form submissions stay on the relay and preserve native cancellation','Submit listeners, inline handlers and synthetic events match native defaults','Form snapshots, detached controls, recursive formdata and dialog submissions','GET, URL-encoded and plain-text forms normalize multiline names, values and filenames without changing FormData events'];
  }finally{await native.close();await page.unroute(routePattern,block);}
}
