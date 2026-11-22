import assert from 'node:assert/strict';

export async function verify_worker_host_origins(browser,origin){
  const passed=[];
  for(const denied of [false,true]){
    const context=await browser.newContext(),deadline=setTimeout(()=>context.close().catch(()=>{}),45000),page=await context.newPage();
    try{
      await page.goto(origin+'/host-worker/page');
      if(denied)await page.evaluate(()=>{for(const key of ['localStorage','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw new DOMException('Storage denied','SecurityError');}});});
      await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
      const result=await page.evaluate(async()=>{
        const hosts=[],creator_url='https://worker-origin.test/page',top_url='https://top-origin.test/page';
        const urls=['https://worker-origin.test/entry.js','blob:https://worker-origin.test/id','blob:null/id','data:text/javascript,0','data:text/javascript,0'];
        const open=url=>{
          const channel=new MessageChannel(),host=new sandstone.WorkerServiceHost({url,creator_url,top_url},channel.port1);
          let sequence=0;const pending=new Map();channel.port2.onmessage=event=>{const resolve=pending.get(event.data.id);pending.delete(event.data.id);resolve(event.data.content);};
          const request=(procedure,args)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);channel.port2.postMessage({type:'procedure',id,procedure,arguments:args});});
          const value={host,port:channel.port2,request};hosts.push(value);return value;
        };
        try{
          for(const url of urls)open(url);
          const database=async(client,write)=>{
            const command=async cmd=>{const reply=await client.request('idb_command',[client.host.id,cmd]);if(!reply.success)throw reply.value;return reply.value;};
            const wait=async(target,type)=>{
              for(;;){
                const reply=await client.request('idb_poll',[client.host.id]);if(!reply.success)throw reply.value;
                for(const event of reply.value){
                  if(event.type==='error'||event.type==='abort')throw new Error(JSON.stringify(event));
                  if(event.type==='upgradeneeded'){await command({op:'schema',transaction:'upgrade',method:'createObjectStore',store:'records'});await command({op:'release',transaction:'upgrade'});}
                  if(event.target===target&&event.type===type)return event.value;
                }
              }
            };
            await command({op:'open',name:'retained-origin',version:1,database:'db',request:'open',transaction:'upgrade'});await wait('open','success');
            await command({op:'transaction',database:'db',stores:['records'],mode:write?'readwrite':'readonly',transaction:'tx'});
            await command({op:'request',transaction:'tx',store:'records',method:write?'put':'get',args:write?['stored once','key']:['key'],request:'value'});
            const value=await wait('value','success');await command({op:'release',transaction:'tx'});await wait('tx','complete');await command({op:'close',database:'db'});return value;
          };
          await database(hosts[0],true);const blobValues=[await database(hosts[1],false),await database(hosts[2],false)];
          const results=[];
          for(const {host,request} of hosts){
            const databases=await request('idb_databases',[host.id]);
            const digest=await request('crypto',[host.id,'digest',['SHA-256',new Uint8Array([1,2,3])]]);
            results.push({url:host.profile.url,origin:host.profile.origin,context:sandstone.network.beacons.contexts.get(host.profile.beacon_context).context,
              databases:databases.success?databases.value:databases.value.name,digest:digest.success?digest.value.byteLength:digest.value.name});
          }
          const forged=await hosts[1].request('idb_databases',[hosts[0].host.id]);
          return {results,blobValues,forged:forged.value.name,persistent:sandstone.controller.indexed_db.persistent};
        }finally{for(const {host,port} of hosts){host.close();port.close();}}
      });
      assert.equal(result.forged,'SecurityError');
      assert.equal(result.persistent,!denied);
      assert.deepEqual(result.blobValues,['stored once','stored once']);
      for(const [index,value] of result.results.entries()){
        assert.equal(value.origin,index<3?'https://worker-origin.test':'null');assert.equal(value.digest,32);
        if(index<3)assert.ok(value.databases.some(database=>database.name==='retained-origin'));else assert.equal(value.databases,'SecurityError');
        assert.equal(value.context.top_url,'https://top-origin.test/page');
        if(index<3)assert.equal(value.context.broadcast_origin,'https://worker-origin.test');else assert.ok(value.context.broadcast_origin.startsWith('opaque:'));
      }
      assert.equal(result.results[2].context.url,'https://worker-origin.test/');
      assert.equal(result.results[1].context.url,'https://worker-origin.test/');
      assert.equal(result.results[2].context.referrer_url,'blob:null/id');
      assert.notEqual(result.results[3].context.broadcast_origin,result.results[4].context.broadcast_origin);
      passed.push('Retained '+(denied?'memory':'durable')+' Blob workers inherit creator storage while data workers remain independently opaque');
      passed.push('Retained '+(denied?'memory':'durable')+' worker ports keep crypto available without granting another worker storage authority');
    }finally{clearTimeout(deadline);await context.close();}
  }
  return passed;
}
