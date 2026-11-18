async page=>{
  const cases=[
    {name:'let shared between scripts',scripts:['let fetch=()=>"lexical";','window.result=[fetch(),window.fetch(),fetch===window.fetch];']},
    {name:'const shared between scripts',scripts:['const fetch=()=>"constant";','let error;try{fetch=()=>"changed"}catch(value){error=value.name}window.result=[fetch(),window.fetch(),error];']},
    {name:'mutable class binding',scripts:['class URL{static read(){return "class"}}','window.result=[URL.read(),URL.name,URL===window.URL];URL=()=>"reassigned";window.result.push(URL(),URL.name);']},
    {name:'destructuring and defaults',scripts:['let {fetch=()=>"default",...URL}={value:42};','window.result=[fetch(),fetch.name,URL.value,URL===window.URL];']},
    {name:'prior closure sees new lexical binding',scripts:['window.readGlobal=()=>fetch();','let fetch=()=>"later";','window.result=[readGlobal(),window.fetch()];']},
    {name:'prior closure observes TDZ',scripts:['window.readGlobal=()=>fetch();window.typeGlobal=()=>typeof fetch;','let error,type;try{readGlobal()}catch(value){error=value.name}try{typeGlobal()}catch(value){type=value.name}let fetch=()=>"ready";window.result=[error,type,fetch(),window.fetch()];']},
    {name:'failed initializer remains in TDZ',scripts:['let fetch=(()=>{throw new Error("initializer")})();','let error;try{window.result=typeof fetch}catch(value){error=value.name}window.result=[error,window.fetch(),window.errors];']},
    {name:'window writes remain separate',scripts:['let fetch=()=>"lexical";','window.fetch=()=>"property";window.result=[fetch(),window.fetch()];fetch=()=>"assigned";window.result.push(fetch(),window.fetch(),fetch.name);']},
    {name:'lexical deletion',scripts:['let fetch=()=>"lexical";','window.result=[delete fetch,fetch()];delete window.fetch;window.result.push(fetch(),typeof window.fetch);']},
    {name:'block binding does not escape',scripts:['{let fetch=()=>"block";window.blockValue=fetch()}','window.result=[blockValue,fetch(),window.fetch()];']},
    {name:'loop binding does not escape',scripts:['for(let fetch of [()=>"loop"])window.loopValue=fetch();','window.result=[loopValue,fetch(),window.fetch()];']},
    {name:'eval lexical binding does not escape',scripts:['window.eval('+JSON.stringify('let fetch=()=>"eval local";window.evalValue=fetch()')+');','window.result=[evalValue,fetch(),window.fetch()];']},
    {name:'strict eval lexical binding does not escape',scripts:['window.eval('+JSON.stringify('"use strict";let fetch=()=>"strict eval";window.evalValue=fetch()')+');','window.result=[evalValue,fetch(),window.fetch()];']},
    {name:'eval resolves existing lexical cells',scripts:['let fetch=()=>"lexical";','window.result=[window.eval("fetch()"),window.eval('+JSON.stringify('fetch=()=>"eval write";fetch()')+'),fetch(),window.fetch()];']},
    {name:'global var conflicts retain existing cells',scripts:['let fetch=()=>"lexical";','let error;try{window.eval("var fetch=()=>2")}catch(value){error=value.name}window.result=[error,fetch(),window.fetch()];']},
    {name:'dynamic constructors resolve lexical cells',scripts:['let fetch=()=>"lexical";','const read=window.saved.Function("return fetch()");window.result=[read(),window.fetch()];fetch=()=>"updated";window.result.push(read());']},
    {name:'dynamic with fallback resolves lexical cells',scripts:['let fetch=()=>"lexical";','window.result=[window.saved.Function("with({}){return fetch()}")(),window.saved.Function('+JSON.stringify('with({fetch:()=>"object"}){return fetch()}')+')()];']},
    {name:'with fallback and object bindings',scripts:['let fetch=function(){"use strict";return this===undefined?"lexical":"receiver"};','const object={fetch(){return this===object?"object":"wrong"}};with({})window.fallback=fetch();with(object)window.objectValue=fetch();with(window)window.propertyValue=fetch();window.result=[fallback,objectValue,propertyValue];']},
    {name:'with unscopables',scripts:['let fetch=()=>"lexical";','with({fetch:()=>"hidden",[Symbol.unscopables]:{fetch:true}})window.result=[fetch(),window.fetch()];']},
    {name:'globalThis binding is separate from Window',scripts:['const globalThis=()=>"lexical global";','window.result=[globalThis(),typeof window.globalThis,globalThis===window.globalThis,window.saved.Function("return globalThis()")()];']},
    {name:'module reads the global lexical environment',scripts:['let fetch=()=>"lexical";',{module:true,source:'window.result=[fetch(),window.fetch()];fetch=()=>"module write";window.result.push(fetch());'}]},
    {name:'module locals remain separate',scripts:['let fetch=()=>"lexical";',{module:true,source:'let fetch=()=>"module";window.result=[fetch(),window.eval("fetch()"),window.fetch()];'}]},
    {name:'eval preserves non-string identity',scripts:['const object={toString(){throw new Error("coerced")}},boxed=new String("fetch()"),symbol=Symbol("eval");window.result=[window.eval(object)===object,window.eval(boxed)===boxed,window.eval(symbol)===symbol,window.eval(42),window.eval(null)];']}
  ];
  const origin='https://global-lexicals.test',pages={};
  cases.forEach((example,index)=>{pages['/'+index]='<!doctype html><body><script>window.saved={JSON,Promise,Function,setTimeout:setTimeout.bind(window)};window.errors=[];window.onerror=(message,url,line,column,error)=>{window.errors.push(error.name);return true};window.fetch=()=>"window initial";<\/script>'+example.scripts.map(script=>'<script'+(script.module?' type="module"':'')+'>'+(typeof script==='string'?script:script.source)+'<\/script>').join('')});
  const context=await page.context().browser().newContext(),native=await context.newPage(),cdp=await context.newCDPSession(native);
  await context.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:pages[new URL(route.request().url()).pathname]}));
  const read='new window.saved.Promise(resolve=>{const check=()=>window.result===undefined?window.saved.setTimeout(check,10):resolve(window.saved.JSON.stringify(window.result));check()})';
  try{
    await page.evaluate(({origin,pages})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const url=new URL(target);return url.origin===origin?Promise.resolve(new Response(pages[url.pathname],{headers:{'Content-Type':'text/html'}})):previous(target,options)};},{origin,pages});
    for(let index=0;index<cases.length;index++){
      console.log(JSON.stringify({fixture:'Global lexical',name:cases[index].name}));
      const url=origin+'/'+index;await native.goto(url);const query=await cdp.send('Runtime.evaluate',{expression:read,awaitPromise:true,returnByValue:true});if(query.exceptionDetails)throw new Error('Native global lexical query failed');
      await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=await page.evaluate(source=>main_frame.eval_js(source),read);
      if(actual!==query.result.value)throw new Error('Global lexical parity ('+cases[index].name+'): '+JSON.stringify({expected:query.result.value,actual}));
    }
    return ['Classic global lexical bindings retain shared cells, TDZ, const restrictions and separate Window properties','Modules, eval, generated functions and with statements resolve global lexical bindings in their native scopes'];
  }finally{await context.close()}
}
