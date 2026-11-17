import assert from 'node:assert/strict';

export function cookie_fixture(request,response,url){
  if(!url.pathname.startsWith('/cookie-policy/'))return false;
  const headers={'Content-Type':'text/html','Access-Control-Allow-Origin':request.headers.origin||'*','Access-Control-Allow-Credentials':'true','Cache-Control':'no-store'};
  if(url.pathname.endsWith('/set'))headers['Set-Cookie']=[
    'cp_default=d; Path=/cookie-policy/','cp_lax=l; SameSite=Lax; Path=/cookie-policy/',
    'cp_strict=s; SameSite=Strict; Path=/cookie-policy/','cp_none=n; SameSite=None; Secure; Path=/cookie-policy/',
    'cp_insecure=bad; SameSite=None; Path=/cookie-policy/'
  ];
  response.writeHead(200,headers);
  response.end(url.pathname.endsWith('/echo')?JSON.stringify((request.headers.cookie||'').split('; ').filter(value=>value.startsWith('cp_')).sort()):'<!doctype html><body>Cookie fixture');
  return true;
}

export async function verify_cookie_storage(navigate,evaluate,origin){
  const cross=origin.replace('127.0.0.1','localhost'),results=[];
  await navigate(origin+'/cookie-policy/page');
  results.push(JSON.parse(await evaluate(`(async()=>{
    document.cookie='cp_script_bad=bad; SameSite=None; Path=/cookie-policy/';
    const own=document.cookie.split('; ').filter(value=>value.startsWith('cp_')).sort();
    await (await fetch(${JSON.stringify(cross+'/cookie-policy/set')},{credentials:'include'})).text();
    const remote=await (await fetch(${JSON.stringify(cross+'/cookie-policy/echo')},{credentials:'include'})).json();
    return JSON.stringify({own,remote});
  })()`)));
  assert.deepEqual(results[0],{own:[],remote:['cp_none=n']});
  await navigate(cross+'/cookie-policy/page');
  results.push(JSON.parse(await evaluate(`(async()=>{
    const before=document.cookie.split('; ').filter(value=>value.startsWith('cp_')).sort();
    document.cookie='cp_script_bad=bad; SameSite=None; Path=/cookie-policy/';
    document.cookie='cp_script_good=good; SameSite=None; Secure; Path=/cookie-policy/';
    await (await fetch('/cookie-policy/set')).text();
    const after=document.cookie.split('; ').filter(value=>value.startsWith('cp_')).sort();
    const remote=await (await fetch('/cookie-policy/echo')).json();
    return JSON.stringify({before,after,remote});
  })()`)));
  assert.deepEqual(results[1],{before:['cp_none=n'],after:['cp_default=d','cp_lax=l','cp_none=n','cp_script_good=good','cp_strict=s'],remote:['cp_default=d','cp_lax=l','cp_none=n','cp_script_good=good','cp_strict=s']});
  return results;
}

export const embedded_cookie_script=`(async()=>{
  const visible=()=>document.cookie.split('; ').filter(value=>value.startsWith('cp_')).sort();
  const before=visible();
  document.cookie='cp_embedded=blocked; Path=/cookie-policy/';
  document.cookie='cp_embedded_lax=blocked; SameSite=Lax; Path=/cookie-policy/';
  document.cookie='cp_embedded_none=allowed; SameSite=None; Secure; Path=/cookie-policy/';
  const after=visible();
  const remote=await (await fetch('/cookie-policy/echo',{credentials:'include'})).json();
  const refreshed=visible();
  const kept=await (await fetch('/cookie-policy/echo',{credentials:'include',keepalive:true})).json();
  return JSON.stringify({before,after,remote,refreshed,kept});
})()`;

export async function verify_embedded_cookies(page,navigate,evaluate,origin,proxied=false){
  await navigate(origin+'/cookie-policy/page?frame=root');
  await evaluate('(async()=>{await (await fetch("/cookie-policy/set")).text();return true;})()');
  async function child(parent,url){
    await parent('(()=>{const child=document.createElement("iframe");child.src='+JSON.stringify(url)+';document.body.append(child);return true;})()');
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      for(const frame of page.frames()){
        const ready=proxied?await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.loader.ready_state==='complete',url).catch(()=>false):frame.url()===url;
        if(ready){
          if(!proxied)await frame.waitForLoadState();
          return source=>frame.evaluate(({source,proxied})=>proxied?sandstone_frame.context.run_script(source):eval(source),{source,proxied});
        }
      }
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('Embedded cookie fixture did not load: '+url);
  }
  const middle=await child(evaluate,origin.replace('127.0.0.1','localhost')+'/cookie-policy/page?frame=middle');
  const first=JSON.parse(await middle(embedded_cookie_script));
  const leaf=await child(middle,origin+'/cookie-policy/page?frame=leaf');
  const second=JSON.parse(await leaf(embedded_cookie_script));
  for(const result of [first,second]){
    assert.ok(!result.before.some(value=>/^cp_(default|lax|strict)=/.test(value)));
    assert.deepEqual(result.after,[...result.before,'cp_embedded_none=allowed'].sort());
    assert.deepEqual(result.remote,result.after);assert.deepEqual(result.refreshed,result.after);assert.deepEqual(result.kept,result.after);
  }
  assert.deepEqual(second.before,['cp_none=n']);
  return [first,second];
}
