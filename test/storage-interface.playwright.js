async page=>{
  const url='https://storage-interface.test/',html='<!doctype html><body>Storage interface';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(url,route=>route.fulfill({contentType:'text/html',body:html}));
  const source=`(()=>{
    const results=[],capture=callback=>{try{const value=callback();return {value:value===undefined?null:value};}catch(error){return {error:error.name};}};
    const frame=document.createElement('iframe');document.body.append(frame);
    for(const name of ['localStorage','sessionStorage']){
      const store=window[name],other=frame.contentWindow[name];store.clear();
      const methods=Object.fromEntries(['getItem','setItem','removeItem','clear','key'].map(key=>[key,{length:Storage.prototype[key].length,stable:store[key]===store[key],prototype:store[key]===Storage.prototype[key]}]));
      results.push({name,instance:store instanceof Storage,prototype:Object.getPrototypeOf(store)===Storage.prototype,constructor:store.constructor===Storage,tag:Object.prototype.toString.call(store),methods,
        construct:capture(()=>new Storage()),borrow:capture(()=>{Storage.prototype.setItem.call(store,'borrowed','saved');return Storage.prototype.getItem.call(store,'borrowed');}),
        crossRealm:capture(()=>{Storage.prototype.setItem.call(other,'cross-realm','shared');return [store.getItem('cross-realm'),other instanceof frame.contentWindow.Storage,other instanceof Storage];}),
        getter:capture(()=>Object.getOwnPropertyDescriptor(Storage.prototype,'length').get.call(store))});
      const bad=[];
      for(const method of ['getItem','setItem','removeItem','clear','key']){
        bad.push(capture(()=>Storage.prototype[method].call({})));
        if(method!=='clear')bad.push(capture(()=>store[method]()));
      }
      bad.push(capture(()=>store.setItem('missing-value')),capture(()=>store.getItem(Symbol('key'))),capture(()=>store.setItem('symbol',Symbol('value'))),capture(()=>store.key(1n)));
      results.push({bad});
      const original=Storage.prototype.setItem,calls=[];
      try{Storage.prototype.setItem=function(key,value){calls.push([key,value]);return original.call(this,key,value);};store.setItem('patched','yes');results.push({patch:calls,value:store.getItem('patched')});}finally{Storage.prototype.setItem=original;}
      const borrowed=store.getItem;results.push({unbound:capture(()=>borrowed('patched'))});
      store.clear();
      results.push({named:capture(()=>{
        for(const key of ['getItem','constructor','length','toString','__proto__','ordinary','_get_entries','_replace_entries'])Storage.prototype.setItem.call(store,key,'stored');
        const keys=Object.keys(store).sort(),descriptors=['getItem','constructor','length','ordinary'].map(key=>({key,own:Object.hasOwn(store,key),hasOwn:store.hasOwnProperty(key),descriptor:!!Object.getOwnPropertyDescriptor(store,key),reflect:!!Reflect.getOwnPropertyDescriptor(store,key)}));
        const defined=capture(()=>{Object.defineProperty(store,'defined',{value:23,writable:true,enumerable:true,configurable:true});return [store.getItem('defined'),store.defined];});
        const fixed=capture(()=>{Object.defineProperty(store,'fixed',{value:'fixed'});return store.getItem('fixed');});
        return {keys,descriptors,method:typeof store.getItem,length:store.length,defined,fixed,names:Object.getOwnPropertyNames(store).sort(),ownKeys:Reflect.ownKeys(store).filter(key=>typeof key==='string').sort(),entries:Object.entries(store).map(([key,value])=>[key,typeof value,typeof value==='string'?value:null]).sort()};
      })});
      store.clear();
      const reentrantGet=store.getItem({toString(){store.clear();store.setItem('coercion','changed');return 'coercion';}});
      const reentrantKey=store.key({valueOf(){store.clear();store.setItem('after-coercion','changed');return 0;}});
      results.push({coercion:{reentrantGet,reentrantKey}});store.clear();
      const symbol=Symbol('own');
      results.push({definitions:capture(()=>{
        Object.defineProperties(store,{bulk:{value:34},empty:{enumerable:true}});
        const reflected=Reflect.defineProperty(store,'reflected',{value:45});
        Object.defineProperty(store,symbol,{value:56,configurable:false});
        const accessor=Reflect.defineProperty(store,'accessor',{get(){return 'ordinary';},enumerable:true});
        return {bulk:store.getItem('bulk'),empty:store.getItem('empty'),reflected,value:store.getItem('reflected'),symbol:store[symbol],accessor,accessorValue:store.accessor,accessorStored:store.getItem('accessor'),accessorKeys:Object.keys(store).includes('accessor'),objectAccessor:capture(()=>Object.defineProperty(store,'accessor',{get(){return 'bad';}})),replaceAccessor:Reflect.defineProperty(store,'accessor',{value:'bad'}),prevent:Reflect.preventExtensions(store),extensible:Object.isExtensible(store)};
      })});store.clear();
    }
    const detached=[frame.contentWindow.localStorage,frame.contentWindow.sessionStorage];frame.remove();
    results.push({detached:detached.map(store=>[capture(()=>Storage.prototype.getItem.call(store,'key')),capture(()=>Storage.prototype.getItem.call(store)),capture(()=>Storage.prototype.getItem.call(store,Symbol('key'))),capture(()=>Storage.prototype.key.call(store,1n)),capture(()=>Storage.prototype.setItem.call(store,'missing'))])});
    return JSON.stringify(results);
  })()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await page.evaluate(async({url,html})=>{main_frame.special_pages[url]=html;await main_frame.navigate_to(url);},{url,html});
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected)){console.log(JSON.stringify({storageInterface:{expected,actual}}));throw new Error('Storage interface differs from native');}
    return ['Web Storage retains native prototypes, method identity and instance checks','Borrowed and cross-realm Storage methods retain receiver validation and argument conversions','Storage prototype instrumentation observes virtual writes and restores normally'];
  }finally{await context.close();}
}
