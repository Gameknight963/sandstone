import assert from 'node:assert/strict';

export async function verifyAncestorOrigins(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://ancestor-origins.test',other='https://ancestor-other.test';
  const errors=[],direct=[];let current;
  const inspect=function(){
    const list=location.ancestorOrigins,prototype=DOMStringList.prototype;
    const capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
    const before=Array.from(list);
    const result={values:before,instance:list instanceof DOMStringList,tag:Object.prototype.toString.call(list),keys:Object.keys(list),same:list===location.ancestorOrigins,
      items:[list.item(0),list.item(-1),list.item(2**32),list.item(NaN)],contains:[list.contains(before[0]),list.contains('missing')],
      conversion:[capture(()=>list.item()),capture(()=>list.contains()),capture(()=>list.item(1n)),capture(()=>list.item(Symbol())),capture(()=>list.contains(Symbol()))],
      borrowed:[capture(()=>prototype.item.call(list,0)),capture(()=>Object.getOwnPropertyDescriptor(prototype,'length').get.call(list)),capture(()=>prototype.item.call({},0))],
      generic:[...prototype[Symbol.iterator].call({0:'generic',length:1})],
      mutation:[capture(()=>Reflect.set(list,'0','changed')),capture(()=>Reflect.deleteProperty(list,'0')),capture(()=>Reflect.preventExtensions(list))]};
    result.after=Array.from(list);result.descriptor=Object.getOwnPropertyDescriptor(list,'0')||null;
    const includes=Array.prototype.includes,map=Array.prototype.map;let interceptions=0;
    try{
      Array.prototype.includes=function(...args){interceptions++;return Reflect.apply(includes,this,args);};
      Array.prototype.map=function(...args){interceptions++;return Reflect.apply(map,this,args);};
      list.contains(before[0]);Object.keys(list);
    }finally{Array.prototype.includes=includes;Array.prototype.map=map;}
    result.interceptions=interceptions;
    result.parent=capture(()=>Array.from(parent.location.ancestorOrigins));
    history.replaceState(null,'',location.href+'#same-document');
    result.retained=list===location.ancestorOrigins&&JSON.stringify(before)===JSON.stringify(Array.from(list));
    return result;
  };
  const html=(url,profile,inspectSource)=>{
    const origin='https://ancestor-origins.test',other='https://ancestor-other.test';
    if(new URL(url).pathname==='/leaf')return '<!doctype html><script>top.postMessage({ancestry:('+inspectSource+')()},"*");</script>';
    const middle='<!doctype html><iframe src="'+origin+'/leaf"></iframe>';
    if(new URL(url).pathname==='/middle')return middle;
    const source=profile.kind==='data'?'data:text/html,'+encodeURIComponent(middle):(profile.kind==='other'?other:origin)+'/middle';
    const attribute=profile.kind==='srcdoc'?'srcdoc="'+middle.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"':'src="'+source+'"';
    return '<!doctype html><script>onmessage=e=>{if(e.data?.ancestry)globalThis.ancestry=e.data.ancestry;};</script><iframe '+(profile.sandbox?'sandbox="'+profile.sandbox+'" ':'')+attribute+'></iframe>';
  };
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(/^https:\/\/ancestor-(?:origins|other)\.test\//,route=>route.fulfill({contentType:'text/html',body:html(route.request().url(),current,inspect.toString())}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({html,inspect})=>{
      const render=(0,eval)('('+html+')');globalThis.ancestryProfile=null;main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>new Response(render(url,ancestryProfile,inspect),{headers:{'content-type':'text/html','cache-control':'no-store'}});
    },{html:html.toString(),inspect:inspect.toString()});
    for(const profile of [{kind:'same'},{kind:'other'},{kind:'data'},{kind:'srcdoc'},{kind:'same',sandbox:'allow-scripts'},{kind:'same',sandbox:'allow-scripts allow-same-origin'}]){
      current=profile;const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Ancestor origins',...profile,proxy}));
        if(proxy){await fixture.evaluate(profile=>{ancestryProfile=profile;},profile);await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');}
        else await native.goto(origin+'/root');
        const deadline=Date.now()+8000;
        while(!await read(proxy,'!!globalThis.ancestry')){if(Date.now()>deadline)throw new Error('Ancestor origin collection did not complete');await fixture.waitForTimeout(20);}
        const root=JSON.parse(await read(proxy,'JSON.stringify({values:Array.from(location.ancestorOrigins),child:(()=>{try{const l=document.querySelector("iframe").contentWindow.location.ancestorOrigins;return {values:Array.from(l),first:DOMStringList.prototype.item.call(l,0)};}catch(e){return {error:e.name};}})()})'));
        results.push({root,leaf:JSON.parse(await read(proxy,'JSON.stringify(ancestry)'))});
      }
      assert.deepEqual(results[1],results[0],JSON.stringify(profile));
      assert.deepEqual(results[0].root.values,[]);
      const middle=profile.sandbox==='allow-scripts'||profile.kind==='data'?'null':profile.kind==='other'?other:origin;
      assert.deepEqual(results[0].leaf.values,[middle,origin]);
    }
    const root=fixture.frames().find(frame=>frame.parentFrame()===fixture.mainFrame());
    const physical=await root.evaluate(()=>{const list=location.ancestorOrigins;return {length:list.length,values:Array.from(list),first:DOMStringList.prototype.item.call(list,0),contains:list.contains(list[0])};});
    assert.equal(physical.length,physical.values.length);assert.ok(physical.length>0);assert.equal(physical.first,physical.values[0]);assert.equal(physical.contains,true);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['Location ancestor origins expose virtual ancestry without the standalone host or runtime origins','Ancestor origin collections retain native DOMStringList branding, borrowed methods, conversions and read-only indexes'];
}
