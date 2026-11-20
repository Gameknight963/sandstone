import assert from 'node:assert/strict';

async function scenario(){
  const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('listing',{create:true});
  const file=await dir.getFileHandle('a.txt',{create:true});await dir.getDirectoryHandle('folder',{create:true});
  const result={},collect=async iterable=>{const values=[];for await(const value of iterable)values.push(value);return values;};
  dir.entries=()=>{throw new Error('Authored entries override');};
  result.keys=(await collect(dir.keys())).sort();
  result.values=(await collect(dir.values())).map(handle=>[handle.name,handle.kind]).sort();
  result.default=(await collect(dir)).map(([name,handle])=>[name,handle.kind]).sort();
  result.alias=FileSystemDirectoryHandle.prototype.entries===FileSystemDirectoryHandle.prototype[Symbol.asyncIterator];
  for(const method of ['entries','keys','values'])for(const [label,receiver] of [['object',{}],['file',file]]){
    let phase='call';try{const iterator=FileSystemDirectoryHandle.prototype[method].call(receiver);phase='next';await iterator.next();}
    catch(error){result[method+label]={phase,error:error.name};}
  }
  const iterator=FileSystemDirectoryHandle.prototype.entries.call(dir);
  result.methods={return:typeof iterator.return,throw:typeof iterator.throw,tag:Object.prototype.toString.call(iterator)};
  let phase='call';try{const pending=Object.getPrototypeOf(iterator).next.call({});phase='await';await pending;}
  catch(error){result.nextReceiver={phase,error:error.name};}

  const scan=dir.keys();let first;
  for await(const name of scan){first=name;break;}
  const rest=await collect(scan);result.resume={names:[first,...rest].sort(),remaining:rest.length};
  const concurrent=FileSystemDirectoryHandle.prototype.entries.call(dir),records=await Promise.all([concurrent.next(),concurrent.next(),concurrent.next()]);
  result.concurrent={entries:records.filter(record=>!record.done).map(record=>[record.value[0],record.value[1].kind]).sort(),done:records.filter(record=>record.done).length};
  const end=await concurrent.next();result.end={done:end.done,undefined:end.value===undefined};

  const generatorPrototype=Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})())),descriptor=Object.getOwnPropertyDescriptor(generatorPrototype,'next');
  try{
    Object.defineProperty(generatorPrototype,'next',{...descriptor,value(){throw new Error('Authored generator override');}});
    result.generatorOverride=(await collect(dir.values())).map(handle=>handle.name).sort();
  }finally{Object.defineProperty(generatorPrototype,'next',descriptor);}

  const removed=await root.getDirectoryHandle('removed',{create:true});
  await root.removeEntry('removed');const missing=removed.entries();result.removed=[];
  for(let index=0;index<2;index++)try{const entry=await missing.next();result.removed.push({done:entry.done,undefined:entry.value===undefined});}catch(error){result.removed.push({error:error.name});}
  return result;
}

export async function verifyFileIteration(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const url='https://filesystem-iteration.test/',html='<!doctype html><body>Directory iteration',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try{
    await context.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));await native.goto(url);
    const expected=await native.evaluate(scenario);
    assert.deepEqual(expected.resume,{names:['a.txt','folder'],remaining:1});
    assert.equal(expected.keysobject.phase,'call');assert.equal(expected.methods.return,'undefined');
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async({url,html})=>{
      sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});await main_frame.navigate_to(url);
    },{url,html});
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')()))()'),scenario.toString()));
    assert.deepEqual(actual,expected);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Directory iterators ignore authored method overrides and resume after early for-await exit','Directory iteration matches native receiver errors, concurrent next calls and deleted-directory completion'];
  }finally{await fixture.close();await context.close();await page.bringToFront();}
}
