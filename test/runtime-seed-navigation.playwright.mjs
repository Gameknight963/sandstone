import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bootstrap_xml,runtime_seed} from '../src/bootstrap.mjs';

export async function verifySeedNavigation(page){
  for(const mime of ['text/html','image/svg+xml','application/xhtml+xml','application/xml','text/xml','application/rss+xml','application/atom+xml']){
    const fixture=await page.context().newPage(),errors=[];
    const nonce=randomUUID(),next='https://seed-navigation.test/'+nonce;
    let started=false,release,finished;
    const held=new Promise(resolve=>{release=resolve;}),routed=new Promise(resolve=>{finished=resolve;});
    fixture.on('pageerror',error=>errors.push(error.message));
    try{
      await fixture.route(next,async route=>{
        started=true;
        try{await held;await route.fulfill({contentType:'text/html',body:'<!doctype html><script>parent.postMessage({newer:true},"*");</script>'});}
        finally{finished();}
      });
      await fixture.goto(new URL('runtime-parent.html',import.meta.url).href);
      const seed=runtime_seed(nonce,{in_place:true,mime});
      await fixture.evaluate(seed=>{
        globalThis.seedMessages=[];onmessage=event=>seedMessages.push(event.data);
        const frame=globalThis.seedFrame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin';frame.src=seed;document.body.append(frame);
      },seed);
      const ping=()=>fixture.evaluate(()=>seedFrame.contentWindow.postMessage({sandstone_bootstrap:1,type:'ping',id:'ready'},'*'));
      const deadline=Date.now()+5000;
      while(!await fixture.evaluate(()=>seedMessages.some(message=>message.type==='pong'))){if(Date.now()>deadline)throw new Error('Seed navigation fixture did not initialize');await ping();await fixture.waitForTimeout(10);}
      const source='parent.postMessage({installed:true},"*");';
      const html=mime==='text/html'?'<!doctype html><script>'+source+'</script>':bootstrap_xml(source,mime,nonce);
      await fixture.evaluate(({nonce,html,mime})=>seedFrame.contentWindow.postMessage({sandstone_bootstrap:1,type:'runtime',nonce,id:'prepare',html,mime},'*'),{nonce,html,mime});
      await fixture.waitForFunction(()=>seedMessages.some(message=>message.type==='runtime_url'));
      assert.equal(await fixture.evaluate(()=>seedMessages.some(message=>message.installed)),false);
      await fixture.evaluate(next=>{seedFrame.src=next;},next);
      while(!started){if(Date.now()>deadline)throw new Error('Newer seed navigation did not start');await fixture.waitForTimeout(10);}
      await fixture.evaluate(({nonce,seed})=>seedFrame.contentWindow.postMessage({sandstone_bootstrap:1,type:'commit_runtime',nonce,url:seed},'*'),{nonce,seed});
      await fixture.waitForFunction(()=>seedMessages.some(message=>message.installed),null,{timeout:5000});
      release();await routed;
      await fixture.waitForFunction(()=>seedMessages.some(message=>message.newer),null,{timeout:5000});
      assert.ok(fixture.frames().some(frame=>frame.url()===next),'Committing the old seed canceled its pending successor');
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({fixture:'In-place seed navigation',mime}));
    }finally{release();if(started)await routed;await fixture.close();}
  }
  return ['Committing an old HTML/XML seed cannot cancel a newer pending iframe navigation'];
}
