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
