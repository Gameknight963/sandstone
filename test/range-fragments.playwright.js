async page=>{
  const origin='https://range-fragments.test',html='<!doctype html><body><main id="fixture"></main>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const cases=[
    ['table context',"const subject=document.createElement('table');fixture.append(subject);range.selectNodeContents(subject);const fragment=range.createContextualFragment('<tr><td>Cell</td></tr>');range.insertNode(fragment)"],
    ['SVG context',"const subject=document.createElementNS('http://www.w3.org/2000/svg','svg');fixture.append(subject);range.selectNodeContents(subject);range.insertNode(range.createContextualFragment('<g><circle></circle></g>'))"],
    ['text context',"const subject=document.createElementNS('http://www.w3.org/2000/svg','text');fixture.append(subject);subject.textContent='Text';range.setStart(subject.firstChild,1);range.insertNode(range.createContextualFragment('<tspan>Inserted</tspan>'))"],
    ['document context',"const fragment=range.createContextualFragment('<tr><td>Text</td></tr><p>Body</p>');fixture.append(fragment)"],
    ['form ancestor',"const form=document.createElement('form'),subject=document.createElement('div');fixture.append(form);form.append(subject);range.selectNodeContents(subject);range.insertNode(range.createContextualFragment('<form><input name=field></form>'))"],
    ['XML namespace context',"const xml=new DOMParser().parseFromString('<root xmlns:p=\"urn:range\"><child/></root>','application/xml');range.selectNodeContents(xml.documentElement.firstChild);range.insertNode(range.createContextualFragment('<p:leaf/>'));fixture.append(xml.documentElement)"],
    ['XML invalid markup',"const xml=new DOMParser().parseFromString('<root/>','application/xml');range.selectNodeContents(xml.documentElement);let error;try{range.createContextualFragment('<broken>')}catch(value){error=value.name}fixture.textContent=error"],
    ['owner document',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<span>Child</span>');fixture.textContent=JSON.stringify({fragment:fragment.ownerDocument===fixture.ownerDocument,child:fragment.firstChild.ownerDocument===fixture.ownerDocument});fixture.append(fragment)"],
    ['fragment context',"const fragment=document.createDocumentFragment();range.selectNodeContents(fragment);const result=range.createContextualFragment('<tr><td>Text</td></tr><p>Body</p>');fixture.append(result)"],
    ['shadow context',"const host=document.createElement('div');fixture.append(host);const root=host.attachShadow({mode:'open'});range.selectNodeContents(root);range.insertNode(range.createContextualFragment('<b>Shadow</b>'));fixture.append(root.textContent)"],
    ['HTML root context',"range.selectNodeContents(document.documentElement);const result=range.createContextualFragment('<title>Title</title><p>Body</p>');fixture.append(result)"],
    ['null markup',"range.selectNodeContents(fixture);range.insertNode(range.createContextualFragment(null))"],
    ['noscript child parsing',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<noscript><b>Fallback</b></noscript>'),subject=fragment.firstChild;fixture.textContent=JSON.stringify({type:subject.firstChild.nodeType,name:subject.firstChild.localName||null,text:subject.textContent})"],
    ['noscript context parsing',"range.selectNodeContents(document.createElement('noscript'));const fragment=range.createContextualFragment('<b>Fallback</b>');fixture.textContent=JSON.stringify({type:fragment.firstChild.nodeType,name:fragment.firstChild.localName||null,text:fragment.textContent})"],
    ['noscript context end tag',"range.selectNodeContents(document.createElement('noscript'));const fragment=range.createContextualFragment('<b>Before</b></NOSCRIPT ><b>After</b>');fixture.textContent=JSON.stringify(Array.from(fragment.childNodes,node=>({type:node.nodeType,name:node.localName||null,text:node.textContent})))"],
    ['noscript unfinished context end tag',"range.selectNodeContents(document.createElement('noscript'));const fragment=range.createContextualFragment('<b>Before</b></noscript attribute=\"unfinished');fixture.textContent=JSON.stringify(Array.from(fragment.childNodes,node=>({type:node.nodeType,name:node.localName||null,text:node.textContent})))"],
    ['noscript other raw end tag',"range.selectNodeContents(document.createElement('noscript'));const fragment=range.createContextualFragment('</style><noscript><b>Literal</b></noscript>');fixture.textContent=JSON.stringify(Array.from(fragment.childNodes,node=>({type:node.nodeType,name:node.localName||null,text:node.textContent})))"],
    ['raw text contexts with noscript',"const results=[];for(const tag of ['script','style','textarea','title','xmp','iframe','plaintext']){range.selectNodeContents(document.createElement(tag));const fragment=range.createContextualFragment('</'+tag+'><noscript>&lt;<b>Literal</b></noscript>');results.push([tag,Array.from(fragment.childNodes,node=>({type:node.nodeType,name:node.localName||null,text:node.textContent}))])}fixture.textContent=JSON.stringify(results)"],
    ['head noscript parsing',"range.selectNodeContents(document.createElement('head'));const fragment=range.createContextualFragment('<noscript data-mode=\"&lt;x&gt;\"><b>Fallback</b>&lt;literal&gt;</noscript><meta name=after>');fixture.textContent=JSON.stringify(Array.from(fragment.childNodes,node=>({name:node.localName,text:node.textContent,attributes:Array.from(node.attributes||[],attr=>[attr.name,attr.value])})))"],
    ['foreign noscript parsing',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<svg><noscript><circle/></noscript><foreignObject><noscript><b>HTML</b></noscript></foreignObject></svg>');fixture.textContent=JSON.stringify(Array.from(fragment.querySelectorAll('noscript'),node=>({namespace:node.namespaceURI,text:node.textContent,types:Array.from(node.childNodes,node=>node.nodeType)})))"],
    ['template noscript parsing',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<template><noscript><b>Fallback</b></noscript></template>'),subject=fragment.firstChild.content.firstChild;fixture.textContent=JSON.stringify({type:subject.firstChild.nodeType,text:subject.textContent,attributes:Array.from(subject.attributes,attr=>attr.name)})"],
    ['quoted fake noscript',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<script>const text=\"<noscript>fake</noscript>\";<\\/script><div title=\"<noscript>fake</noscript>\"></div><noscript>actual</noscript>');fixture.textContent=JSON.stringify(Array.from(fragment.childNodes,node=>({name:node.localName,text:node.textContent,attributes:Array.from(node.attributes,attr=>[attr.name,attr.value])})))"],
    ['receiver validation',"let calls=0,error;try{Range.prototype.createContextualFragment.call({}, {toString(){calls++;return ''}})}catch(value){error=value.name}fixture.textContent=JSON.stringify({calls,error})"],
    ['missing argument',"let error;try{range.createContextualFragment()}catch(value){error=value.name}fixture.textContent=error"],
    ['Symbol markup',"let error;try{range.createContextualFragment(Symbol())}catch(value){error=value.name}fixture.textContent=error"],
    ['coercion updates context',"range.selectNodeContents(fixture);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');fixture.append(svg);const fragment=range.createContextualFragment({toString(){range.selectNodeContents(svg);return '<circle></circle>'}});range.insertNode(fragment)"],
    ['custom element timing',"const reactions=[];customElements.define('x-range-fragment',class extends HTMLElement{constructor(){super();reactions.push(['constructor',this.isConnected,this.childNodes.length])}connectedCallback(){reactions.push(['connected',this.isConnected,this.childNodes.length])}});range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<x-range-fragment><b>Child</b></x-range-fragment>');reactions.push('returned');fixture.append(fragment);fixture.append(JSON.stringify(reactions))"],
    ['active inline script',"globalThis.rangeScript=[];range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<script>rangeScript.push(location.href)<\\/script>');range.insertNode(fragment);fixture.append(JSON.stringify(rangeScript))"],
    ['clone before insertion',"globalThis.rangeScript=[];range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<script>rangeScript.push(1)<\\/script>'),copy=fragment.cloneNode(true);fixture.append(fragment,copy);fixture.append(JSON.stringify(rangeScript))"],
    ['clone after insertion',"globalThis.rangeScript=[];range.selectNodeContents(fixture);fixture.append(range.createContextualFragment('<script>rangeScript.push(1)<\\/script>'));fixture.append(fixture.firstChild.cloneNode(true));fixture.append(JSON.stringify(rangeScript))"],
    ['cloned media reflection',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<img src=\"https://range-fragments.test/clone.svg\">'),copy=fragment.cloneNode(true);fixture.textContent=JSON.stringify({attribute:copy.firstChild.getAttribute('src'),src:copy.firstChild.src})"],
    ['cloned media subtrees',"range.selectNodeContents(fixture);const fragment=range.createContextualFragment('<picture><source srcset=\"https://range-fragments.test/wide.svg 2x\"><img src=\"https://range-fragments.test/fallback.svg\"></picture><video poster=\"https://range-fragments.test/poster.svg\"></video>'),copy=fragment.cloneNode(true);fixture.textContent=JSON.stringify({srcset:copy.querySelector('source').getAttribute('srcset'),src:copy.querySelector('img').src,poster:copy.querySelector('video').poster,empty:fragment.firstChild.cloneNode(false).childNodes.length})"],
    ['surround script element',"globalThis.rangeScript=[];fixture.textContent='rangeScript.push(location.href)';range.selectNodeContents(fixture);range.surroundContents(document.createElement('script'));fixture.append(JSON.stringify(rangeScript))"],
    ['surround contents script',"globalThis.rangeScript=[];fixture.textContent='Text';range.selectNodeContents(fixture);const wrapper=document.createElement('span');wrapper.append(range.createContextualFragment('<script>rangeScript.push(1)<\\/script>'));range.surroundContents(wrapper);fixture.append(JSON.stringify(rangeScript))"]
  ];
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,source)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
    return JSON.parse(await evaluate(proxy,`JSON.stringify((()=>{const fixture=document.getElementById('fixture'),range=document.createRange();${source};
      const tree=node=>node.nodeType===1?{name:node.localName,namespace:node.namespaceURI,children:Array.from(node.childNodes,tree)}:{type:node.nodeType,text:node.textContent};
      return tree(fixture);})())`));
  };
  const direct=[],pattern=/^https?:/,block=route=>{direct.push(route.request().url());return route.abort();};
  await page.route(pattern,block);
  try{
    await page.evaluate(({origin,html})=>{
      const previous=sandstone.network.session.fetch;globalThis.rangeRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;if(path!=='/start'&&path!=='/favicon.ico')rangeRequests.push(path);
        const image=path.endsWith('.svg'),script=path.endsWith('.js'),css=path.endsWith('.css');
        const body=image?'<svg xmlns="http://www.w3.org/2000/svg" width="'+(path==='/changed.svg'?5:3)+'" height="2"/>':
          script?'globalThis.rangeExternal=location.href;':css?'.range-painted{color:rgb(11,22,33)}':html;
        return Promise.resolve(new Response(body,{headers:{'Content-Type':image?'image/svg+xml':script?'text/javascript':css?'text/css':'text/html'}}));
      };
    },{origin,html});
    const differences=[];
    for(const [name,source] of cases){const expected=await run(false,source),actual=await run(true,source);if(JSON.stringify(actual)!==JSON.stringify(expected))differences.push({name,expected,actual});}
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    await evaluate(true,`(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('fixture'));globalThis.detachedRange=range.createContextualFragment('<img src="${origin}/detached.svg">');return true;})()`);
    await new Promise(resolve=>setTimeout(resolve,80));
    if(direct.length)differences.push({directBeforeInsertion:[...direct]});
    await evaluate(true,"document.getElementById('fixture').append(detachedRange);true");
    const deadline=Date.now()+3000;
    while(!await evaluate(true,"document.querySelector('img').naturalWidth===3")){if(Date.now()>deadline)throw new Error('Range image did not load through relay: '+JSON.stringify({direct,differences}));await new Promise(resolve=>setTimeout(resolve,20));}
    await evaluate(true,"globalThis.rangeOriginal=document.querySelector('img');globalThis.rangeCopy=rangeOriginal.cloneNode(true);rangeCopy.id='copy';document.getElementById('fixture').append(rangeCopy);rangeOriginal.src='/changed.svg';true");
    const cloneDeadline=Date.now()+3000;
    while(!await evaluate(true,"rangeOriginal.naturalWidth===5&&rangeCopy.naturalWidth===3")){if(Date.now()>cloneDeadline)throw new Error('Cloned Range media did not retain its independent source');await new Promise(resolve=>setTimeout(resolve,20));}
    if(await evaluate(true,'rangeCopy.src')!==origin+'/detached.svg')throw new Error('Cloned media exposed a temporary blob URL');
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    await evaluate(true,`(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('fixture'));
      globalThis.rangeResources=range.createContextualFragment('<script src="${origin}/external.js"><\\/script><link rel="stylesheet" href="${origin}/style.css"><style>.range-painted{background-image:url("${origin}/background.svg")}</style><b class="range-painted">Paint</b>');
      globalThis.resourceRange=range;return true;})()`);
    if(await page.evaluate(()=>rangeRequests.includes('/external.js')))throw new Error('Detached Range script was fetched before insertion');
    await evaluate(true,'resourceRange.insertNode(rangeResources);true');
    const resourceDeadline=Date.now()+5000;
    while(!await evaluate(true,`globalThis.rangeExternal===${JSON.stringify(origin+'/start')}&&getComputedStyle(document.querySelector('.range-painted')).color==='rgb(11, 22, 33)'&&getComputedStyle(document.querySelector('.range-painted')).backgroundImage.includes('blob:')`)){
      if(Date.now()>resourceDeadline)throw new Error('Range scripts or CSS did not load through the relay: '+JSON.stringify({direct,requests:await page.evaluate(()=>rangeRequests)}));await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(direct.length&&!differences.some(value=>value.directBeforeInsertion))differences.push({directHTTP:direct});
    if(differences.length)throw new Error('Range fragment parity: '+JSON.stringify(differences));
    return ['Range fragments preserve native contexts, owners and conversion rules','Range insertion preserves script execution, cloning and custom-element timing','Detached Range fragment resources stay behind the relay'];
  }finally{await native.close();await page.unroute(pattern,block);}
}
