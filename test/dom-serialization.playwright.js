async page=>{
  const origin='https://dom-serialization.test',svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="8"/>';
  const html=`<!doctype html><body><section id="fixture" data-note='a&lt;&gt;&quot;&amp;&nbsp;'><img id="image" src="/image.svg"><svg xmlns="http://www.w3.org/2000/svg"><image id="svg-image" href="/svg.svg"/></svg><style id="sheet-text">.sample { background-image: url('/background.svg'); }</style><div id="inline" style="background-image: url('/inline.svg'); color: red"></div><link rel="stylesheet" href="/sheet.css" id="sheet-link"><script src="/script.js" id="authored-script" defer></script><template id="template"><img src="/template.svg"><noscript><b>fallback</b></noscript></template><noscript id="fallback"><b>raw fallback &amp; text</b></noscript></section>`;
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path.endsWith('.svg')?'image/svg+xml':path.endsWith('.css')?'text/css':path.endsWith('.js')?'application/javascript':'text/html',body:path.endsWith('.svg')?svg:path.endsWith('.css')?'.sheet { color: green }':path.endsWith('.js')?'globalThis.serializedScripts=(globalThis.serializedScripts||0)+1':path==='/child'?'<!doctype html><body>child</body>':html});});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try{
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,html,svg})=>{
      const previous=sandstone.network.session.fetch;globalThis.serializationRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        serializationRequests.push(url);const path=new URL(url).pathname;
        return new Response(path.endsWith('.svg')?svg:path.endsWith('.css')?'.sheet { color: green }':path==='/child'?'<!doctype html><body>child</body>':'globalThis.serializedScripts=(globalThis.serializedScripts||0)+1',{headers:{'Content-Type':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.css')?'text/css':path==='/child'?'text/html':'application/javascript','Cache-Control':'no-store'}});
      };
      main_frame.special_pages[origin+'/page']=html;await main_frame.navigate_to(origin+'/page');
    },{origin,html,svg});
    const cases=[
      ['authored subtree',`result={inner:fixture.innerHTML,outer:fixture.outerHTML};`],
      ['script, stylesheet, inline CSS and templates',`result=['authored-script','sheet-text','sheet-link','inline','template','fallback'].map(id=>{const element=document.getElementById(id);return [id,element.innerHTML,element.outerHTML]});`],
      ['detached fragments and context text',`const host=document.createElement('div');host.innerHTML='<textarea> &amp; &lt; text</textarea><pre>\\ntext</pre><!-- comment --><svg><text>&lt;&amp;</text></svg>';const image=document.createElement('img');image.append(document.createTextNode('void child'));result={html:host.innerHTML,voidInner:image.innerHTML,voidOuter:image.outerHTML};`],
      ['namespace serialization',`const host=document.createElement('div'),node=document.createElementNS('urn:custom','p:node');node.setAttributeNS('urn:attributes','other','a<>&"');node.setAttributeNS('urn:attributes','a:prefixed','value');node.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:lang','en');host.append(node);result=host.innerHTML;`],
      ['inert document serialization',`const other=new DOMParser().parseFromString('<!doctype html><body><noscript><b>&amp;</b></noscript><img src="image.svg">','text/html');result=other.body.innerHTML;`],
      ['XML document serialization',`const other=new DOMParser().parseFromString('<root xmlns="urn:root"><child a="&amp;&quot;">text<![CDATA[<&]]></child></root>','application/xml');result={inner:other.documentElement.innerHTML,outer:other.documentElement.outerHTML,xml:new XMLSerializer().serializeToString(other)};`],
      ['shadow markup',`const host=document.createElement('div'),root=host.attachShadow({mode:'closed'});root.innerHTML='<img src="/shadow.svg"><style>.sample{background:url(/shadow-background.svg)}</style>';result=root.innerHTML;`],
      ['serialized media Attr',`const node=document.getElementById('image').getAttributeNode('src');result=new XMLSerializer().serializeToString(node);`],
      ['serialized standalone CSS text',`result=new XMLSerializer().serializeToString(document.getElementById('sheet-text').firstChild);`],
      ['custom constructors and mutations stay idle',`let constructors=0,mutations=0;customElements.define('x-serialize-check',class extends HTMLElement{constructor(){super();constructors++;}});const host=document.createElement('div');host.append(document.createElement('x-serialize-check'));const observer=new MutationObserver(records=>mutations+=records.length);observer.observe(host,{subtree:true,attributes:true,childList:true});const before=constructors;const one=host.outerHTML,two=host.innerHTML;mutations+=observer.takeRecords().length;observer.disconnect();result={one,two,constructors:constructors-before,mutations};`],
      ['deep native tree',`const host=document.createElement('div');let node=host;for(let index=0;index<1500;index++){const next=document.createElement('div');node.append(next);node=next;}node.textContent='leaf';result={length:host.outerHTML.length,tail:host.outerHTML.endsWith('leaf'+'</div>'.repeat(1501))};`]
    ];
    for(const [name,body] of cases){
      const code=`(()=>{const fixture=document.getElementById('fixture');let result;${body};return JSON.stringify(result)})()`;
      const expected=await evaluate(false,code),actual=await evaluate(true,code);
      if(expected!==actual)throw new Error('DOM serialization '+name+' differs: '+actual+' expected '+expected);
    }
    for(const proxy of [false,true])await evaluate(proxy,`document.getElementById('inline').style.color='blue';true`);
    const inlineCode=`document.getElementById('inline').outerHTML`;
    const expected=await evaluate(false,inlineCode),actual=await evaluate(true,inlineCode);
    if(expected!==actual)throw new Error('Mutated inline style serialization differs: '+actual+' expected '+expected);
    for(const proxy of [false,true])await evaluate(proxy,`globalThis.serializedFrame=document.createElement('iframe');serializedFrame.id='serialized-frame';serializedFrame.src='/child';document.body.append(serializedFrame);true`);
    await new Promise(resolve=>setTimeout(resolve,100));
    if(await evaluate(false,'serializedFrame.outerHTML')!==await evaluate(true,'serializedFrame.outerHTML'))throw new Error('Iframe serialization exposed its runtime URL or private navigation metadata');
    await evaluate(true,`globalThis.serializationCopy=document.createElement('div');serializationCopy.innerHTML=document.getElementById('fixture').innerHTML;document.body.append(serializationCopy);document.getElementById('image').src='/replacement.svg';true`);
    const deadline=Date.now()+10000;
    while(!await evaluate(true,`serializationCopy.querySelector('img').complete&&serializationCopy.querySelector('img').naturalWidth===10`)){
      if(Date.now()>deadline)throw new Error('Serialized HTML did not reload authored resources through the relay');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!await evaluate(true,`serializationCopy.querySelector('img').getAttribute('src')==='/image.svg'&&serializedScripts===1`))throw new Error('Serialized HTML retained a local lease or executed an inert script');
    if(direct.length)throw new Error('Serializing markup issued direct requests: '+JSON.stringify(direct));
    return ['HTML serialization preserves authored resources, templates, CSS and native escaping','Serialization preserves native document contexts without constructors or live mutations'];
  }finally{await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);}
}
