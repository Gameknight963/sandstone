async page=>{
  const url='https://function-constructor.test/start/',html='<!doctype html><base href="/assets/"><body>Function constructor fixture';
  const workerSource=`onmessage=async()=>{try{
    class StaticScope{static{var location='worker local';this.local=()=>location;}static url=location.href;}
    const Async=Object.getPrototypeOf(async function(){}).constructor,Generator=Object.getPrototypeOf(function*(){}).constructor,AsyncGenerator=Object.getPrototypeOf(async function*(){}).constructor;
    const regular=Function('return {url:location.href,global:this===self}')(),asyncValue=await Async('return location.href')(),generator=Generator('yield location.href')().next().value,asyncGenerator=(await AsyncGenerator('yield location.href')().next()).value;
    const module=await Function('return import("./dependency.js")')(),fetchValue=await Function('return fetch("./api").then(response=>response.text())')();
    postMessage({regular,asyncValue,generator,asyncGenerator,module:module.href,fetch:fetchValue,staticScope:[location.href,StaticScope.url,StaticScope.local()]});
  }catch(error){postMessage({error:error.name,message:error.message})}}`;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route('https://function-constructor.test/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('/api')?'text/plain':'text/html',body:path==='/workers/entry.js'?workerSource:path.endsWith('.js')?'export default "imported";export const href=import.meta.url;':path.endsWith('.json')?'{"value":"json-imported"}':path.endsWith('/api')?'relayed':html});});
  const source=`(async()=>{
    const results=[],capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}},families=[Function,Object.getPrototypeOf(async function(){}).constructor,Object.getPrototypeOf(function*(){}).constructor,Object.getPrototypeOf(async function*(){}).constructor];
    results.push({global:Function('return this')()===globalThis,url:Function('return location.href')(),constructor:(()=>{}).constructor===Function,fromPrototype:(()=>{}).constructor('return location.href')()});
    results.push(capture(()=>Function('fetch','return fetch')('local')),capture(()=>Function('{location}','return location')({location:'local'})),capture(()=>Function('value=location.href','return value')()));
    results.push(capture(()=>Function('value=location.href','var location={href:"body"};return [value,location.href]')()),capture(()=>Function('value=()=>location.href','var location;return value()')()));
    results.push(capture(()=>Function('value=location.href','function location(){}return value')()),capture(()=>Function('{[location.hostname]:value}','var location;return value')({[location.hostname]:7})));
    function parameterScope(value=location.href){var location={href:'body'};return [value,location.href];}
    const arrowScope=(value=()=>location.href)=>{var location;return value();};
    results.push(capture(()=>parameterScope()),capture(()=>arrowScope()));
    results.push(capture(()=>Function('switch(location.href){default:let location="body";return location;}')()),capture(()=>Function('switch("value"){case location:let location="body";}')()));
    results.push(capture(()=>Function('class Model{static{var location="first";this.first=()=>location;}static url=location.href;static{let location="second";this.second=()=>location;}static later=location.href;}return [location.href,Model.url,Model.later,Model.first(),Model.second()];')()));
    class StaticScope{static{var location='first';this.first=()=>location;}static url=location.href;static{let location='second';this.second=()=>location;}static later=location.href;}
    results.push({staticScope:[location.href,StaticScope.url,StaticScope.later,StaticScope.first(),StaticScope.second()]});
    results.push(capture(()=>Function('__ctx__','return [__ctx__,location.href]')('local')),capture(()=>Function('__get_this__','return [__get_this__,this===globalThis]')('local')),capture(()=>Function('return typeof anonymous')()),capture(()=>Function('return typeof __sandstone_dynamic_context__')()));
    const locals={name:'local name',location:'local location',value:7,fetch(){return this.value;}};
    results.push(capture(()=>Function('data','with(data){return [name,location,fetch(),this===globalThis]}')(locals)));
    results.push(capture(()=>Function('data','with(data){name=name+"!";return name}')(locals)),{localName:locals.name});
    results.push(capture(()=>Function('value','return eval("value")')(7)),capture(()=>Function('return eval("location.href")')()),capture(()=>Function('return (0,eval)("location.href")')()));
    results.push(capture(()=>Function('eval("var location=7");return location')()));
    results.push(await Function('with({}){return new Promise(resolve=>setTimeout(()=>resolve(location.href),0))}')().then(value=>({withAsync:value}),error=>({error:error.name})));
    const calls=[],param={toString(){calls.push('parameter');return 'value';}},body={toString(){calls.push('body');return 'return value';}},converted=Function(param,body);results.push({calls,value:converted(7)});
    const strict=Function('"use strict";return this'),sloppy=Function('return this');results.push({strict:strict()===undefined,sloppy:sloppy.call(null)===globalThis,object:sloppy.call({value:7}).value});
    const target=Function('return new.target');results.push({newTarget:new target()===target,prototype:target.prototype.constructor===target});
    for(const operation of [()=>Function('a /*','return 1'),()=>Function('return )'),()=>Function(Symbol('body')),()=>Function('value=1','"use strict";return value')])results.push(capture(operation));
    for(let index=0;index<families.length;index++){
      const Constructor=families[index],generator=index>=2,fn=Constructor('value=location.href',generator?'var location;yield value;return this===globalThis':'var location;return [value,this===globalThis]');
      let value;if(generator){const iterator=fn();value=[(await iterator.next()).value,(await iterator.next()).value];}else value=await fn();
      results.push({kind:index,value,name:fn.name,length:fn.length,constructor:fn.constructor===Constructor,tag:Object.prototype.toString.call(fn),parent:index===0?Object.getPrototypeOf(Constructor)===Function.prototype:Object.getPrototypeOf(Constructor)===Function,source:Function.prototype.toString.call(fn)});
    }
    class Factory extends Function{}const subclass=new Factory('value','return [value,location.hostname]');results.push({subclass:subclass instanceof Factory,prototype:Object.getPrototypeOf(subclass)===Factory.prototype,value:subclass(7)});
    let reads=0;const NewTarget=new Proxy(function(){},{get(target,key,receiver){if(key==='prototype')reads++;return Reflect.get(target,key,receiver);}}),custom=Reflect.construct(Function,['return location.href'],NewTarget);results.push({reads,url:custom()});
    results.push(await Function('return fetch("/api").then(response=>response.text())')().then(value=>({fetch:value}),error=>({error:error.name})));
    results.push(await Function('return import("./module.js")')().then(value=>({module:value.default,url:value.href}),error=>({error:error.name})));
    const late=Function('return import("./late.js")'),base=document.querySelector('base'),savedBase=base.href;base.href='/later/';
    results.push(await late().then(value=>({late:value.href}),error=>({error:error.name})));base.href=savedBase;
    results.push(await Function('change','return import(change())')(()=>{base.href='/argument/';return './argument.js';}).then(value=>({argument:value.href}),error=>({error:error.name})));base.href=savedBase;
    const order=[],specifier={toString(){order.push('specifier');base.href='/converted/';return './converted.js';}},options={get with(){order.push('with');base.href='/attributes/';return {};}};
    results.push(await Function('specifier','options','return import(specifier,options)')(specifier,options).then(value=>({converted:value.href,order}),error=>({error:error.name,order})));base.href=savedBase;
    for(const options of [null,3,{with:null},{with:3},{with:{type:3}},{with:{unsupported:'value'}},{with:{type:''}},{with:{type:'javascript'}}])results.push(await Function('options','return import("./invalid.js",options)')(options).then(()=>({loaded:true}),error=>({error:error.name})));
    results.push(await Function('return import("./data.json",{with:{type:"json"}})')().then(value=>({json:value.default.value}),error=>({error:error.name})));
    const attributeReads=[],attributes={};Object.defineProperties(attributes,{first:{enumerable:true,get(){attributeReads.push('first');return 3;}},second:{enumerable:true,get(){attributeReads.push('second');return 'value';}}});
    results.push(await Function('attributes','return import("./invalid.js",{with:attributes})')(attributes).then(()=>({loaded:true}),error=>({error:error.name,attributeReads})));
    const frame=document.createElement('iframe');document.body.append(frame);const child=frame.contentWindow,foreign=child.Function('return location.href');results.push({child:foreign(),source:Function.prototype.toString.call(foreign),constructor:foreign.constructor===child.Function});frame.remove();
    for(const type of ['classic','module']){const worker=new Worker('/workers/entry.js?mode='+type,{type});try{results.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Dynamic worker functions timed out')),5000);worker.onmessage=event=>{clearTimeout(timer);resolve({worker:type,...event.data})};worker.onerror=()=>{clearTimeout(timer);reject(new Error('Dynamic worker functions failed'))};worker.postMessage('run')}));}finally{worker.terminate();}}
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(({url,html,workerSource})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const path=new URL(target).pathname;return new URL(target).origin===new URL(url).origin?Promise.resolve(new Response(path==='/workers/entry.js'?workerSource:path.endsWith('.js')?'export default "imported";export const href=import.meta.url;':path.endsWith('.json')?'{"value":"json-imported"}':path.endsWith('/api')?'relayed':html,{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('/api')?'text/plain':'text/html'}})):previous(target,options);};},{url,html,workerSource});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Function constructor parity: '+JSON.stringify({expected,actual}));
    return ['Dynamic Function constructors retain parameter scope, native validation and authored source identity','Regular, async and generator constructors use virtual globals and relayed fetch/import in their creating realm','Classic and module workers compile dynamic functions with virtual locations and relayed imports'];
  }finally{await context.close();}
}
