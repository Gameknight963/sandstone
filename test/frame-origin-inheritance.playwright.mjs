import assert from 'node:assert/strict';

const cases=[
  {middle:'http'},
  {middle:'data'},
  {middle:'data',sandbox:'allow-scripts allow-same-origin'},
  {middle:'http',sandbox:'allow-scripts'},
  {middle:'data',sandbox:'allow-scripts'},
  {middle:'http',sandbox:'allow-scripts allow-same-origin'},
  {middle:'data',childSandbox:'allow-scripts'},
  {middle:'http',childSandbox:'allow-scripts'}
];

export async function verifyFrameOriginInheritance(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://frame-origin.test',errors=[],direct=[];
  let current;
  const html=(url,profile)=>{
    const origin='https://frame-origin.test',other='https://frame-origin-other.test',path=new URL(url).pathname;
    const leaf='<!doctype html><script>(async()=>{const attempt=operation=>{try{return {value:operation()};}catch(error){return {error:error.name};}};const profile={origin:window.origin,location:location.origin,storage:attempt(()=>{localStorage.setItem("frame-origin-key","works");return localStorage.getItem("frame-origin-key");})};try{profile.request=await (await fetch("'+origin+'/echo",{method:"POST",body:"origin",credentials:"omit"})).json();}catch(error){profile.request={error:error.name};}top.postMessage({profile},"*");})();</script>';
    const middle='<!doctype html><iframe '+(profile.childSandbox?'sandbox="'+profile.childSandbox+'" ':'')+'src="'+origin+'/leaf"></iframe>';
    if(path==='/leaf')return leaf;if(path==='/middle')return middle;
    const source=profile.middle==='data'?'data:text/html,'+encodeURIComponent(middle):other+'/middle';
    return '<!doctype html><script>onmessage=event=>{if(event.data?.profile)globalThis.profile={...event.data.profile,messageOrigin:event.origin};};</script><iframe '+(profile.sandbox?'sandbox="'+profile.sandbox+'" ':'')+'src="'+source+'"></iframe>';
  };
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async predicate=>{const deadline=Date.now()+8000;while(!await predicate()){if(Date.now()>deadline)throw new Error('Frame origin inheritance did not complete');await fixture.waitForTimeout(20);}};
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(/^https:\/\/frame-origin(?:-other)?\.test\//,async route=>{
      if(new URL(route.request().url()).pathname==='/echo')return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({origin:(await route.request().allHeaders()).origin||null})});
      return route.fulfill({contentType:'text/html',body:html(route.request().url(),current)});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(body=>{
      const html=(0,eval)('('+body+')');globalThis.originProfile=null;main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{
        const echo=new URL(url).pathname==='/echo';
        return new Response(echo?JSON.stringify({origin:new Headers(options.headers).get('origin')}):html(url,originProfile),{headers:{'content-type':echo?'application/json':'text/html','access-control-allow-origin':'*','cache-control':'no-store'}});
      };
    },html.toString());
    for(const profile of cases){
      current=profile;const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Frame origin inheritance',...profile,proxy}));
        if(proxy){await fixture.evaluate(profile=>{originProfile=profile;},profile);await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');}
        else await native.goto(origin+'/root');
        await wait(()=>read(proxy,'!!globalThis.profile'));
        results.push(JSON.parse(await read(proxy,'JSON.stringify(profile)')));
      }
      assert.deepEqual(results[1],results[0],JSON.stringify(profile));
      const opaque=profile.childSandbox||profile.sandbox&&!profile.sandbox.includes('allow-same-origin');
      assert.equal(results[0].origin,opaque?'null':origin);assert.equal(results[0].messageOrigin,opaque?'null':origin);
      assert.deepEqual(results[0].storage,opaque?{error:'SecurityError'}:{value:'works'});
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await nativeContext.close();}
  return ['HTTPS descendants of data frames retain their own origin, Web Storage and Fetch Origin headers','Sandboxed-origin flags inherit through frame trees without confusing opaque URL origins with sandbox restrictions'];
}
