import assert from 'node:assert/strict';

async function scenario(){
  const root=await navigator.storage.getDirectory(),result={};
  const cases={
    null:stream=>stream.write(null),undefined:stream=>stream.write(undefined),
    missing:stream=>stream.write({type:'write'}),nullData:stream=>stream.write({type:'write',data:null}),
    nullPosition:stream=>stream.write({type:'seek',position:null}),missingPosition:stream=>stream.write({type:'seek'}),
    nullSize:stream=>stream.write({type:'truncate',size:null}),missingSize:stream=>stream.write({type:'truncate'}),
    bigPosition:stream=>stream.write({type:'seek',position:1n}),bigSeek:stream=>stream.seek(1n),
    function:stream=>stream.write(()=>{}),symbol:stream=>stream.write(Symbol('invalid')),
    invalidType:stream=>stream.write({type:'invalid',data:'discarded'}),
    objectData:stream=>stream.write({type:'write',data:{toString:()=> 'converted'}}),
    seek:stream=>stream.seek(NaN),truncate:stream=>stream.truncate(Infinity),
    unicode:stream=>stream.write('a\uD800b')
  };
  for(const [name,run] of Object.entries(cases)){
    const file=await root.getFileHandle(name,{create:true}),stream=await file.createWritable();
    let first='ok',follow;try{await run(stream);}catch(error){first=error.name;}
    try{await stream.write('ok');await stream.close();follow=await(await file.getFile()).text();}
    catch(error){follow=error.name;await stream.abort().catch(()=>{});}
    result[name]={first,follow};
  }
  for(const mode of ['direct','writer']){
    const file=await root.getFileHandle('queue-'+mode,{create:true}),stream=await file.createWritable(),writer=mode==='writer'?stream.getWriter():stream;
    const first=writer.write(new Blob(['first'])),bytes=Uint8Array.of(1,2),order=[];
    const command={get type(){order.push('type');return 'write';},get data(){order.push('data');return bytes;},get position(){order.push('position');return 8;},get size(){order.push('size');return 1;}};
    const second=writer.write(command);result[mode+'Before']=[...order];bytes.fill(9);await first;await second;
    if(mode==='writer')writer.releaseLock();await stream.close();
    result[mode]={bytes:[...new Uint8Array(await(await file.getFile()).arrayBuffer())],order};
    const invalid=await file.createWritable(),raw=invalid.getWriter();
    let firstError,followError;try{await raw.write(null);}catch(error){firstError=error.name;}
    try{await raw.write('not written');}catch(error){followError=error.name;}
    await raw.abort().catch(()=>{});raw.releaseLock();result[mode+'RawError']={firstError,followError};
  }
  for(const kind of ['typed','data']){
    const file=await root.getFileHandle('hidden-'+kind,{create:true}),stream=await file.createWritable();
    const buffer=Uint8Array.of(9,1,2,8).buffer,view=kind==='typed'?new Uint8Array(buffer,1,2):new DataView(buffer,1,2);
    for(const key of ['buffer','byteOffset','byteLength'])Object.defineProperty(view,key,{get(){throw new Error('Authored buffer properties must not be read');}});
    await stream.write(view);await stream.close();result[kind+'Hidden']=[...new Uint8Array(await(await file.getFile()).arrayBuffer())];
  }
  let reads=0;
  const value=new Proxy({},{get(){reads++;throw new Error('Invalid receiver must be checked first');}});
  try{await FileSystemWritableFileStream.prototype.write.call({},value);}catch(error){result.receiver={error:error.name,reads};}
  return result;
}

export async function verifyFileWrites(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const url='https://filesystem-write.test/',html='<!doctype html><body>File write conversion',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  fixture.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try{
    await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));await native.goto(url);
    const expected=await native.evaluate(scenario);
    assert.equal(expected.null.first,'TypeError');assert.equal(expected.null.follow,'ok');
    assert.equal(expected.missing.first,'SyntaxError');assert.equal(expected.missing.follow,'SyntaxError');
    assert.deepEqual(expected.directBefore,['data','position','size','type']);assert.deepEqual(expected.writerBefore,[]);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async({url,html})=>{
      sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});
      await main_frame.navigate_to(url);
    },{url,html});
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')()))()'),scenario.toString()));
    assert.deepEqual(actual,expected);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['File writes match native command conversion, nullable fields, Unicode and error recovery','Direct file writes and stream writers preserve native getter timing, member order and queued buffer behavior'];
  }finally{await fixture.close();await context.close();await page.bringToFront();}
}
