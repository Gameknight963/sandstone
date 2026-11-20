import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const feature='focus-without-user-activation';
function documents(origin,cross){
const cases=[
  {id:'same',url:origin+'/child'}, {id:'cross',url:cross+'/child'},
  {id:'none',url:origin+'/child',allow:feature+" 'none'"},
  {id:'self',url:origin+'/child',allow:feature+" 'self'"},
  {id:'cross-self',url:cross+'/child',allow:feature+" 'self'"},
  {id:'source',url:cross+'/child',allow:feature},
  {id:'explicit',url:cross+'/child',allow:feature+' '+cross},
  {id:'opaque',url:origin+'/child',sandbox:'allow-scripts'},
  {id:'opaque-source',url:origin+'/child',sandbox:'allow-scripts',allow:feature},
  {id:'same-sandbox',url:origin+'/child',sandbox:'allow-scripts allow-same-origin'},
  {id:'same-sandbox-self',url:origin+'/child',sandbox:'allow-scripts allow-same-origin',allow:feature+" 'self'"},
  {id:'redirect-source',url:origin+'/redirect',allow:feature},
  {id:'other-directives',url:origin+'/child',allow:'autoplay; fullscreen'}
];
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
const parent='<!doctype html><body><input id="outside"><script>globalThis.policyRows=[];addEventListener("message",event=>{if(event.data?.policyFocus)policyRows.push(event.data);});</script>'+cases.map(test=>'<iframe name="'+test.id+'" src="'+test.url+'"'+(test.allow===undefined?'':' allow="'+escape(test.allow)+'"')+(test.sandbox===undefined?'':' sandbox="'+test.sandbox+'"')+'></iframe>').join('');
return {cases,parent};
}
const child=`<!doctype html><body><input id="target"><script>
const target=document.getElementById('target');target.focus();
parent.postMessage({policyFocus:true,id:name,allowed:document.featurePolicy.allowsFeature('${feature}'),focused:document.activeElement===target,activation:navigator.userActivation.isActive},'*');
</script>`;

export async function verifyIframeFocusPolicy(page,expectDiagnostics=()=>{}){
  let parent,cross;
  const serve=(request,response)=>{const url=new URL(request.url,'http://local');if(url.pathname==='/redirect'){response.writeHead(302,{location:cross+'/child'});response.end();return;}response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});response.end(url.pathname==='/parent'?parent:child);};
  const servers=[createServer(serve),createServer(serve)];
  await Promise.all(servers.map(async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');}));
  const origin='http://127.0.0.1:'+servers[0].address().port;cross='http://127.0.0.1:'+servers[1].address().port;
  const data=documents(origin,cross),cases=data.cases;parent=data.parent;
  const native=await page.context().newPage(),errors=[],direct=[],onError=error=>errors.push(error.message);
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=async(proxy,source)=>JSON.parse(await evaluate(proxy,'JSON.stringify('+source+')'));
  const wait=async(proxy,source)=>{const end=Date.now()+15000;while(!await evaluate(proxy,source)){if(Date.now()>end)throw new Error('Frame focus policy timed out: '+source+' proxy='+proxy+' rows='+await evaluate(proxy,'JSON.stringify(policyRows)'));await new Promise(resolve=>setTimeout(resolve,20));}};
  const snapshot=proxy=>read(proxy,`({rows:policyRows.slice().sort((a,b)=>a.id.localeCompare(b.id)),attributes:[...document.querySelectorAll('iframe')].map(frame=>({id:frame.name,allow:frame.allow,attribute:frame.getAttribute('allow'),present:frame.hasAttribute('allow'),clone:frame.cloneNode().getAttribute('allow'),serialized:frame.outerHTML.includes('${feature}')}))})`);
  const edits=async proxy=>JSON.parse(await evaluate(proxy,`(async()=>{
    const frame=document.querySelector('iframe[name=self]'),old=[];
    let policyReads=0;Object.defineProperty(frame,'featurePolicy',{configurable:true,get(){policyReads++;throw new Error('Authored policy getter must not run');}});
    const observer=new MutationObserver(records=>old.push(...records.map(record=>record.oldValue)));observer.observe(frame,{attributes:true,attributeOldValue:true,attributeFilter:['allow']});
    frame.allow="${feature} 'none'";frame.setAttribute('allow','${feature} *');frame.getAttributeNode('allow').value="${feature} 'self'";
    await Promise.resolve();observer.disconnect();delete frame.featurePolicy;return JSON.stringify({old,allow:frame.allow,attribute:frame.getAttribute('allow'),clone:frame.cloneNode().allow,policyReads});
  })()`));
  try{
    await native.goto(origin+'/parent');await wait(false,'policyRows.length==='+cases.length);const expected=await snapshot(false),expectedEdits=await edits(false);
    assert.equal(expected.rows.find(row=>row.id==='same').allowed,true);assert.equal(expected.rows.find(row=>row.id==='none').allowed,false);
    assert.equal(expected.rows.every(row=>row.activation===false),true,'Focus checks require documents without user activation');
    await page.evaluate(({origin,cross,parent,child})=>{
      globalThis.framePolicyPrevious=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(![origin,cross].includes(new URL(url).origin))return framePolicyPrevious(url,options);
        if(new URL(url).pathname==='/redirect')return new Response(null,{status:302,headers:{location:cross+'/child'}});
        return new Response(new URL(url).pathname==='/parent'?parent:child,{headers:{'content-type':'text/html'}});
      };
    },{origin,cross,parent,child});
    expectDiagnostics(['Permissions policy violation: focus-without-user-activation is not allowed in this document.']);
    page.on('pageerror',onError);
    const request=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};page.on('request',request);
    try{
      await page.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');await wait(true,'policyRows.length==='+cases.length);
      assert.deepEqual(await snapshot(true),expected);assert.deepEqual(await edits(true),expectedEdits);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    }finally{page.off('request',request);}
    return ['Iframe automatic focus matches native same-origin, cross-origin and sandbox policy decisions','Iframe focus grants follow self/src/origin allowlists and redirect destinations','Physical iframe focus grants preserve authored attributes, cloning, serialization and observed edits'];
  }finally{page.off('pageerror',onError);await page.evaluate(()=>{if(globalThis.framePolicyPrevious){sandstone.network.session.fetch=framePolicyPrevious;delete globalThis.framePolicyPrevious;}});await native.close();for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
}
