import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verify_shared_owners(browser,origin){
  const context=await browser.newContext(),session=await browser.newBrowserCDPSession();
  const deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
  const load=async()=>{
    const page=await context.newPage();await page.goto(origin+'/host-worker/page');await page.addScriptTag({url:origin+'/host-worker/bundle.js'});return page;
  };
  const exists=async url=>(await session.send('Target.getTargets')).targetInfos.some(target=>target.type==='shared_worker'&&target.url===url);
  const connect=(page,profile)=>page.evaluate(async profile=>{
    globalThis.owner=await sandstone.shared_worker_owners.create(profile);globalThis.connection=await owner.connect();
    connection.port.start();globalThis.exchange=value=>new Promise(resolve=>{connection.port.onmessage=event=>resolve(event.data);connection.port.postMessage(value);});
    return exchange('connected');
  },profile);
  try{
    const first=await load(),second=await load(),token=crypto.randomUUID();
    const source='/* '+token+' */let count=0;onconnect=event=>{const port=event.ports[0];port.onmessage=event=>{let storage;try{indexedDB.open("must-not-access-host");storage="opened";}catch(error){storage=error.name;}port.postMessage({count:++count,value:event.data,origin,storage});};port.start();};';
    const profile={url:'data:text/javascript,'+encodeURIComponent(source),name:'owner-'+token};
    assert.deepEqual(await connect(first,profile),{count:1,value:'connected',origin:'null',storage:'SecurityError'});
    assert.deepEqual(await connect(second,profile),{count:2,value:'connected',origin:'null',storage:'SecurityError'});
    assert.equal(await first.evaluate(()=>{const iframe=document.querySelector('iframe');return iframe.hidden&&iframe.getBoundingClientRect().width===0&&iframe.getBoundingClientRect().height===0;}),true);
    await first.evaluate(()=>owner.close());
    assert.equal(await first.evaluate(()=>document.querySelectorAll('iframe').length),0);
    assert.equal((await second.evaluate(()=>exchange('after first owner closes'))).count,3);
    assert.equal(await exists(profile.url),true);
    await second.evaluate(()=>owner.close());await wait_for(async()=>!await exists(profile.url),{timeout:15000});
    assert.equal((await connect(first,profile)).count,1);
    await first.evaluate(()=>document.querySelector('iframe').remove());
    assert.equal(await first.evaluate(async()=>{await owner.closed;return owner.isClosed;}),true);
    await wait_for(async()=>!await exists(profile.url),{timeout:15000});
    const busy={url:'data:text/javascript,'+encodeURIComponent('/* '+crypto.randomUUID()+' */onconnect=event=>{event.ports[0].postMessage("busy");while(true){}}'),name:'busy-owner',extendedLifetime:true};
    assert.equal(await second.evaluate(async profile=>{
      globalThis.owner=await sandstone.shared_worker_owners.create(profile);globalThis.connection=await owner.connect();
      return new Promise(resolve=>{connection.port.onmessage=event=>resolve(event.data);});
    },busy),'busy');
    await wait_for(()=>exists(busy.url));assert.equal(await second.evaluate(()=>document.body.isConnected),true);
    await second.evaluate(()=>owner.close());await wait_for(async()=>!await exists(busy.url),{timeout:15000});
    const cancellation=await second.evaluate(async profile=>{
      const controller=new AbortController(),reason={cancelled:true},creating=sandstone.shared_worker_owners.create({...profile,signal:controller.signal});
      controller.abort(reason);let identical=false;try{await creating;}catch(error){identical=error===reason;}
      const owner=await sandstone.shared_worker_owners.create(profile),pending=owner.connect();owner.close();
      let pendingError,nextError;try{await pending;}catch(error){pendingError=error.name;}
      try{await owner.connect();}catch(error){nextError=error.name;}
      return {identical,pendingError,nextError,closed:owner.isClosed,iframes:document.querySelectorAll('iframe').length};
    },profile);
    assert.deepEqual(cancellation,{identical:true,pendingError:'AbortError',nextError:'InvalidStateError',closed:true,iframes:0});
    await wait_for(async()=>!await exists(profile.url),{timeout:15000});
    const rejected=await second.evaluate(async()=>{
      const url=URL.createObjectURL(new Blob(['onconnect=()=>{}'],{type:'text/javascript'}));
      try{await sandstone.shared_worker_owners.create({url});return 'accepted';}catch(error){return error.name;}finally{URL.revokeObjectURL(url);}
    });assert.equal(rejected,'SecurityError');
    const error=await second.evaluate(async()=>{
      globalThis.owner=await sandstone.shared_worker_owners.create({url:'data:text/javascript,'+encodeURIComponent('throw new Error("owned worker failure")')});
      const failed=new Promise(resolve=>owner.events.addEventListener('error',event=>resolve({client:event.data.client,message:!!event.data.message}),{once:true}));
      const connection=await owner.connect(),result=await failed;connection.port.close();owner.close();return result;
    });assert.deepEqual(error,{client:1,message:true});
    const blocked=await second.evaluate(async profile=>{
      const csp=document.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content="script-src 'none'";document.head.append(csp);
      try{await sandstone.shared_worker_owners.create(profile);return {name:'accepted'};}
      catch(error){return {name:error.name,iframes:document.querySelectorAll('iframe').length};}
    },profile);assert.deepEqual(blocked,{name:'SecurityError',iframes:0});
    return ['Hidden owner documents share opaque workers without granting host-origin storage','Removing one native owner preserves other clients and removing the last owner ends its worker','Unexpected owner document removal settles its controller and releases the worker','Native ownership removal stops a worker whose JavaScript never yields','Owner cancellation rejects pending connections and removes hidden documents','Owner bootstrap rejects host-origin worker URLs and reports asynchronous worker errors','A blocked owner bootstrap rejects immediately and removes its hidden document'];
  }finally{clearTimeout(deadline);await context.close();await session.detach();}
}
