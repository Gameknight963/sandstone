async(page,cases)=>{
  cases=[...cases,
    {name:'anonymous default export',mode:'module',external:true,importDefault:true,source:'export default function(){return fetch()}'},
    {name:'anonymous async default export',mode:'module',external:true,importDefault:true,source:'export default async function(){return fetch()}'}
  ];
  const url='https://global-functions.test/',pages={},scripts={};
  for(let index=0;index<cases.length;index++){
    const test=cases[index],type=test.mode==='module'?' type="module"':'',setup='globalThis.fetch=()=>"initial";'+(test.setup||'');
    const source=test.mode==='eval'?'globalThis.scopeCompletion=(0,eval)('+JSON.stringify(test.source)+');':test.source;
    const follow=(test.importDefault?'import read from "/script/'+index+'.js";globalThis.scopeResult=[await read(),read.name];':'')+'globalThis.scopeFollowing=fetch();globalThis.scopeComplete=true;';
    scripts['/script/'+index+'.js']=source;
    pages['/case/'+index]='<!doctype html><body><script>'+setup+'<\/script><script'+type+(test.external?' src="/script/'+index+'.js">': '>'+source)+'<\/script><script'+type+'>'+follow+'<\/script>';
  }
  const context=await page.context().browser().newContext(),native=await context.newPage(),cdp=await context.newCDPSession(native);
  await context.route(url+'**',route=>{const path=new URL(route.request().url()).pathname,script=path.startsWith('/script/');return route.fulfill({contentType:script?'text/javascript':'text/html',body:(script?scripts:pages)[path]||'<!doctype html><body>Global function fixture'});});
  const read='(async()=>{const d=Object.getOwnPropertyDescriptor(globalThis,"fetch");return JSON.stringify({complete:!!globalThis.scopeComplete,result:globalThis.scopeResult??null,following:await globalThis.scopeFollowing,completion:globalThis.scopeCompletion??null,descriptor:{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,accessor:!!d.get}})})()';
  try{
    await page.evaluate(({url,pages,scripts})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(target,options)=>{
        const parsed=new URL(target);if(parsed.origin!==new URL(url).origin)return previous(target,options);
        const script=parsed.pathname.startsWith('/script/');return Promise.resolve(new Response((script?scripts:pages)[parsed.pathname]||'<!doctype html><body>Global function fixture',{headers:{'Content-Type':script?'text/javascript':'text/html'}}));
      };
    },{url,pages,scripts});
    for(let index=0;index<cases.length;index++){
      const target=url+'case/'+index,test=cases[index];
      await native.goto(target);
      // CDP evaluates directly, even when the authored page replaces eval.
      const result=await cdp.send('Runtime.evaluate',{expression:read,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw new Error('Native global function query failed: '+test.name);
      const expected=JSON.parse(result.result.value);
      await page.evaluate(target=>main_frame.navigate_to(target),target);
      const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),read));
      if(!expected.complete||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Global function declaration parity ('+test.name+'): '+JSON.stringify({expected,actual}));
    }
    return ['Global function declarations retain hoisting, duplicate selection, property descriptors and separate-script identity','Classic scripts, global/strict eval and modules retain their native global binding boundaries'];
  }finally{await context.close();}
}
