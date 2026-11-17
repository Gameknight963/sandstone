async page=>{
  const origin='https://image-constructor.test',blank='<!doctype html><base href="/assets/"><body>';
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="green"/></svg>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.svg')?'image/svg+xml':'text/html',body:route.request().url().endsWith('.svg')?svg:blank}));
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try{
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,blank,svg})=>{
      const previous=sandstone.network.session.fetch;
      globalThis.imageConstructorRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        imageConstructorRequests.push(url);
        return new Response(svg,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});
      };
      main_frame.special_pages[origin+'/page']=blank;await main_frame.navigate_to(origin+'/page');
    },{origin,blank,svg});
    const cases=[
      ['dimension conversion',`const rows=[];for(const args of [[],[undefined],[null],[undefined,7],[-1,2],[2.8,'3'],[Infinity,NaN],[4294967301,9],[1n],[Symbol('width')]])try{const image=new Image(...args);rows.push({width:image.width,height:image.height,attrWidth:image.getAttribute('width'),attrHeight:image.getAttribute('height')});}catch(error){rows.push({error:error.name});}result=rows;`],
      ['derived prototype and private fields',`class Derived extends Image{#marker=42;marker(){return this.#marker;}get width(){return 99;}}const image=new Derived(7,8);result={derived:image instanceof Derived,native:image instanceof HTMLImageElement,prototype:Object.getPrototypeOf(image)===Derived.prototype,constructor:image.constructor===Derived,marker:image.marker(),width:image.width,attrWidth:image.getAttribute('width'),height:image.height};`],
      ['prototype lookup and argument order',`const order=[],target=new Proxy(function(){},{get(target,key,receiver){if(key==='prototype')order.push('prototype');return Reflect.get(target,key,receiver);}});const image=Reflect.construct(Image,[{valueOf(){order.push('width');return 2;}},{valueOf(){order.push('height');return 3;}}],target);result={order,prototype:Object.getPrototypeOf(image)===target.prototype,width:Element.prototype.getAttribute.call(image,'width'),height:Element.prototype.getAttribute.call(image,'height')};`],
      ['inherited URL accessors',`let writes=0;class Derived extends Image{get src(){return 'custom:'+super.src;}set src(value){writes++;super.src=value;}}const image=new Derived();image.src='data:image/svg+xml,';result={writes,src:image.src,attr:image.getAttribute('src'),own:Object.hasOwn(image,'src')};`],
      ['native URL descriptor shape',`const image=new Image();result={src:Object.hasOwn(image,'src'),srcset:Object.hasOwn(image,'srcset'),currentSrc:Object.hasOwn(image,'currentSrc'),prototype:Image.prototype===HTMLImageElement.prototype,length:Image.length,name:Image.name};`],
      ['class fields retain native shadowing',`class Derived extends Image{src='authored field';}const image=new Derived();result={src:image.src,attribute:image.getAttribute('src'),own:Object.hasOwn(image,'src'),prototype:Object.getPrototypeOf(image)===Derived.prototype};`],
      ['prototype accessor metadata',`result=['src','srcset','currentSrc'].map(key=>{const property=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,key);return {key,enumerable:property.enumerable,configurable:property.configurable,getName:property.get.name,getLength:property.get.length,setName:property.set?.name,setLength:property.set?.length};});`],
      ['URL conversion and receiver checks',`const setter=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set,getter=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').get,image=new Image(),events=[];for(const [receiver,args] of [[{},[{toString(){events.push('invalid');return 'data:,';}}]],[image,[]],[image,[Symbol('src')]]])try{Reflect.apply(setter,receiver,args)}catch(error){events.push(error.name)}setter.call(image,{toString(){events.push('string');return 'data:,\uD800';}});result={events,value:image.getAttribute('src'),src:getter.call(image)};`],
      ['newTarget prototype does not get traversed',`const events=[],prototype=new Proxy({},{getPrototypeOf(){events.push('getPrototypeOf');throw new Error('prototype traversed')}}),target=new Proxy(function(){},{get(target,key,receiver){return key==='prototype'?prototype:Reflect.get(target,key,receiver);}});const image=Reflect.construct(Image,[5,6],target);result={events,prototype:Object.getPrototypeOf(image)===prototype,width:Element.prototype.getAttribute.call(image,'width')};`]
    ];
    for(const [name,body] of cases){
      const source=`(()=>{let result;${body}return JSON.stringify(result)})()`;
      const expected=await native.evaluate(source=>eval(source),source),actual=await evaluate(source);
      if(actual!==expected)throw new Error('Image '+name+' differs: '+actual+' expected '+expected);
    }
    await evaluate(`globalThis.derivedImage=new(class extends Image{#writes=0;get src(){return super.src;}set src(value){this.#writes++;super.src=value;}writes(){return this.#writes;}})();derivedImage.src='derived.svg';globalThis.borrowedImage=new Image();Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set.call(borrowedImage,'borrowed.svg');globalThis.reflectImage=new Image();Reflect.set(HTMLImageElement.prototype,'src','reflect.svg',reflectImage);globalThis.responsiveImage=new Image();Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'srcset').set.call(responsiveImage,'responsive.svg 1x');true`);
    await evaluate(`customElements.define('x-prototype-image',class extends HTMLImageElement{constructor(){super();this.src='custom.svg';}marker(){return 42;}},{extends:'img'});globalThis.customImage=new(customElements.get('x-prototype-image'))();true`);
    const deadline=Date.now()+8000;
    while(!await evaluate(`[derivedImage,borrowedImage,reflectImage,responsiveImage,customImage].every(image=>image.complete&&image.naturalWidth===12)`)){
      if(Date.now()>deadline)throw new Error('An image constructor or borrowed setter did not load through the relay');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!await evaluate(`derivedImage.writes()===1&&derivedImage.src==='${origin}/assets/derived.svg'&&customImage.marker()===42&&Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'currentSrc').get.call(borrowedImage)==='${origin}/assets/borrowed.svg'`))throw new Error('Inherited image setters or borrowed URL getters lost virtual URLs');
    const requests=await page.evaluate(()=>imageConstructorRequests);
    for(const name of ['derived','borrowed','reflect','responsive','custom'])if(!requests.includes(origin+'/assets/'+name+'.svg'))throw new Error('Image request bypassed relay: '+name);
    if(direct.length)throw new Error('Image constructors or borrowed setters issued direct requests: '+JSON.stringify(direct));
    return ['Image construction preserves native subclassing, newTarget and conversion order','Image prototype URL accessors and inherited setters stay on the relay'];
  }finally{
    await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);
  }
}
