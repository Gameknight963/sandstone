import assert from 'node:assert/strict';

export async function verifyHistoryURLs(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const url='https://history-urls.test/start',html='<!doctype html><base href="/assets/"><body>History URLs',errors=[],direct=[];
  const run=async()=>{
    const result=[];
    const attempt=(peer,value,method)=>{
      const order=[],before={url:peer.location.href,state:peer.history.state,length:peer.history.length};
      let outcome;
      try{peer.history[method]({get saved(){order.push('state');return true;}},{toString(){order.push('title');return '';}},{toString(){order.push('url');return value;}});outcome='allowed';}
      catch(error){outcome=error.name;}
      return {outcome,order,unchanged:peer.location.href===before.url&&peer.history.state===before.state&&peer.history.length===before.length};
    };
    for(const method of ['pushState','replaceState'])for(const value of ['http://[','https://other.test/','https://user@history-urls.test/'])result.push({method,value,...attempt(window,value,method)});
    history.replaceState({initial:true},'','?euro=\u20ac');result.push({utf8:location.search});
    const sentinel=new Error('URL conversion');
    try{history.replaceState({},'',{toString(){throw sentinel;}});}catch(error){result.push({conversionPreserved:error===sentinel});}
    for(const kind of ['blob','about']){
      const source=kind==='blob'?URL.createObjectURL(new Blob(['<!doctype html><body>Blob history'],{type:'text/html'})):'about:blank';
      const child=document.createElement('iframe');child.src=source;
      try{
        await new Promise(resolve=>{child.onload=resolve;document.body.append(child);});
        const peer=child.contentWindow;
        for(const method of ['pushState','replaceState']){
          for(const suffix of ['?query','/changed'])result.push({kind,method,suffix,...attempt(peer,source+suffix,method)});
          result.push({kind,method,suffix:'http',...attempt(peer,'https://history-urls.test/changed',method)});
          peer.history[method]({fragment:true},'',source+'#section');
          result.push({kind,method,fragment:peer.location.href===source+'#section',state:peer.history.state});
        }
      }finally{child.remove();if(kind==='blob')URL.revokeObjectURL(source);}
    }
    return JSON.stringify(result);
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route('https://history-urls.test/**',route=>route.fulfill({contentType:'text/html;charset=windows-1252',body:html}));
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval('('+source+')')(),run.toString()));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({url,html})=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html;charset=windows-1252','cache-control':'no-store'}});return main_frame.navigate_to(url);},{url,html});
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('('+source+')()'),run.toString()));
    assert.deepEqual(actual,expected);
    assert.equal(actual.find(value=>value.utf8)?.utf8,'?euro=%E2%82%AC');
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['History rejects invalid URLs without mutating state and preserves URL conversion errors','Blob and inherited blank documents restrict History changes to fragments'];
}
