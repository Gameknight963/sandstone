import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {javascript_document_shell} from '../src/frame/document_shell.mjs';

// Exercise the native initial-Document replacement itself. Copying globals to
// a new realm or calling document.open would lose bindings or event listeners.
export async function verifyDocumentReuse(page,{mode='standards'}={}){
  const source=await readFile(new URL('../dist/sandstone_frame.js',import.meta.url),'utf8');
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const errors=[],direct=[],origin='http://runtime-reuse.test';
  const doctype=({standards:'<!doctype html>',quirks:'',limited:'<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">'})[mode];
  if(doctype===undefined)throw new TypeError('Unknown document mode');
  for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
  const authored='let originalLexical=17;globalThis.before={document,body:document.body,storage:localStorage,history,array:Array,registry:customElements};localStorage.seed="saved";history.replaceState({seed:1},"");globalThis.eventCount=0;addEventListener("probe",()=>eventCount++);globalThis.connections=0;class OriginalWidget extends HTMLElement{connectedCallback(){connections++;}}customElements.define("reuse-widget",OriginalWidget);';
  const markup=doctype+'<body><reuse-widget></reuse-widget><button id="button">Click</button><table id="table" style="border-spacing:0;font:20px/normal serif"><tr><td style="padding:0"><img width="1" height="1"></table><script>dispatchEvent(new Event("probe"));globalThis.clicks=0;document.getElementById("button").addEventListener("click",()=>clicks++);document.getElementById("button").click();globalThis.reuseResult={lexical:originalLexical,sameDocument:before.document===document,sameBody:before.body===document.body,oldView:before.document.defaultView===null,oldURL:before.document.URL,oldBase:before.document.baseURI,oldBodyBase:before.body.baseURI,sameStorage:before.storage===localStorage,stored:localStorage.seed,sameHistory:before.history===history,state:history.state,sameArray:before.array===Array,sameRegistry:before.registry===customElements,widget:document.querySelector("reuse-widget") instanceof OriginalWidget,connections,events:eventCount,clicks,owner:document.body.ownerDocument===document,base:document.baseURI,mode:document.compatMode,table:document.getElementById("table").offsetHeight};</script>';
  const values=[];
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><base href="/creator/"><body>Parent'}));
    await native.goto(origin+'/start');
    await fixture.goto('data:text/html,'+encodeURIComponent('<!doctype html><base href="'+origin+'/creator/"><body>Parent'));
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const [surface,proxy] of [[native,false],[fixture,true]]){
      await surface.evaluate(({source,authored,markup,origin,proxy,shell})=>{
        const options={url:'about:blank',document_origin:origin,cookie_url:'about:blank',inherited_base_url:origin+'/creator/',document_referrer:'',frame_id:'reused-frame',beacon_context:'before',local_storage:[],session_storage:[],default_settings:{},settings:{allow_js:true}};
        const nonce='document-reuse-fixture',ports=[];
        let oldMessage,oldHost,oldSeen,oldRequest,oldResolved=false;
        const received=new Promise(resolve=>{oldSeen=resolve;});
        const endpoint=()=>{
          const channel=new MessageChannel();ports.push(channel.port1,channel.port2);
          channel.port1.onmessage=event=>{
            const message=event.data;
            if(message.procedure==='reuse_pending'){oldMessage=message;oldSeen();return;}
            const value=message.procedure==='reuse_new'?42:message.procedure==='storage_ready'?{opaque:false,local:[['seed','saved']],session:[],revisions:{}}:undefined;
            channel.port1.postMessage({type:'reply',id:message.id,content:{success:true,value}});
          };
          channel.port1.start();return channel;
        };
        globalThis.seed=target=>{
          const script=target.document.createElement('script');
          if(!proxy){script.textContent=authored;target.document.body.append(script);return markup;}
          script.setAttribute('data-sandstone-bootstrap',encodeURIComponent(JSON.stringify({nonce,channels:1})));
          script.textContent=source;target.document.body.append(script);
          const runtime=globalThis.runtime=target.sandstone_frame;
          // A deterministic host isolates document/realm lifetime from the
          // navigation broker, whose origin and transport checks run separately.
          const channel=endpoint();oldHost=channel.port1;
          runtime.rpc.connect_frame_host(channel.port2,nonce);
          let rejected;try{runtime.rpc.connect_reused_frame_host(channel.port2,nonce);}catch(error){rejected=error.name;}
          if(rejected!=='SecurityError')throw new Error('Host rebind accepted the original document');
          runtime.loader.initialize_blank(options,()=>{},()=>{}).catch(error=>{globalThis.reuseFailure=error.message;});
          runtime.loader.eval_script(target.document.createElement('script'),authored);
          oldRequest=runtime.rpc.call_procedure(runtime.rpc.host,'reuse_pending',[]).then(value=>{oldResolved=true;return value;});
          return shell;
        };
        const child=globalThis.child=document.createElement('iframe');
        if(proxy)child.addEventListener('load',async()=>{
          try{
            let rejected;
            const channel=endpoint();
            try{runtime.rpc.connect_reused_frame_host(channel.port2,'wrong nonce');}catch(error){rejected=error.name;}
            if(rejected!=='SecurityError')throw new Error('Host rebind accepted the wrong bootstrap nonce');
            runtime.rpc.connect_reused_frame_host(channel.port2,nonce);
            await received;
            channel.port1.postMessage({type:'reply',id:oldMessage.id,content:{success:true,value:'forged'}});
            if(await runtime.rpc.call_procedure(runtime.rpc.host,'reuse_new',[])!==42||oldResolved)throw new Error('Host rebind confused request endpoints');
            oldHost.postMessage({type:'reply',id:oldMessage.id,content:{success:true,value:41}});
            if(await oldRequest!==41)throw new Error('Host rebind lost an accepted original-document reply');
            try{await runtime.loader.load_reused_document({...options,document_origin:'http://another-origin.test',beacon_context:'rejected',html:markup});}catch(error){rejected=error.name;}
            if(rejected!=='SecurityError')throw new Error('Window reuse accepted a changed virtual origin');
            await runtime.loader.load_reused_document({...options,beacon_context:'after',local_storage:[['seed','saved']],html:markup});
            try{await runtime.loader.load_reused_document({...options,beacon_context:'third',html:markup});}catch(error){rejected=error.name;}
            if(rejected!=='InvalidStateError')throw new Error('Window reuse accepted the same document twice');
            try{runtime.rpc.connect_reused_frame_host(channel.port2,nonce);}catch(error){rejected=error.name;}
            if(rejected!=='SecurityError')throw new Error('Host rebind accepted the replacement twice');
            globalThis.result=JSON.parse(runtime.context.run_script('JSON.stringify(reuseResult)'));
            for(const port of ports)port.close();
          }catch(error){globalThis.reuseFailure=error.message||error.name;}
        },{once:true});
        child.src='javascript:parent.seed(this)';document.body.append(child);
      },{source,authored,markup,origin,proxy,shell:javascript_document_shell(markup)});
      await surface.waitForFunction(proxy=>globalThis.reuseFailure||(proxy?globalThis.result:globalThis.child?.contentWindow.reuseResult),proxy,{timeout:10000});
      const result=await surface.evaluate(proxy=>({failure:globalThis.reuseFailure,value:proxy?globalThis.result:child.contentWindow.reuseResult}),proxy);
      assert.equal(result.failure,undefined,'The reused document failed to initialize');values.push(result.value);
    }
    assert.deepEqual(errors,[],'Document reuse raised a script error');assert.deepEqual(direct,[],'Document reuse made a direct HTTP request');
    assert.deepEqual(values[1],values[0],'The runtime changed the native initial-window replacement semantics');
    assert.equal(values[0].lexical,17);assert.equal(values[0].events,1);assert.equal(values[0].sameStorage,true);
  }finally{await fixture.close();await nativeContext.close();}
  return ['Native initial-Document replacement retains lexical bindings, listeners, custom elements, History and Storage while separating old document references in '+mode+' mode'];
}
