import assert from 'node:assert/strict';

export async function verifyProvisionalFrame(page){
  const fixture=await page.context().newPage(),origin='https://provisional-frame.test',direct=[],errors=[];
  let parentFrame;
  try{
    fixture.on('pageerror',error=>errors.push(error.message));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(async origin=>{
      main_frame.on_load=()=>{};globalThis.provisionalRequests=[];
      sandstone.network.session.fetch=async(url,options)=>{
        provisionalRequests.push({url,referrer:new Headers(options.headers).get('referer')||''});
        if(url===origin+'/assets/child')return new Response('<!doctype html><base href="/child-assets/"><body><script>globalThis.childReady=true;</script>',{headers:{'content-type':'text/html'}});
        if(url.startsWith(origin+'/child-assets/'))return new Response('relayed',{headers:{'content-type':'text/plain'}});
        return new Response('<!doctype html><base href="/parent-assets/"><body>Parent',{headers:{'content-type':'text/html'}});
      };
      await main_frame.navigate_to(origin+'/start');
    },origin);
    for(const frame of fixture.frames())if(await frame.evaluate(origin=>globalThis.sandstone_frame?.loader.url===origin+'/start',origin).catch(()=>false))parentFrame=frame;
    assert.ok(parentFrame,'The parent runtime was not installed');
    await parentFrame.evaluate(url=>{
      const send=MessagePort.prototype.postMessage;
      globalThis.restoreProvisionalTransport=()=>{MessagePort.prototype.postMessage=send;};
      MessagePort.prototype.postMessage=function(...args){
        const message=args[0];
        if(message?.type==='procedure'&&message.procedure==='prepare_document'&&message.arguments[0]?.url===url){
          globalThis.provisionalHTMLHeld=true;
          globalThis.releaseProvisionalHTML=()=>Reflect.apply(send,this,args);return;
        }
        return Reflect.apply(send,this,args);
      };
    },origin+'/assets/child');
    const read=source=>fixture.evaluate(source=>main_frame.eval_js(source),source);
    await read('globalThis.child=document.createElement("iframe");child.name="provisional-child";child.src="/assets/child";document.body.append(child);true');
    await parentFrame.waitForFunction(()=>globalThis.provisionalHTMLHeld);
    const pending=JSON.parse(await read(`(()=>{
      globalThis.pendingWindow=child.contentWindow;
      const types={};for(const key of ['fetch','XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker','WebTransport','WebSocketStream','RTCPeerConnection','webkitRTCPeerConnection','navigator'])types[key]=typeof pendingWindow[key];
      let fetchError,documentError;
      const navigatorGetter=Object.getOwnPropertyDescriptor(pendingWindow,'navigator').get;
      const reflected={bound:typeof navigatorGetter.call(pendingWindow),unbound:typeof navigatorGetter(),nullReceiver:typeof navigatorGetter.call(null),fetch:typeof Object.getOwnPropertyDescriptor(pendingWindow,'fetch').value};
      for(const key of ['location','top','document']){
        const {get}=Reflect.getOwnPropertyDescriptor(pendingWindow,key);
        try{const value=get();reflected[key]=key==='location'?value.href:key==='top'?value===window:value===pendingWindow.document;}catch(error){reflected[key]=error.name;}
      }
      try{pendingWindow.fetch('https://native-escape.test/probe')?.catch(()=>{});}catch(error){fetchError=error.name;}
      try{pendingWindow.document;}catch(error){documentError=error.name;}
      return JSON.stringify({types,reflected,fetchError,documentError,contentDocument:child.contentDocument===null,closed:pendingWindow.closed,length:pendingWindow.length,name:pendingWindow.name});
    })()`));
    assert.deepEqual(pending.types,Object.fromEntries(Object.keys(pending.types).map(key=>[key,'undefined'])),'The provisional Window exposed a native capability');
    assert.deepEqual(pending.reflected,{bound:'undefined',unbound:'undefined',nullReceiver:'undefined',fetch:'undefined',location:origin+'/assets/child',top:true,document:'SecurityError'});
    assert.deepEqual({...pending,types:undefined,reflected:undefined},{types:undefined,reflected:undefined,fetchError:'TypeError',documentError:'SecurityError',contentDocument:true,closed:false,length:0,name:'provisional-child'});
    await parentFrame.evaluate(()=>{restoreProvisionalTransport();releaseProvisionalHTML();});
    await parentFrame.waitForFunction(()=>{try{return child.contentWindow.childReady===true;}catch{return false;}});
    const loaded=JSON.parse(await read(`(async()=>{
      const win=pendingWindow,response=await win.fetch('./fetch');
      const text=await new Promise((resolve,reject)=>{const xhr=new win.XMLHttpRequest();xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=()=>reject(new Error('Relayed child XHR failed'));xhr.open('GET','./xhr');xhr.send();});
      const getter=Object.getOwnPropertyDescriptor(win,'navigator').get;
      const {get:locationGetter}=win.Object.getOwnPropertyDescriptor(win,'location');
      const {get:documentGetter}=win.Reflect.getOwnPropertyDescriptor(win,'document');
      const {get:parentNavigatorGetter}=win.Object.getOwnPropertyDescriptor(window,'navigator');
      const crossRealm=locationGetter().href===win.location.href&&documentGetter()===win.document&&parentNavigatorGetter()===navigator&&parentNavigatorGetter.call(win)===win.navigator&&getter.call(window)===navigator;
      return JSON.stringify({sameWindow:win===child.contentWindow,document:win.document===child.contentDocument,fetch:await response.text(),xhr:text,rtc:typeof win.RTCPeerConnection,websocket:typeof win.WebSocket,worker:typeof win.Worker,navigator:typeof win.navigator,reflected:getter()===win.navigator&&getter.call(win)===win.navigator,crossRealm});
    })()`));
    assert.deepEqual(loaded,{sameWindow:true,document:true,fetch:'relayed',xhr:'relayed',rtc:'undefined',websocket:'function',worker:'function',navigator:'object',reflected:true,crossRealm:true});
    const requests=await fixture.evaluate(()=>provisionalRequests.filter(request=>/\/child-assets\//.test(request.url)));
    assert.deepEqual(requests,[{url:origin+'/child-assets/fetch',referrer:origin+'/assets/child'},{url:origin+'/child-assets/xhr',referrer:origin+'/assets/child'}]);
    assert.deepEqual(direct,[],'A provisional Window bypassed the relay');assert.deepEqual(errors,[],'Provisional frame activation raised a script error');
  }finally{
    await parentFrame?.evaluate(()=>{globalThis.restoreProvisionalTransport?.();globalThis.releaseProvisionalHTML?.();}).catch(()=>{});
    await fixture.close();
  }
  return ['Provisional iframe Windows hide native network and WebRTC APIs until their document capability is installed','The same WindowProxy activates relayed Fetch/XHR with the child base URL and referrer after installation'];
}
