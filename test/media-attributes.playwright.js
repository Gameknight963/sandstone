async page=>{
  const origin='https://media-attributes.test',blank='<!doctype html><body>',svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="8"/>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:blank}));
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try{
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,blank,svg})=>{
      const previous=sandstone.network.session.fetch;globalThis.mediaAttributeRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        mediaAttributeRequests.push(url);
        if(url.endsWith('/held.svg'))await new Promise(resolve=>globalThis.releaseMediaAttribute=resolve);
        return new Response(svg,{status:url.endsWith('/missing.svg')?404:200,headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});
      };
      main_frame.special_pages[origin+'/page']=blank;await main_frame.navigate_to(origin+'/page');
    },{origin,blank,svg});
    const cases=[
      ['borrowed methods',`Element.prototype.setAttribute.call(subject,key,'data:,one');capture();Element.prototype.setAttribute.call(subject,key.toUpperCase(),'data:,two');capture();Element.prototype.removeAttribute.call(subject,key);capture()`],
      ['native Attr identity and values',`subject.setAttribute(key,'data:,one');const node=subject.getAttributeNode(key);node.value='data:,two';capture();if(subject.getAttributeNode(key)!==node)throw Error('Attr replaced');node.nodeValue=null;capture();node.textContent='data:,three';capture();subject.removeAttributeNode(node);extras={detached:node.ownerElement===null,value:node.value};capture()`],
      ['attribute maps',`const node=document.createAttribute(key);node.value='data:,one';subject.attributes.setNamedItem(node);capture();const second=document.createAttribute(key);second.value='data:,two';const old=subject.attributes.setNamedItemNS(second);extras={same:old===node,old:old.value,detached:old.ownerElement===null};capture();const removed=subject.attributes.removeNamedItemNS(null,key);extras={same:removed===second,value:removed.value,detached:removed.ownerElement===null};capture()`],
      ['namespaces and qualified names',`subject.setAttributeNS('urn:other',key,'data:,other');capture();subject.setAttribute(key,'data:,changed');capture();subject.setAttributeNS(null,key,'data:,managed');capture();subject.removeAttributeNS('urn:other',key);capture();subject.setAttributeNS(null,key.toUpperCase(),'data:,uppercase');capture()`],
      ['toggle and missing arguments',`capture();subject.toggleAttribute(key,false);capture();subject.toggleAttribute(key,true);capture();subject.toggleAttribute(key,true);capture();subject.toggleAttribute(key);capture();const errors=[];for(const method of ['getAttribute','setAttribute','removeAttribute','getAttributeNS','setAttributeNS'])try{Element.prototype[method].call(subject)}catch(error){errors.push(error.name)}extras={errors};capture()`],
      ['borrowed receiver isolation',`const other=document.createElement(subject.localName),borrowed=subject.setAttribute;borrowed.call(other,key,'data:,other');extras={other:other.getAttribute(key)};capture()`],
      ['coercion and reentrancy',`subject.setAttribute(key,{toString(){subject.setAttribute(key,'data:,inner');return 'data:,outer'}});capture();const node=subject.getAttributeNode(key);node.value={toString(){subject.removeAttributeNode(node);return 'data:,detached'}};extras={detached:node.ownerElement===null,value:node.value};capture()`],
      ['Attr cloning and adoption',`subject.setAttribute(key,'data:,one');const node=subject.getAttributeNode(key),copy=node.cloneNode();const other=document.implementation.createHTMLDocument(''),adopted=other.adoptNode(node);extras={copy:copy.value,copyDetached:copy.ownerElement===null,same:adopted===node,value:adopted.value,document:adopted.ownerDocument===other};capture()`]
    ];
    for(const [tag,key] of [['img','src'],['img','srcset'],['video','poster'],['audio','src'],['source','srcset'],['input','src'],['track','src']])for(const [name,body] of cases){
      const source=`(()=>{const subject=document.createElement(${JSON.stringify(tag)}),key=${JSON.stringify(key)},snapshots=[];let extras=null;const capture=()=>{const node=subject.getAttributeNode(key);snapshots.push({value:Element.prototype.getAttribute.call(subject,key),namespace:subject.getAttributeNS(null,key),has:subject.hasAttribute(key),names:subject.getAttributeNames(),attributes:[...subject.attributes].map(node=>[node.namespaceURI,node.name,node.value]),node:node?{value:node.value,text:node.textContent,nodeValue:node.nodeValue,owner:node.ownerElement===subject,same:subject.attributes.getNamedItem(key)===node}:null,extras});};${body};return JSON.stringify(snapshots)})()`;
      const expected=await native.evaluate(source=>eval(source),source),actual=await evaluate(source);
      if(expected!==actual)throw new Error('Media attributes '+tag+'.'+key+' '+name+' differ: '+actual+' expected '+expected);
    }
    await evaluate(`globalThis.borrowedAttributeImage=new Image();Element.prototype.setAttribute.call(borrowedAttributeImage,'src','/borrowed.svg');globalThis.nodeAttributeImage=new Image();const node=document.createAttribute('src');node.value='/node.svg';nodeAttributeImage.setAttributeNode(node);globalThis.valueAttributeImage=new Image();valueAttributeImage.src='data:,';valueAttributeImage.getAttributeNode('src').value='/value.svg';globalThis.mapAttributeImage=new Image();const mapNode=document.createAttribute('src');mapNode.value='/map.svg';mapAttributeImage.attributes.setNamedItem(mapNode);true`);
    const deadline=Date.now()+8000;
    while(!await evaluate(`[borrowedAttributeImage,nodeAttributeImage,valueAttributeImage,mapAttributeImage].every(image=>image.complete&&image.naturalWidth===10)`)){
      if(Date.now()>deadline)throw new Error('A native attribute mutation did not load through the relay');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const requests=await page.evaluate(()=>mediaAttributeRequests);
    for(const name of ['borrowed','node','value','map'])if(!requests.includes(origin+'/'+name+'.svg'))throw new Error('Attribute request bypassed relay: '+name);
    await evaluate(`globalThis.attributeErrors=0;customElements.define('x-attribute-image',class extends HTMLImageElement{constructor(){super();this.addEventListener('error',()=>attributeErrors++,true);this.src='/held.svg';}},{extends:'img'});globalThis.pendingAttributeImage=new(customElements.get('x-attribute-image'))();globalThis.retainedAttribute=pendingAttributeImage.getAttributeNode('src');true`);
    await page.waitForFunction(()=>typeof releaseMediaAttribute==='function');
    await evaluate(`new Promise(resolve=>setTimeout(resolve,75))`);
    if(!await evaluate(`attributeErrors===0&&retainedAttribute.value==='/held.svg'&&retainedAttribute.ownerElement===pendingAttributeImage&&!pendingAttributeImage.currentSrc.startsWith('data:')`))throw new Error('A pending media placeholder escaped through attributes or events');
    await page.evaluate(()=>releaseMediaAttribute());
    const heldDeadline=Date.now()+8000;
    while(!await evaluate(`pendingAttributeImage.complete&&pendingAttributeImage.naturalWidth===10`)){
      if(Date.now()>heldDeadline)throw new Error('Held media attribute response did not finish');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!await evaluate(`pendingAttributeImage.getAttributeNode('src')===retainedAttribute&&retainedAttribute.value==='/held.svg'`))throw new Error('Completing a relayed load replaced its native Attr');
    await evaluate(`pendingAttributeImage.src='/missing.svg';true`);
    const errorDeadline=Date.now()+8000;
    while(!await evaluate(`attributeErrors===1`)){
      if(Date.now()>errorDeadline)throw new Error('A failed relayed attribute load did not fire its error');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await evaluate(`new Promise(resolve=>setTimeout(resolve,75))`);
    if(!await evaluate(`attributeErrors===1`))throw new Error('A media placeholder produced an additional error');
    if(direct.length)throw new Error('Native media attribute APIs issued direct requests: '+JSON.stringify(direct));
    return ['Native media attributes preserve Attr identity, maps, namespaces and borrowed receivers','Borrowed attribute methods and Attr writes load images through the relay'];
  }finally{await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);}
}
