async page=>{
  const origin='https://document-transfer.test',svg='http://www.w3.org/2000/svg';
  const html='<!doctype html><body><main id="fixture"></main><template id="declarative"><script>globalThis.transferScripts.push(location.href)</script></template>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:new URL(route.request().url()).pathname.endsWith('.svg')?'image/svg+xml':'text/html',body:new URL(route.request().url()).pathname.endsWith('.svg')?'<svg xmlns="'+svg+'" width="3" height="2"/>':html}));
  const cases=[
    ['import ownership',"const doc=document.implementation.createHTMLDocument(''),source=doc.createElement('div');source.innerHTML='<b>Child</b>';doc.body.append(source);const copy=document.importNode(source,true);result={same:source===copy,owner:copy.ownerDocument===fixture.ownerDocument,sourceOwner:source.ownerDocument===doc,sourceParent:source.parentNode===doc.body,text:copy.textContent};"],
    ['shallow import',"const doc=document.implementation.createHTMLDocument(''),source=doc.createElement('div');source.innerHTML='<b>Child</b>';const copy=document.importNode(source);result={children:copy.childNodes.length,tag:copy.localName};"],
    ['adopt identity',"const doc=document.implementation.createHTMLDocument(''),source=doc.createElement('div');source.innerHTML='<b>Child</b>';doc.body.append(source);source.addEventListener('ping',()=>count++);const copy=document.adoptNode(source);copy.dispatchEvent(new Event('ping'));result={same:source===copy,owner:copy.ownerDocument===fixture.ownerDocument,parent:copy.parentNode===null,childOwner:copy.firstChild.ownerDocument===fixture.ownerDocument,count};"],
    ['native script import',"const doc=new DOMParser().parseFromString('<script>globalThis.transferScripts.push(location.href)<\\/script>','text/html'),copy=document.importNode(doc.querySelector('script'),true);fixture.append(copy);result={scripts:transferScripts};"],
    ['native script adoption',"const doc=new DOMParser().parseFromString('<script>globalThis.transferScripts.push(location.href)<\\/script>','text/html');fixture.append(document.adoptNode(doc.querySelector('script')));result={scripts:transferScripts};"],
    ['template scripts',"const template=document.createElement('template');template.innerHTML='<script>globalThis.transferScripts.push(location.href)<\\/script>';fixture.append(document.importNode(template.content,true));result={scripts:transferScripts};"],
    ['declarative template scripts',"fixture.append(document.importNode(document.getElementById('declarative').content,true));result={scripts:transferScripts};"],
    ['empty parsed script filled after import',"const doc=new DOMParser().parseFromString('<script><\\/script>','text/html'),copy=document.importNode(doc.querySelector('script'),true);copy.textContent='globalThis.transferScripts.push(location.href)';fixture.append(copy);result={scripts:transferScripts};"],
    ['data parsed script changed after import',"const doc=new DOMParser().parseFromString('<script type=application/json>globalThis.transferScripts.push(location.href)<\\/script>','text/html'),copy=document.importNode(doc.querySelector('script'),true);copy.type='text/javascript';fixture.append(copy);result={scripts:transferScripts};"],
    ['empty inactive script filled after import',"const doc=document.implementation.createHTMLDocument(''),script=doc.createElement('script');doc.body.append(script);const copy=document.importNode(script,true);copy.textContent='globalThis.transferScripts.push(location.href)';fixture.append(copy);result={scripts:transferScripts};"],
    ['data inactive script changed after import',"const doc=document.implementation.createHTMLDocument(''),script=doc.createElement('script');script.type='application/json';script.textContent='globalThis.transferScripts.push(location.href)';doc.body.append(script);const copy=document.importNode(script,true);copy.type='text/javascript';fixture.append(copy);result={scripts:transferScripts};"],
    ['fragment scripts',"const fragment=document.createDocumentFragment(),script=document.createElement('script');script.textContent='globalThis.transferScripts.push(location.href)';fragment.append(script);fixture.append(document.importNode(fragment,true));result={scripts:transferScripts};"],
    ['inactive document scripts',"const doc=document.implementation.createHTMLDocument(''),script=doc.createElement('script');script.textContent='globalThis.transferScripts.push(location.href)';doc.body.append(script);result={scripts:transferScripts};"],
    ['inactive insertion followed by import',"const doc=document.implementation.createHTMLDocument(''),script=doc.createElement('script');script.textContent='globalThis.transferScripts.push(location.href)';doc.body.append(script);fixture.append(document.importNode(script,true));result={scripts:transferScripts};"],
    ['custom-element import timing',"const reactions=[];customElements.define('x-transfer-import',class extends HTMLElement{constructor(){super();reactions.push(['constructor',this.ownerDocument===fixture.ownerDocument,this.isConnected,this.childNodes.length])}connectedCallback(){reactions.push(['connected',this.isConnected,this.childNodes.length])}});const doc=document.implementation.createHTMLDocument('');doc.body.innerHTML='<x-transfer-import><b>Child</b></x-transfer-import>';const copy=document.importNode(doc.body.firstChild,true);reactions.push('returned');fixture.append(copy);result=reactions;"],
    ['custom-element adoption timing',"const reactions=[];customElements.define('x-transfer-adopt',class extends HTMLElement{constructor(){super();reactions.push(['constructor',this.ownerDocument===fixture.ownerDocument,this.isConnected,this.childNodes.length])}connectedCallback(){reactions.push(['connected',this.isConnected,this.childNodes.length])}adoptedCallback(){reactions.push('adopted')}});const doc=document.implementation.createHTMLDocument('');doc.body.innerHTML='<x-transfer-adopt><b>Child</b></x-transfer-adopt>';const copy=document.adoptNode(doc.body.firstChild);reactions.push('returned');fixture.append(copy);result=reactions;"],
    ['prepared media import',"const image=document.createElement('img');image.src='https://document-transfer.test/prepared.svg';const copy=document.importNode(image);result={src:copy.src,attribute:copy.getAttribute('src'),owner:copy.ownerDocument===fixture.ownerDocument};"],
    ['prepared SVG import',"const image=document.createElementNS('http://www.w3.org/2000/svg','image');image.href.baseVal='https://document-transfer.test/prepared-svg.svg';const copy=document.importNode(image);result={href:copy.href.baseVal,attribute:copy.getAttribute('href')};"],
    ['inactive media import',"const doc=document.implementation.createHTMLDocument(''),image=document.createElement('img');image.src='relative.svg';const copy=doc.importNode(image);result={src:copy.src,attribute:copy.getAttribute('src'),owner:copy.ownerDocument===doc};"],
    ['inactive media adoption',"const doc=document.implementation.createHTMLDocument(''),image=document.createElement('img');image.src='relative.svg';const copy=doc.adoptNode(image);result={src:copy.src,attribute:copy.getAttribute('src'),owner:copy.ownerDocument===doc};"],
    ['XML namespace preservation',"const doc=new DOMParser().parseFromString('<root xmlns:p=\"urn:transfer\"><p:child/></root>','application/xml'),copy=document.importNode(doc.documentElement,true);result={namespace:copy.firstChild.namespaceURI,prefix:copy.firstChild.prefix,owner:copy.ownerDocument===fixture.ownerDocument};"],
    ['import option conversion',"const reads=[],doc=document.implementation.createHTMLDocument(''),source=doc.createElement('div');source.append(doc.createElement('b'));const copy=document.importNode(source,{get deep(){reads.push('deep');return true},get selfOnly(){reads.push('selfOnly');return false}});result={reads,children:copy.childNodes.length};"],
    ['invalid transfer inputs',"const errors=[];for(const operation of [()=>document.importNode(),()=>document.adoptNode(),()=>document.importNode({}),()=>document.adoptNode({}),()=>document.importNode(fixture.ownerDocument),()=>document.adoptNode(fixture.ownerDocument),()=>Document.prototype.importNode.call({},fixture),()=>Document.prototype.adoptNode.call({},fixture)])try{operation();errors.push(null)}catch(error){errors.push(error.name)}result=errors;"],
    ['shadow root rejection',"const root=document.createElement('div').attachShadow({mode:'open'}),errors=[];for(const operation of [()=>document.importNode(root,true),()=>document.adoptNode(root)])try{operation();errors.push(null)}catch(error){errors.push(error.name)}result=errors;"]
  ];
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,source)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
    return JSON.parse(await evaluate(proxy,`JSON.stringify((()=>{const fixture=document.getElementById('fixture');globalThis.transferScripts=[];let result,count=0;${source};return result;})())`));
  };
  const direct=[],pattern=/^https?:/,block=route=>{direct.push(route.request().url());return route.abort();};
  await page.route(pattern,block);
  try{
    await page.evaluate(({origin,html,svg})=>{
      const previous=sandstone.network.session.fetch;globalThis.transferRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;transferRequests.push(path);
        return Promise.resolve(new Response(path.endsWith('.svg')?'<svg xmlns="'+svg+'" width="3" height="2"/>':html,{headers:{'Content-Type':path.endsWith('.svg')?'image/svg+xml':'text/html'}}));
      };
    },{origin,html,svg});
    const differences=[];
    for(const [name,source] of cases){const expected=await run(false,source),actual=await run(true,source);if(JSON.stringify(expected)!==JSON.stringify(actual))differences.push({name,expected,actual});}
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    await evaluate(true,`(()=>{const doc=new DOMParser().parseFromString('<img src="${origin}/raw-import.svg"><svg xmlns="${svg}"><image href="${origin}/raw-svg.svg"/></svg>','text/html');globalThis.importedMedia=document.importNode(doc.body,true);return true;})()`);
    await new Promise(resolve=>setTimeout(resolve,60));
    if(direct.length)differences.push({directHTTP:direct});
    if(differences.length)throw new Error('Document transfer parity: '+JSON.stringify(differences));
    return ['Document import/adoption preserves native ownership, callbacks and script state','Imported HTML/SVG media retain authored URLs without direct requests'];
  }finally{await native.close();await page.unroute(pattern,block);}
}
