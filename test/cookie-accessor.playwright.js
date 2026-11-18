async page=>{
  const origin='https://cookie-accessor.test',url=origin+'/page',html='<!doctype html><body>Cookie accessors';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html,headers:{'Permissions-Policy':'unload=(self)'}}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    if(proxy)await page.evaluate(async({url,html})=>{main_frame.special_pages[url]=html;await main_frame.navigate_to(url);},{url,html});else await native.goto(url);
    const result=JSON.parse(await evaluate(proxy,`(async()=>{
      const capture=callback=>{try{return {value:callback()??null};}catch(error){return {error:error.name};}},normalize=value=>value.split('; ').filter(Boolean).sort();
      const descriptor=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
      const metadata={enumerable:descriptor.enumerable,configurable:descriptor.configurable,get:{name:descriptor.get.name,length:descriptor.get.length},set:{name:descriptor.set.name,length:descriptor.set.length}};
      const own=capture(()=>{descriptor.set.call(document,'accessor=own; Path=/; Secure');return normalize(descriptor.get.call(document));});
      const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin+'/child')};const loaded=new Promise(resolve=>frame.onload=resolve);document.body.append(frame);await loaded;
      const doc=frame.contentDocument,win=frame.contentWindow,childDescriptor=Object.getOwnPropertyDescriptor(win.Document.prototype,'cookie');
      const cross=capture(()=>{descriptor.set.call(doc,'cross=parent; Path=/; Secure');childDescriptor.set.call(document,'reverse=child; Path=/; Secure');return [normalize(descriptor.get.call(doc)),normalize(childDescriptor.get.call(document))];});
      const inert=document.implementation.createHTMLDocument('inert');
      const inertResult=capture(()=>{descriptor.set.call(inert,'inert=hidden; Path=/');return [descriptor.get.call(inert),inert.cookie];});
      let fakeReads=0;const fake={get __target__(){fakeReads++;return document;}};
      const invalid=[capture(()=>descriptor.get.call(fake)),capture(()=>descriptor.set.call(fake,'bad=value')),capture(()=>descriptor.set.call(document)),capture(()=>descriptor.set.call(document,Symbol('cookie')))];
      const events=[];let hooked,hookDirect;
      try{
        Object.defineProperty(Document.prototype,'cookie',{...descriptor,get(){events.push(['get',this===document]);return descriptor.get.call(this);},set(value){events.push(['set',this===document,value]);if(!value.startsWith('blocked='))return descriptor.set.call(this,value);}});
        document.cookie='hook=observed; Path=/; Secure';document.cookie='blocked=denied; Path=/; Secure';hooked=normalize(document.cookie);
        hookDirect=normalize(childDescriptor.get.call(document));
      }finally{Object.defineProperty(Document.prototype,'cookie',descriptor);}
      const before=capture(()=>normalize(doc.cookie));
      const coercionFrame=document.createElement('iframe');document.body.append(coercionFrame);const coercionDoc=coercionFrame.contentDocument;let conversions=0;
      const coercion=capture(()=>descriptor.set.call(coercionDoc,{toString(){conversions++;coercionFrame.remove();return 'coercion=ignored; Path=/; Secure';}}));
      frame.remove();
      const detached=[capture(()=>descriptor.get.call(doc)),capture(()=>{descriptor.set.call(doc,'detached=ignored; Path=/');return descriptor.get.call(doc);})];
      const unnamed=[];
      for(const value of ['bare; Path=/','=single; Path=/','__Host-unnamed; Path=/; Secure','__Secure-unnamed; Path=/; Secure','=with=equals; Path=/','=; Path=/','; Path=/','with=real; Path=/']){
        descriptor.set.call(document,value);unnamed.push(normalize(descriptor.get.call(document)));
      }
      await new Promise(resolve=>setTimeout(resolve,30));
      return JSON.stringify({metadata,own,cross,inert:inertResult,invalid,fakeReads,events,hooked,hookDirect,before,coercion,conversions,detached,unnamed,final:normalize(document.cookie)});
    })()`));
    return result;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>new URL(target).origin===origin?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(target,options);},{origin,html});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected)){console.log(JSON.stringify({cookieAccessor:{expected,actual}}));throw new Error('Document cookie accessors differ from native');}
    const unloading=await evaluate(true,`(async()=>{
      const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin+'/unload')};const ready=new Promise(resolve=>frame.onload=resolve);document.body.append(frame);await ready;
      const doc=frame.contentDocument;let fired=false;
      frame.contentWindow.addEventListener('unload',()=>{fired=true;doc.cookie='cookie_accessor_unload=accepted; Path=/; Secure';});
      frame.remove();return fired;
    })()`);
    if(!unloading)throw new Error('Runtime unload did not run');
    const deadline=Date.now()+5000;
    while(!await page.evaluate(origin=>sandstone.controller.site_data.cookies.getCookieStringSync(origin).includes('cookie_accessor_unload=accepted'),origin)){
      if(Date.now()>deadline)throw new Error('An active unload cookie write lost its host context');await new Promise(resolve=>setTimeout(resolve,20));
    }
    return ['Borrowed Document cookie accessors accept virtual documents across accessible realms','Document cookie prototype instrumentation observes reads and writes with the native receiver','Inert and removed documents preserve native cookie access and argument validation','Active unload cookie writes retain their original host document context'];
  }finally{await context.close();}
}
