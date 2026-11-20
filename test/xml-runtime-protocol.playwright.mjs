import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {bootstrap_html,bootstrap_xml,runtime_seed} from '../src/bootstrap.mjs';

export async function verifyXMLRuntimeProtocol(page){
  const runtime=await readFile(new URL('../dist/sandstone_frame.js',import.meta.url),'utf8');
  const parentFile=new URL('runtime-parent.html',import.meta.url),parentHTML=await readFile(parentFile,'utf8');
  for(const parentURL of ['http://xml-protocol.test/parent',parentFile.href])for(const mime of ['text/html','image/svg+xml','application/xhtml+xml','application/xml','text/xml']){
    const fixture=await page.context().newPage(),errors=[],direct=[];
    fixture.on('pageerror',error=>errors.push(error.message));
    try{
      await fixture.route('http://xml-protocol.test/parent',route=>route.fulfill({contentType:'text/html',body:parentHTML}));
      await fixture.goto(parentURL);
      fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
      const nonce=randomUUID();
      // Create the seed before installing the parent's DOM interception.
      await fixture.evaluate(seed=>{
        const frame=globalThis.xmlProtocolFrame=document.createElement('iframe');
        frame.sandbox='allow-scripts allow-same-origin';frame.src=seed;document.body.append(frame);
      },runtime_seed(nonce));
      await fixture.addScriptTag({content:runtime});
      const source=runtime+`;sandstone_frame.rpc.rpc_handlers.xml_probe=async expected=>{
        const ordered=[];await sandstone_frame.script_schedule.ordered_classic(()=>ordered.push('classic'));
        const result={type:document.contentType,xml:document instanceof XMLDocument,namespace:document.documentElement.namespaceURI,origin:globalThis.origin,sourceMatches:sandstone_frame.loader.runtime_src===expected,ordered,sentinel:"]]> & <"};
        try{parent.document;result.parentAccess='allowed';}catch(error){result.parentAccess=error.name;}
        return result;
      };`;
      const markup=mime==='text/html'?bootstrap_html('<!doctype html><meta charset="utf-8"><script>'+source+'</script>',nonce):bootstrap_xml(source,mime,nonce);
      const actual=await fixture.evaluate(async({markup,mime,nonce,source})=>{
        const frame=xmlProtocolFrame,rpc=sandstone_frame.rpc,controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(new Error('Runtime protocol timed out: '+mime)),8000);
        let channel;
        try{
          await rpc.wait_on_frame(frame,{nonce,signal:controller.signal});
          const prepared=await rpc.load_frame_runtime(frame,markup,nonce,{mime,signal:controller.signal});
          rpc.commit_frame_runtime(frame,prepared,nonce);
          await rpc.wait_on_frame(frame,{url:prepared,nonce,signal:controller.signal});
          const wrong=new MessageChannel();rpc.set_host(frame,wrong.port2,{nonce:'wrong'});wrong.port1.close();
          channel=new MessageChannel();const target=new rpc.RPCTarget(channel.port1);
          target.onmessage=rpc.message_listener;channel.port1.start();rpc.set_host(frame,channel.port2,{nonce});
          return await rpc.call_procedure(target,'xml_probe',[source],{signal:controller.signal});
        }finally{clearTimeout(timer);channel?.port1.close();frame.remove();}
      },{markup,mime,nonce,source});
      assert.deepEqual(actual,{type:mime,xml:mime!=='text/html',namespace:mime==='image/svg+xml'?'http://www.w3.org/2000/svg':'http://www.w3.org/1999/xhtml',origin:'null',sourceMatches:true,ordered:['classic'],sentinel:']]> & <',parentAccess:'SecurityError'},mime+' authenticated opaque runtime installation');
      assert.deepEqual(errors,[],'Runtime protocol raised script errors');
      assert.deepEqual(direct,[],'Runtime protocol made a direct HTTP request');
      console.log(JSON.stringify({fixture:'Runtime MIME protocol',host:new URL(parentURL).protocol,mime}));
    }finally{await fixture.close();}
  }
  return ['File and HTTP hosts install native SVG/XHTML/XML runtimes with authenticated opaque origin isolation','XML runtime RPC rejects wrong bootstrap nonces and preserves CDATA script text'];
}
