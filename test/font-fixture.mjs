import {test_font} from './test-font.mjs';

const font = await test_font();

export function font_fixture() {
  const requests = [];
  return {
    handle(request, response, url) {
      if (!url.pathname.startsWith('/fonts/')) return false;
      const client = url.searchParams.get('client');
      const own = 'http://127.0.0.1:' + request.headers.host.split(':').at(-1);
      const cross = own.replace('127.0.0.1', 'localhost');
      const query = '?client=' + encodeURIComponent(client);
      if (url.pathname.endsWith('/page')) {
        response.writeHead(200, {'Content-Type':'text/html', 'Set-Cookie':'font_session=own; SameSite=Lax; Path=/fonts/'});
        response.end('<!doctype html><link rel="stylesheet" href="/fonts/style.css'+query+'"><body>Font fixture');
      } else if (url.pathname.endsWith('.js')) {
        response.writeHead(200,{'Content-Type':'application/javascript'});
        response.end('onmessage=async()=>{try{const face=new FontFace("WorkerFont",'+JSON.stringify('url("ctor-worker.ttf'+query+'")')+');await face.load();fonts.add(face);const found=await fonts.load("20px WorkerFont","AAA");const context=new OffscreenCanvas(100,30).getContext("2d");context.font="20px WorkerFont";postMessage({status:face.status,has:fonts.has(face),identity:found[0]===face,width:context.measureText("AAA").width});}catch(error){postMessage({error:error.name+": "+error.message});}}');
      } else if (url.pathname.endsWith('.css')) {
        response.writeHead(200, {'Content-Type':'text/css', 'Referrer-Policy':'unsafe-url'});
        response.end('@font-face {font-family:OwnFont;src:url("same.ttf'+query+'") format("truetype")}'+
          '@font-face {font-family:CrossFont;src:url("'+cross+'/fonts/cross.ttf'+query+'") format("truetype")}');
      } else {
        requests.push({client, path:url.pathname, origin:request.headers.origin||null,
          referrer:request.headers.referer||null, cookie:(request.headers.cookie||'').split('; ').filter(value=>value.startsWith('font_')).sort().join('; ')});
        const allowed = !url.pathname.endsWith('cross.ttf') || request.headers.origin === own && !request.headers.cookie;
        if (url.pathname.endsWith('-denied.ttf')) {
          response.writeHead(404,{'Access-Control-Allow-Origin':own});response.end();return true;
        }
        response.writeHead(allowed ? 200 : 403, {'Content-Type':'font/ttf', 'Access-Control-Allow-Origin':own});
        if (url.pathname.endsWith('/ctor-slow.ttf') || url.pathname.endsWith('/ctor-clear.ttf')) setTimeout(()=>response.end(font),50);
        else response.end(allowed ? font : 'Font request rejected');
      }
      return true;
    },
    values(client) {
      return requests.filter(value=>value.client===client).map(({client,...value})=>({...value,
        referrer:value.referrer?.replace('client='+encodeURIComponent(client),'client=CLIENT')||null
      })).sort((a,b)=>a.path.localeCompare(b.path));
    }
  };
}

export const font_script = client => `(async()=>{
  const deadline=Date.now()+10000;
  let sheet;
  while(!(sheet=document.querySelector('link').sheet)||sheet.cssRules.length<2){
    if(Date.now()>deadline)throw new Error('Font stylesheet missing');await new Promise(resolve=>setTimeout(resolve,10));
  }
  const results=[];
  const verify=async family=>{
    const faces=await document.fonts.load('20px '+family,'AAA');
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    context.font='20px '+family;
    results.push({family,count:faces.length,status:faces[0]?.status,width:context.measureText('AAA').width});
  };
  await verify('OwnFont');await verify('CrossFont');
  sheet.insertRule('@font-face{font-family:DynamicFont;src:url("/fonts/inserted.ttf?client='+${JSON.stringify(client)}+'")}',sheet.cssRules.length);
  const rule=sheet.cssRules[sheet.cssRules.length-1];
  const ready=async()=>{
    while(rule.style.getPropertyValue('src').includes('sandstone-css-')){
      if(Date.now()>deadline)throw new Error('Font CSSOM hydration timed out');await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  await ready();await verify('DynamicFont');
  rule.style.setProperty('src','url("/fonts/edited.ttf?client='+${JSON.stringify(client)}+'")');
  await ready();await verify('DynamicFont');
  rule.style.src='url("/fonts/property.ttf?client='+${JSON.stringify(client)}+'")';
  await ready();await verify('DynamicFont');
  rule.style.cssText='font-family:DynamicFont;src:url("/fonts/text.ttf?client='+${JSON.stringify(client)}+'")';
  await ready();await verify('DynamicFont');
  return JSON.stringify(results);
})()`;

export const constructor_font_script = client => `(async()=>{
  const results={};
  const source=name=>'url("/fonts/ctor-'+name+'.ttf?client='+${JSON.stringify(client)}+'")';
  const face=new FontFace('CtorFont',source('load'),{weight:'400',display:'swap'});
  const promise=face.loaded;
  results.initial={status:face.status,instance:face instanceof FontFace,constructor:face.constructor===FontFace,stable:promise===face.loaded};
  const pending=face.load();
  results.loading={status:face.status,samePromise:pending===promise};
  face.weight='500';
  results.loaded={identity:await pending.catch(error=>{throw new Error('Explicit FontFace load: '+error.name);})===face,repeat:FontFace.prototype.load.call(face)===promise,status:face.status,weight:face.weight};
  document.fonts.add(face);
  const width=family=>{const context=document.createElement('canvas').getContext('2d');context.font='20px '+family;return context.measureText('AAA').width;};
  results.membership={has:document.fonts.has(face),iterator:[...document.fonts].includes(face),keys:[...document.fonts.keys()].includes(face),entries:[...document.fonts.entries()].some(([a,b])=>a===face&&b===face)};
  let each=false;document.fonts.forEach((a,b,set)=>{if(a===face)each=a===b&&set===document.fonts;});results.membership.each=each;
  face.family='RenamedFont';face.weight='400';results.width=width('RenamedFont');
  const events=[];
  const listener=event=>events.push({type:event.type,faces:Array.from(event.fontfaces||[],font=>font.family).sort(),identity:!event.fontfaces?.length||Array.from(event.fontfaces).every(font=>[...document.fonts].includes(font))});
  for(const type of ['loading','loadingdone','loadingerror'])document.fonts.addEventListener(type,listener);
  const automatic=new FontFace('AutoFont',source('auto'));
  document.fonts.add(automatic);
  await new Promise(resolve=>setTimeout(resolve,20));
  results.lazy=automatic.status;
  const text=document.createElement('span');text.style.font='20px AutoFont';text.textContent='AAA';document.body.append(text);text.getBoundingClientRect();
  const cssText=document.createElement('span');cssText.style.font='20px OwnFont';cssText.textContent='AAA';document.body.append(cssText);cssText.getBoundingClientRect();
  await document.fonts.ready;await automatic.loaded.catch(error=>{throw new Error('Automatic FontFace load: '+error.name);});
  results.automatic={status:automatic.status,width:width('AutoFont'),cssWidth:width('OwnFont'),has:document.fonts.has(automatic)};
  await new Promise(resolve=>setTimeout(resolve,30));
  results.events=events;
  for(const type of ['loading','loadingdone','loadingerror'])document.fonts.removeEventListener(type,listener);
  const bySet=new FontFace('SetFont',source('set'));
  document.fonts.add(bySet);
  const setResult=await document.fonts.load('20px SetFont','AAA').catch(error=>{throw new Error('FontFaceSet load: '+error.name);});
  results.setLoad={count:setResult.length,identity:setResult[0]===bySet,width:width('SetFont'),has:document.fonts.has(bySet)};
  results.delete={deleted:document.fonts.delete(automatic),has:document.fonts.has(automatic)};
  text.remove();cssText.remove();
  const bytes=await (await fetch('/fonts/ctor-binary.ttf?client='+${JSON.stringify(client)})).arrayBuffer();
  const binary=new FontFace('BinaryFont',bytes);await binary.loaded;document.fonts.add(binary);
  results.binary={status:binary.status,width:width('BinaryFont'),identity:await binary.loaded===binary};
  const cross=new FontFace('CrossCtor',source('cross').replace('/fonts/',location.origin.replace('127.0.0.1','localhost')+'/fonts/'));
  await cross.load();document.fonts.add(cross);results.cross=width('CrossCtor');document.fonts.delete(cross);
  const base=document.createElement('base');base.href='/fonts/base/';document.head.append(base);
  const based=new FontFace('BasedFont','url("ctor-based.ttf?client='+${JSON.stringify(client)}+'")');base.remove();
  await based.load();document.fonts.add(based);results.base=width('BasedFont');document.fonts.delete(based);
  const data=new FontFace('DataFont','url(data:font/ttf;base64,'+btoa(String.fromCharCode(...new Uint8Array(bytes)))+')');
  await data.load();document.fonts.add(data);results.data=width('DataFont');document.fonts.delete(data);
  const failed=new FontFace('FailedFont',source('denied'));
  let failure;try{await failed.load();}catch(error){failure=error.name;}
  document.fonts.add(failed);
  results.failure={error:failure,status:failed.status,repeated:failed.load()===failed.loaded};
  failed.load().catch(()=>{});
  try{await document.fonts.load('20px FailedFont');results.failure.set='resolved';}catch(error){results.failure.set=error.name;}
  results.failure.unrelated=(await document.fonts.load('20px SetFont'))[0]===bySet;
  document.fonts.delete(failed);
  const automaticFailure=new FontFace('AutoFailedFont',source('auto-denied'));
  const failedEvents=[];
  const failureListener=event=>failedEvents.push({type:event.type,faces:Array.from(event.fontfaces||[],font=>font.family).sort()});
  for(const type of ['loading','loadingdone','loadingerror'])document.fonts.addEventListener(type,failureListener);
  document.fonts.add(automaticFailure);
  const failedText=document.createElement('span');failedText.style.font='20px AutoFailedFont';failedText.textContent='AAA';document.body.append(failedText);failedText.getBoundingClientRect();
  await document.fonts.ready;
  results.autoFailure={status:automaticFailure.status,error:await automaticFailure.loaded.then(()=>null,error=>error.name),check:document.fonts.check('20px AutoFailedFont')};
  await new Promise(resolve=>setTimeout(resolve,30));results.autoFailure.events=failedEvents;
  for(const type of ['loading','loadingdone','loadingerror'])document.fonts.removeEventListener(type,failureListener);
  document.fonts.delete(automaticFailure);failedText.remove();
  const setFailure=new FontFace('SetFailedFont',source('set-denied'));document.fonts.add(setFailure);
  results.setFailure=await document.fonts.load('20px SetFailedFont').then(()=>null,error=>error.name);document.fonts.delete(setFailure);
  const conversions=[];
  class CustomFontFace extends FontFace {}
  const custom=new CustomFontFace({toString(){conversions.push('family');return 'CustomFont';}},
    {toString(){conversions.push('source');return source('custom');}},
    {get weight(){conversions.push('weight');return '400';}});
  await custom.load();document.fonts.add(custom);
  results.custom={subclass:custom instanceof CustomFontFace,base:custom instanceof FontFace,conversions,width:width('CustomFont')};document.fonts.delete(custom);
  const invalid=new FontFace('InvalidFont','not a source');
  results.invalid={status:invalid.status,error:await invalid.loaded.then(()=>null,error=>error.name)};
  const removed=new FontFace('RemovedFont',source('slow'));document.fonts.add(removed);
  const removalLoad=removed.load();
  results.removal={hasDuring:document.fonts.has(removed),deleted:document.fonts.delete(removed)};
  await removalLoad;results.removal.hasAfter=document.fonts.has(removed);
  const late=new FontFace('LateFont',source('unused'));
  const iterator=document.fonts.values();const visited=[];
  for(const font of iterator){visited.push(font.family);if(font===bySet)document.fonts.add(late);}
  results.iteration=visited.filter(name=>['RenamedFont','SetFont','BinaryFont','LateFont'].includes(name));
  document.fonts.delete(late);
  results.worker=await new Promise((resolve,reject)=>{
    const worker=new Worker('/fonts/ctor-worker.js?client='+${JSON.stringify(client)});
    const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Worker FontFace timed out'));},10000);
    worker.onmessage=event=>{clearTimeout(timeout);worker.terminate();resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();clearTimeout(timeout);worker.terminate();reject(new Error(event.message));};worker.postMessage('load');
  });
  document.fonts.delete(face);document.fonts.delete(bySet);document.fonts.delete(binary);
  const cleared=new FontFace('ClearedFont',source('clear'));document.fonts.add(cleared);const clearing=cleared.load();document.fonts.clear();await clearing;
  results.cleared=document.fonts.has(cleared);
  return JSON.stringify(results);
})()`;
