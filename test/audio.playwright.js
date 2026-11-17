async page=>{
  const origin='https://audio-constructor.test';
  const native=await page.context().newPage();
  const blank='<!doctype html><base href="/assets/"><body>';
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:blank}));
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try {
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,blank})=>{
      const previous=sandstone.network.session.fetch;
      globalThis.audioConstructorRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        audioConstructorRequests.push(url);
        if(url.endsWith('/slow.wav'))await new Promise(resolve=>globalThis.releaseConstructorAudio=resolve);
        if(url.endsWith('missing.wav'))return new Response('',{status:404});
        const bytes=new Uint8Array(1644),view=new DataView(bytes.buffer);
        const word=(offset,value)=>bytes.set(new TextEncoder().encode(value),offset);
        word(0,'RIFF');view.setUint32(4,1636,true);word(8,'WAVE');word(12,'fmt ');
        view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
        view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
        word(36,'data');view.setUint32(40,1600,true);
        return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});
      };
      main_frame.special_pages[origin+'/page']=blank;
      await main_frame.navigate_to(origin+'/page');
    },{origin,blank});
    const cases=[
      ['optional URL',`const rows=[];for(const args of [[],[undefined],[null],[''],[Symbol('url')]])try{const audio=new Audio(...args);rows.push({src:audio.getAttribute('src'),preload:audio.preload,tag:audio.tagName,prototype:Object.getPrototypeOf(audio)===Audio.prototype,owner:audio.ownerDocument===document.body.ownerDocument,connected:audio.isConnected});}catch(error){rows.push({error:error.name});}result=rows;`],
      ['native prototype and call validation',`let callable;try{Audio()}catch(error){callable=error.name}result={prototype:Audio.prototype===HTMLAudioElement.prototype,constructor:Audio.prototype.constructor===HTMLAudioElement,length:Audio.length,name:Audio.name,callable};`],
      ['derived construction',`class Derived extends Audio{marker=42;}const audio=new Derived('data:audio/wav,');result={derived:audio instanceof Derived,native:audio instanceof HTMLAudioElement,marker:audio.marker,src:audio.getAttribute('src'),preload:audio.preload};`],
      ['conversion and newTarget order',`const order=[],target=new Proxy(function(){},{get(target,key,receiver){if(key==='prototype')order.push('prototype');return Reflect.get(target,key,receiver);}});const audio=Reflect.construct(Audio,[{toString(){order.push('string');return 'data:audio/wav,';}}],target);result={order,prototype:Object.getPrototypeOf(audio)===target.prototype,src:Element.prototype.getAttribute.call(audio,'src'),preload:Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'preload').get.call(audio)};`],
      ['throwing URL conversion',`let calls=0,error;try{new Audio({toString(){calls++;throw new RangeError('source')}})}catch(value){error={name:value.name,message:value.message}}result={calls,error};`],
      ['object-to-symbol conversion',`let error;try{new Audio({[Symbol.toPrimitive](){return Symbol('source')}})}catch(value){error=value.name}result=error;`]
    ];
    for(const [name,body] of cases){
      const source=`(()=>{let result;${body}return JSON.stringify(result)})()`;
      const expected=await native.evaluate(source=>eval(source),source),actual=await evaluate(source);
      if(actual!==expected)throw new Error('Audio '+name+' differs: '+actual+' expected '+expected);
    }
    await evaluate(`globalThis.constructedAudio=new Audio('detached.wav');globalThis.emptyAudio=new Audio();emptyAudio.src='assigned.wav';globalThis.derivedAudio=new(class extends Audio{})('derived.wav');true`);
    const until=async source=>{
      const deadline=Date.now()+10000;
      while(!await evaluate(source)){
        if(Date.now()>deadline)throw new Error('Audio condition timed out: '+source);
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    };
    await until(`[constructedAudio,emptyAudio,derivedAudio].every(audio=>audio.readyState>=1)`);
    if(!await evaluate(`constructedAudio.src==='${origin}/assets/detached.wav'&&constructedAudio.currentSrc===constructedAudio.src&&constructedAudio.getAttribute('src')==='detached.wav'&&!constructedAudio.isConnected`))throw new Error('Detached Audio URL reflection failed');
    await evaluate(`constructedAudio.src='slow.wav';true`);
    await page.waitForFunction(()=>typeof releaseConstructorAudio==='function');
    await evaluate(`constructedAudio.src='latest.wav';true`);
    await until(`constructedAudio.readyState>=1&&constructedAudio.currentSrc==='${origin}/assets/latest.wav'`);
    await page.evaluate(()=>releaseConstructorAudio());
    // A subsequent response barrier ensures the held response has been delivered.
    const failed=await evaluate(`new Promise(resolve=>{const audio=new Audio('missing.wav');audio.onerror=()=>resolve(audio.src);})`);
    if(failed!==origin+'/assets/missing.wav'||!await evaluate(`constructedAudio.currentSrc==='${origin}/assets/latest.wav'`))throw new Error('Audio failure or source replacement failed');
    const unrelated=await evaluate(`new Promise(resolve=>{const audio=Reflect.construct(Audio,['unrelated-missing.wav'],function(){});EventTarget.prototype.addEventListener.call(audio,'error',event=>resolve(event.type==='error'&&event.target===audio));})`);
    if(!unrelated)throw new Error('Audio with an unrelated newTarget lost native event dispatch');
    const requests=await page.evaluate(()=>audioConstructorRequests);
    for(const file of ['detached.wav','assigned.wav','derived.wav','slow.wav','latest.wav','missing.wav'])if(!requests.includes(origin+'/assets/'+file))throw new Error('Audio did not use relay: '+file);
    if(direct.length)throw new Error('Audio issued direct requests: '+JSON.stringify(direct));
    return ['Audio constructors preserve native coercion, prototypes and subclassing','Detached Audio loading, errors and source replacement use the relay'];
  } finally {
    await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);
  }
}
