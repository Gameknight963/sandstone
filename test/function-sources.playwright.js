async page=>{
  const source=`(()=>{
    function portable(value=()=>location.href){return this.value+value()}
    const arrow=value=>this.value+location.href;
    const object={get value(){return this.location},async *[(()=>"key")()](){yield location.href}};
    class Example extends (function Base(){}) {static /* trivia */ get value(){return this.location} method(value=()=>location.href){return value()} #value=1;read(){return this.#value}}
    const dynamic=Function('return function nested(){return this.value+location.href}')();
    function require(){}require.toUrl=value=>'assets/'+value;Object.defineProperty(require,'config',{enumerable:true,get(){return 'configured'}});
    const namespace=Object.create(null,{[Symbol.toStringTag]:{value:'Module'}});
    for(const key in require){const descriptor=Object.getOwnPropertyDescriptor(require,key);Object.defineProperty(namespace,key,descriptor.get?descriptor:{enumerable:true,get:()=>require[key]});}
    Object.freeze(namespace);
    const values=[portable,arrow,Object.getOwnPropertyDescriptor(object,'value').get,object.key,Example,Object.getOwnPropertyDescriptor(Example,'value').get,Example.prototype.method,Example.prototype.read,dynamic];
    const strings=values.map(value=>Function.prototype.toString.call(value));
    return JSON.stringify({strings,names:values.map(value=>value.name),strict:(function strict(){"use strict";return this})()===undefined,constructed:Function('return 42').toString(),literal:(function literal(){return '__ctx__.location'}).toString(),namespace:{keys:Object.keys(namespace),url:namespace.toUrl('worker.js'),config:namespace.config,frozen:Object.isFrozen(namespace)},prototype:Object.keys(Function.prototype)});
  })()`;
  const context=await page.context().browser().newContext();
  try{
    const native=await context.newPage();await native.goto('about:blank');
    const expected=JSON.parse(await native.evaluate(source));
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Function source mismatch: '+JSON.stringify({actual,expected}));
    const worker=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`(async()=>{
      function boot(){self.onmessage=event=>postMessage({value:event.data,global:this===self,prototype:Object.keys(Function.prototype)});}
      const url=URL.createObjectURL(new Blob(['('+boot.toString()+')()'],{type:'text/javascript'}));
      const worker=new Worker(url);
      try{return JSON.stringify(await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=()=>reject(new Error('Serialized function worker failed'));worker.postMessage('serialized');}));}
      finally{worker.terminate();URL.revokeObjectURL(url);}
    })()`)));
    if(worker.value!=='serialized'||worker.global!==true||worker.prototype.length)throw new Error('Serialized worker result: '+JSON.stringify(worker));
    const shared=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`(async()=>{
      const frame=document.createElement('iframe');
      const ready=new Promise(resolve=>{const listener=event=>{if(event.source===frame.contentWindow&&event.data==='function-source-ready'){removeEventListener('message',listener);resolve();}};addEventListener('message',listener);});
      frame.srcdoc='<script>window.authored=function child(){return this.value};parent.postMessage("function-source-ready","*");<\\/script>';
      document.body.append(frame);await ready;
      function outer(){return this.value}
      const child=frame.contentWindow.authored;
      const borrowed=frame.contentWindow.Function.prototype.toString.call(outer),local=Function.prototype.toString.call(child);
      frame.remove();
      return JSON.stringify({borrowed,local,retained:child.toString(),prototype:Object.keys(Object.getPrototypeOf(child))});
    })()`)));
    if(shared.borrowed!=='function outer(){return this.value}'||shared.local!=='function child(){return this.value}'||shared.retained!==shared.local||shared.prototype.length)throw new Error('Shared function sources: '+JSON.stringify(shared));
    return ['Function and class stringification preserves authored source, names and strict directives','Functions serialize into workers without leaking runtime helpers','Borrowed function stringification shares authored sources across same-origin frames and removal','Function namespace wrappers retain native enumeration without inherited runtime properties'];
  }finally{await context.close()}
}
