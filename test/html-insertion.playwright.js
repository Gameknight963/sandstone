async page=>{
  const origin='https://html-insertion.test';
  const html='<!doctype html><body><main id="fixture"></main>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const cases=[
    ['SVG children',"const subject=document.createElementNS('http://www.w3.org/2000/svg','svg');fixture.append(subject);subject.innerHTML='<g><circle cx=4></circle><foreignObject><div>HTML</div></foreignObject></g>'"],
    ['MathML children',"const subject=document.createElementNS('http://www.w3.org/1998/Math/MathML','math');fixture.append(subject);subject.innerHTML='<mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>'"],
    ['table rows',"const subject=document.createElement('table');fixture.append(subject);subject.innerHTML='<tr><td>Cell</td></tr>'"],
    ['table body',"const subject=document.createElement('tbody');fixture.append(subject);subject.innerHTML='<tr><td>Cell</td></tr>'"],
    ['select options',"const subject=document.createElement('select');fixture.append(subject);subject.innerHTML='<div>Before</div><option>A</option><span>After</span>'"],
    ['form ancestor',"const form=document.createElement('form'),subject=document.createElement('div');fixture.append(form);form.append(subject);subject.innerHTML='<form id=nested><input name=field></form>'"],
    ['SVG adjacent HTML',"const subject=document.createElementNS('http://www.w3.org/2000/svg','svg');fixture.append(subject);subject.insertAdjacentHTML('beforeend','<g><circle></circle></g>')"],
    ['table adjacent HTML',"const subject=document.createElement('table');fixture.append(subject);subject.insertAdjacentHTML('afterbegin','<tr><td>Cell</td></tr>')"],
    ['SVG outer HTML',"const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),subject=document.createElementNS(svg.namespaceURI,'g');fixture.append(svg);svg.append(subject);subject.outerHTML='<circle cx=4></circle>'"],
    ['document fragment outer HTML',"const fragment=document.createDocumentFragment(),subject=document.createElement('div');fragment.append(subject);subject.outerHTML='<p>Replacement</p>';fixture.append(fragment)"],
    ['null inner HTML',"fixture.innerHTML=null"],
    ['null adjacent HTML',"fixture.insertAdjacentHTML('beforeend',null)"],
    ['inert inner scripts',"globalThis.htmlExecuted=0;fixture.innerHTML='<script>htmlExecuted++<\\/script>';fixture.append(fixture.firstChild);"],
    ['inert adjacent scripts',"globalThis.htmlExecuted=0;fixture.insertAdjacentHTML('beforeend','<script>htmlExecuted++<\\/script>')"],
    ['inert outer scripts',"globalThis.htmlExecuted=0;const subject=document.createElement('div');fixture.append(subject);subject.outerHTML='<script>htmlExecuted++<\\/script>'"],
    ['coercion order',"const reads=[];fixture.insertAdjacentHTML({toString(){reads.push('position');return 'beforeend'}},{toString(){reads.push('markup');return '<p>'+reads.join(',')+'</p>'}})"],
    ['invalid position coercion',"const reads=[];let error;try{fixture.insertAdjacentHTML({toString(){reads.push('position');return 'invalid'}},{toString(){reads.push('markup');return ''}})}catch(value){error=value.name}fixture.textContent=JSON.stringify({reads,error})"],
    ['invalid position skips parsing',"try{fixture.insertAdjacentHTML('invalid','<img src=https://html-insertion.test/invalid>')}catch(error){fixture.textContent=error.name}"],
    ['inner receiver validation',"let calls=0,error;try{Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML').set.call({}, {toString(){calls++;return ''}})}catch(value){error=value.name}fixture.textContent=JSON.stringify({calls,error})"],
    ['adjacent receiver validation',"let calls=0,error;try{Element.prototype.insertAdjacentHTML.call({},'beforeend',{toString(){calls++;return ''}})}catch(value){error=value.name}fixture.textContent=JSON.stringify({calls,error})"],
    ['XML namespace inheritance',"const xml=new DOMParser().parseFromString('<root xmlns:p=\"urn:insertion\"><child/></root>','application/xml');xml.documentElement.firstChild.innerHTML='<p:leaf/>';fixture.append(xml.documentElement)"],
    ['XML invalid markup',"const xml=new DOMParser().parseFromString('<root><child/></root>','application/xml');let error;try{xml.documentElement.innerHTML='<broken>'}catch(value){error=value.name}fixture.textContent=error"],
    ['outer coercion before mutation',"const old=document.createElement('section'),next=document.createElement('select'),subject=document.createElement('div');fixture.append(old,next);old.append(subject);subject.outerHTML={toString(){next.append(subject);return '<option>Moved</option><div>Text</div>'}}"],
    ['adjacent coercion before mutation',"const old=document.createElement('section'),next=document.createElementNS('http://www.w3.org/2000/svg','svg'),subject=document.createElement('div');fixture.append(old,next);old.append(subject);subject.insertAdjacentHTML('beforebegin',{toString(){next.append(subject);return '<circle></circle>'}})"],
    ['detached outer HTML',"const subject=document.createElement('div');let calls=0;subject.outerHTML={toString(){calls++;return '<p>Ignored</p>'}};fixture.textContent=calls"],
    ['detached adjacent HTML',"const subject=document.createElement('div');let error;try{subject.insertAdjacentHTML('beforebegin','<p>Ignored</p>')}catch(value){error=value.name}fixture.textContent=error"],
    ['document outer HTML',"let error;try{document.documentElement.outerHTML='<html></html>'}catch(value){error=value.name}fixture.textContent=error"],
    ['custom element reactions',"const reactions=[];customElements.define('x-insertion',class extends HTMLElement{constructor(){super();reactions.push(['constructor',this.isConnected,this.childNodes.length])}connectedCallback(){reactions.push(['connected',this.isConnected,this.childNodes.length])}});fixture.innerHTML='<x-insertion><b>Inside</b></x-insertion>';fixture.append(JSON.stringify(reactions))"],
    ['Symbol markup',"const errors=[];for(const operation of [()=>{fixture.innerHTML=Symbol()},()=>{fixture.outerHTML=Symbol()},()=>fixture.insertAdjacentHTML('beforeend',Symbol())])try{operation()}catch(error){errors.push(error.name)}fixture.textContent=JSON.stringify(errors)"],
    ['open shadow HTML',"const subject=document.createElement('div');fixture.append(subject);subject.attachShadow({mode:'open'}).innerHTML='<b>Shadow</b><svg><circle></circle></svg>'"],
    ['closed shadow HTML',"const subject=document.createElement('div');fixture.append(subject);const root=subject.attachShadow({mode:'closed'});root.innerHTML='<b>Shadow</b><svg><circle></circle></svg>';fixture.append(root.innerHTML)"],
    ['shadow null HTML',"const subject=document.createElement('div');fixture.append(subject);const root=subject.attachShadow({mode:'open'});root.innerHTML='<b>Before</b>';root.innerHTML=null"],
    ['shadow receiver validation',"let calls=0,error;try{Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'innerHTML').set.call({}, {toString(){calls++;return ''}})}catch(value){error=value.name}fixture.textContent=JSON.stringify({calls,error})"]
  ];
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,source)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
    return JSON.parse(await evaluate(proxy,`JSON.stringify((()=>{const fixture=document.getElementById('fixture');${source};
      const tree=node=>node.nodeType===1?{name:node.localName,namespace:node.namespaceURI,children:Array.from(node.childNodes,tree),shadow:node.shadowRoot?Array.from(node.shadowRoot.childNodes,tree):undefined}:{type:node.nodeType,text:node.textContent};
      return {tree:tree(fixture),executed:globalThis.htmlExecuted||0};})())`));
  };
  const direct=[],routePattern=/^https?:/,block=route=>{direct.push(route.request().url());return route.abort();};
  await page.route(routePattern,block);
  try{
    await page.evaluate(({origin,html})=>{
      const previous=sandstone.network.session.fetch;globalThis.htmlInsertionRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;if(path!=='/start'&&path!=='/favicon.ico')htmlInsertionRequests.push(path);
        const image=path.endsWith('.svg'),css=path.endsWith('.css');
        return Promise.resolve(new Response(image?'<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"/>':css?'.paint{color:rgb(1,2,3)}':html,
          {headers:{'Content-Type':image?'image/svg+xml':css?'text/css':'text/html'}}));
      };
    },{origin,html});
    const differences=[];
    for(const [name,source] of cases){
      const expected=await run(false,source),actual=await run(true,source);
      if(JSON.stringify(actual)!==JSON.stringify(expected))differences.push({name,expected,actual});
    }
    const operations=[
      'subject.innerHTML=markup',
      "subject.insertAdjacentHTML('beforeend',markup)",
      "subject.insertAdjacentHTML('afterbegin',markup)",
      "subject.insertAdjacentHTML('beforebegin',markup)",
      "subject.insertAdjacentHTML('afterend',markup)",
      'subject.outerHTML=markup',
      "subject.attachShadow({mode:'open'}).innerHTML=markup"
    ];
    for(const [index,operation] of operations.entries()){
      await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
      const markup=`<img id="picture" src="/image-${index}.svg" onload="globalThis.insertionLoads=(globalThis.insertionLoads||0)+1">
        <link rel="stylesheet" href="/style-${index}.css"><style>.paint{background-image:url('/background-${index}.svg')}</style>
        <span class="paint">Resources</span><script>globalThis.accidentalHTMLScript=1<\/script>
        <script src="/inert-${index}.js"><\/script>`;
      await evaluate(true,`(()=>{const subject=document.createElement('div');document.getElementById('fixture').append(subject);const markup=${JSON.stringify(markup)};${operation};globalThis.insertionRoot=subject.shadowRoot||document;return true;})()`);
      const deadline=Date.now()+5000;
      while(!await evaluate(true,"!!globalThis.insertionLoads&&insertionRoot.getElementById('picture').naturalWidth===3&&getComputedStyle(insertionRoot.querySelector('.paint')).color==='rgb(1, 2, 3)'&&getComputedStyle(insertionRoot.querySelector('.paint')).backgroundImage.includes('blob:')")){
        if(Date.now()>deadline)throw new Error('HTML resources did not load through the relay: '+operation+' '+JSON.stringify({direct,requests:await page.evaluate(()=>htmlInsertionRequests)}));
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(await evaluate(true,'!!globalThis.accidentalHTMLScript'))throw new Error('An inert HTML insertion script executed: '+operation);
    }
    const requests=await page.evaluate(()=>htmlInsertionRequests);
    if(requests.some(path=>path==='/invalid'||path.startsWith('/inert-')))differences.push({unexpectedRequests:requests});
    if(direct.length)differences.push({directHTTP:direct});
    if(differences.length)throw new Error('HTML insertion parity: '+JSON.stringify(differences));
    return ['HTML insertion preserves SVG/MathML/table/select/form parser contexts','HTML insertion retains inert scripts, native coercion and receiver validation','innerHTML, outerHTML and every adjacent position relay images and CSS before activation'];
  }finally{await native.close();await page.unroute(routePattern,block);}
}
