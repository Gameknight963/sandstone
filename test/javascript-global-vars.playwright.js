async page=>{
  const cases=[
    {name:'uninitialized globals',source:'var fetch,location,URL;globalThis.result=[fetch===window.fetch,location===window.location,URL===window.URL,location.href];'},
    {name:'global initializer',source:'var fetch=()=>"initialized";globalThis.result=[fetch(),window.fetch(),fetch===window.fetch,fetch.name];'},
    {name:'strict initializer',source:'"use strict";var fetch=function(){return "strict"};globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'mixed declarations',source:'var first=(trace.push("first"),1),fetch=(trace.push("fetch"),()=>"mixed"),last=(trace.push("last"),3);globalThis.result=[first,fetch(),window.fetch(),last,trace];'},
    {name:'block declaration',source:'if(true){var fetch=()=>"block"}globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'unexecuted declaration',source:'if(false){var fetch=()=>"never"}globalThis.result=[fetch(),window.fetch()];'},
    {name:'function and var',source:'var fetch=()=>"variable";function fetch(){return "hoisted"}globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'forward closure',source:'const read=()=>fetch();var fetch=()=>"closure";globalThis.result=[read(),window.fetch()];'},
    {name:'later assignments',source:'var fetch=()=>"first";fetch=()=>"second";window.fetch=()=>"third";globalThis.result=[fetch(),window.fetch(),fetch===window.fetch];'},
    {name:'object pattern',source:'var {fetch,other}={fetch:()=>"object",other:2};globalThis.result=[fetch(),window.fetch(),other];'},
    {name:'nested defaults',source:'var {nested:{fetch=()=>"default",missing:Worker=class{}}={}}={};globalThis.result=[fetch(),window.fetch(),fetch.name,Worker.name,Worker===window.Worker];'},
    {name:'array pattern',source:'var [fetch,,...Worker]=[()=>"array",2,3,4];globalThis.result=[fetch(),window.fetch(),Worker,window.Worker];'},
    {name:'computed keys',source:'var {[(trace.push("key"),"chosen")]:fetch=(trace.push("default"),()=>"computed"),other}={other:7};globalThis.result=[fetch(),window.fetch(),other,trace];'},
    {name:'object rest',source:'var {omit,...Worker}={omit:1,value:2};globalThis.result=[omit,Worker,window.Worker];'},
    {name:'for initializer',source:'for(var fetch=()=>"loop",count=0;count<1;count++)trace.push(fetch());globalThis.result=[fetch(),window.fetch(),fetch.name,count,trace];'},
    {name:'for of',source:'for(var fetch of [()=>"one",()=>"two"])trace.push(fetch());globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'for in',source:'for(var fetch in {one:1,two:2})trace.push(fetch);globalThis.result=[fetch,window.fetch,trace];'},
    {name:'for of pattern',source:'for(var [fetch,other] of [[()=>"one",1],[()=>"two",2]])trace.push([fetch(),other]);globalThis.result=[fetch(),window.fetch(),other,trace];'},
    {name:'for in initializer',source:'for(var fetch=(trace.push("init"),()=>"initial") in (trace.push("right"),{one:1}))trace.push(fetch);globalThis.result=[fetch,window.fetch,trace];'},
    {name:'for in initializer without iterations',source:'for(var fetch=()=>"initial" in null)trace.push("body");globalThis.result=[fetch(),window.fetch(),fetch.name,trace];'},
    {name:'conditional legacy loop',source:'if(false)for(var fetch=()=>"never" in {}){}globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'catch parameter',source:'try{throw "caught"}catch(fetch){var fetch="assigned";trace.push(fetch)}globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'local exclusion',source:'(function(){var fetch=()=>"local";trace.push(fetch())})();globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'module exclusion',mode:'module',source:'var fetch=()=>"module";globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'sloppy eval globals',mode:'eval',source:'var fetch=()=>"eval";globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'strict eval exclusion',mode:'eval',source:'"use strict";var fetch=()=>"local eval";globalThis.result=[fetch(),window.fetch(),fetch.name];'},
    {name:'eval completion',mode:'eval',source:'"preceding";var fetch=()=>"eval";'},
    {name:'with bindings',source:'var fetch;with({fetch:()=>"with"}){trace.push(fetch())}globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'with fallback',source:'var fetch=()=>"fallback";with({})trace.push(fetch());globalThis.result=[fetch(),window.fetch(),trace];'},
    {name:'with receiver',source:'var fetch;const obj={fetch(){return this===obj}};with(obj){trace.push(fetch(),fetch===obj.fetch,fetch?.(),fetch``)}globalThis.result=trace;'},
    {name:'with initializer',source:'var fetch;const obj={fetch:()=>"object"};with(obj){var fetch=()=>"assigned";trace.push(fetch(),fetch.name)}globalThis.result=[fetch(),obj.fetch(),trace];'},
    {name:'with closures and unscopables',source:'var fetch=()=>"global";const obj={fetch:()=>"object"};let read;with(obj){read=()=>fetch()}obj.fetch=()=>"changed";with({fetch:()=>"hidden",[Symbol.unscopables]:{fetch:true}})trace.push(fetch());globalThis.result=[read(),fetch(),trace];'},
    {name:'with legacy initializer',source:'var fetch;const obj={fetch:()=>"object"};with(obj){for(var fetch=()=>"assigned" in null){}trace.push(fetch())}globalThis.result=[fetch(),obj.fetch(),trace];'},
    {name:'later assignment inference',source:'var fetch;fetch=()=>"assigned";globalThis.result=[fetch.name,window.fetch.name];'},
    {name:'assignment pattern inference',source:'var fetch;({fetch=()=>"assigned"}={});globalThis.result=[fetch(),fetch.name,fetch===window.fetch];'},
    {name:'with Window receiver',source:'var fetch=function(){"use strict";return this===window};with(window){globalThis.result=[fetch(),fetch?.(),fetch``]}'},
    {name:'with fallback receiver',source:'var fetch=function(){"use strict";return this===undefined};with({}){globalThis.result=[fetch(),fetch?.(),fetch``]}'}
  ];
  const url='https://global-vars.test/',pages={};
  for(let index=0;index<cases.length;index++){
    const test=cases[index],type=test.mode==='module'?' type="module"':'';
    const source=test.mode==='eval'?'globalThis.completion=(0,eval)('+JSON.stringify(test.source)+');':test.source;
    pages['/case/'+index]='<!doctype html><body><script>globalThis.trace=[];globalThis.fetch=()=>"initial";<\/script><script'+type+'>'+source+'<\/script><script>globalThis.following=fetch;globalThis.complete=true;<\/script>';
  }
  pages['/network']='<!doctype html><body><script>var fetch,XMLHttpRequest;Promise.all([fetch("/payload").then(response=>response.json()),new Promise((resolve,reject)=>{const request=new XMLHttpRequest();request.open("GET","/payload");request.responseType="json";request.onload=()=>resolve(request.response);request.onerror=()=>reject(new Error("XHR failed"));request.send()})]).then(values=>{globalThis.networkResult={values,sameFetch:fetch===window.fetch,sameXHR:XMLHttpRequest===window.XMLHttpRequest}});<\/script>';
  const payload=JSON.stringify({value:42});
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url+'**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path==='/payload'?'application/json':'text/html',body:path==='/payload'?payload:pages[path]||'<!doctype html>'})});
  const read='JSON.stringify({complete:!!globalThis.complete,result:globalThis.result??null,following:typeof globalThis.following==="function"?globalThis.following():globalThis.following,completion:globalThis.completion??null})';
  try{
    await page.evaluate(({url,pages,payload})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const parsed=new URL(target);return parsed.origin===new URL(url).origin?Promise.resolve(new Response(parsed.pathname==='/payload'?payload:pages[parsed.pathname]||'<!doctype html>',{headers:{'Content-Type':parsed.pathname==='/payload'?'application/json':'text/html'}})):previous(target,options)};},{url,pages,payload});
    for(let index=0;index<cases.length;index++){
      const target=url+'case/'+index;await native.goto(target);const expected=JSON.parse(await native.evaluate(source=>eval(source),read));
      await page.evaluate(target=>main_frame.navigate_to(target),target);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),read));
      if(!expected.complete||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Global var parity ('+cases[index].name+'): '+JSON.stringify({expected,actual}));
    }
    await native.goto(url+'network');await native.waitForFunction(()=>!!globalThis.networkResult);
    const expected=await native.evaluate(()=>JSON.stringify(globalThis.networkResult));
    await page.evaluate(target=>main_frame.navigate_to(target),url+'network');
    const actual=await page.evaluate(()=>main_frame.eval_js('new Promise(resolve=>{const poll=()=>globalThis.networkResult?resolve(JSON.stringify(globalThis.networkResult)):setTimeout(poll,10);poll()})'));
    if(actual!==expected)throw new Error('Global fetch/XHR relay parity: '+JSON.stringify({expected,actual}));
    return ['Classic global var declarations preserve virtual APIs, initializers, patterns and shared Window bindings','Global var loops, eval completion and local/module/catch scope retain native behavior'];
  }finally{await context.close()}
}
