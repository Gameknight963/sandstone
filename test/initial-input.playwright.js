async page=>{
  const origin='https://initial-input.test',nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),direct=[];
  const script=source=>'<script>'+source.replace(/<\/script/gi,'<\\/script')+'</script>';
  const cases=[
    ['open-elements','<!doctype html><main>'+script(`globalThis.futureAtScript=!!document.getElementById('tail');document.write('<section id="written">');`)+
      '<b id="tail">Tail</b>'+script(`document.write('</section>');`)+ '<footer id="after">After</footer></main>',
      `({future:futureAtScript,parent:document.getElementById('tail').parentElement.id,after:document.getElementById('after').parentElement.localName})`],
    ['comment','<!doctype html><body>'+script(`document.write('<!--');`)+ '<p id="hidden">Hidden</p>'+script(`globalThis.unexpected=true;`)+ '--><p id="visible">Visible</p>',
      `({hidden:!!document.getElementById('hidden'),executed:!!globalThis.unexpected,visible:document.getElementById('visible').textContent})`],
    ['raw-text','<!doctype html><body>'+script(`document.write('<style id="written">');`)+ '#paint{color:rgb(12,34,56)}<p id="hidden">Hidden</p></style><p id="paint">Paint</p>',
      `({hidden:!!document.getElementById('hidden'),text:document.getElementById('written').textContent,color:getComputedStyle(document.getElementById('paint')).color})`],
    ['stylesheet-load','<!doctype html><head>'+script(`globalThis.colorAtLoad=null;addEventListener('load',()=>colorAtLoad=getComputedStyle(document.getElementById('paint')).color);`)+
      '<link rel="stylesheet" href="/load-style.css"></head><body><p id="paint">Paint</p>',`({color:colorAtLoad})`],
    ['table','<!doctype html><body>'+script(`document.write('<table id="written">');`)+ '<tr><td id="cell">Cell</td></tr>'+script(`document.write('</table>');`)+ '<p id="after">After</p>',
      `({cell:document.getElementById('cell').closest('table').id,after:document.getElementById('after').parentElement.localName})`],
    ['external','<!doctype html><body>'+script(`globalThis.externalFuture=null;document.write('<section id="written"><script src="/writer.js"></script>');`)+ '<b id="tail">Tail</b>'+script(`document.write('</section>');`),
      `({future:externalFuture,parent:document.getElementById('tail').parentElement.id,external:document.getElementById('external').parentElement.id})`],
    ['shadow','<!doctype html><body><div id="host"><template shadowrootmode="open">'+script(`document.write('<b id="written">');`)+ '<i id="tail">Shadow</i>'+script(`document.write('</b>');`)+ '</template></div>',
      `({parent:document.getElementById('host').shadowRoot.getElementById('tail').parentElement.id,light:document.getElementById('host').children.length})`],
    ['shadow-identity','<!doctype html><body>'+script(`customElements.define('x-stream',class extends HTMLElement {constructor(){super();this.internals=this.attachInternals();this.firstRoot=this.internals.shadowRoot?.mode||null;}});`)+
      '<x-stream id="host">'+script(`globalThis.originalHost=document.currentScript.parentElement;globalThis.rootBefore=originalHost.internals.shadowRoot?.mode||null;`)+
      '<template shadowrootmode="closed" shadowrootclonable shadowrootserializable><b>Shadow</b></template></x-stream>'+script(`globalThis.copiedHost=document.getElementById('host').cloneNode(true);`),
      `({same:originalHost===document.getElementById('host'),before:rootBefore,construction:originalHost.firstRoot,after:originalHost.internals.shadowRoot?.mode,copyConstruction:copiedHost.firstRoot,copy:copiedHost.internals.shadowRoot?.mode})`],
    ['long-page','<!doctype html><main>'+script(`document.write('<div id="written">');`)+ '<span>Before</span>'.repeat(1000)+
      script(`globalThis.held=document.getElementById('written').firstElementChild;held.setAttribute('data-kept','yes');held.firstChild.data='Edited';`)+
      '<span>After</span>'.repeat(1000)+script(`document.write('</div>');`)+ '<p id="tail">Tail</p></main>',
      `({same:held===document.getElementById('written').firstElementChild,text:held.textContent,attribute:held.getAttribute('data-kept'),count:document.querySelectorAll('#written>span').length,tail:document.getElementById('tail').parentElement.localName})`]
  ];
  const pages=Object.fromEntries(cases.map(([name,html])=>[origin+'/'+name,html]));
  pages[origin+'/load-style.css']='#paint{color:rgb(12,34,56)}';
  const external=`globalThis.externalFuture=!!document.getElementById('tail');document.write('<i id="external">External</i>');`;
  const response=url=>url===origin+'/writer.js'?{body:external,contentType:'text/javascript'}:{body:pages[url]||'',contentType:url.endsWith('.css')?'text/css':'text/html'};
  const block=route=>{direct.push(route.request().url());return route.abort();};
  try{
    await native.route(origin+'/**',route=>route.fulfill(response(route.request().url())));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,pages,external})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        return Promise.resolve(new Response(url===origin+'/writer.js'?external:pages[url]||'',{headers:{'Content-Type':url===origin+'/writer.js'?'text/javascript':url.endsWith('.css')?'text/css':'text/html'}}));
      };
    },{origin,pages,external});
    for(const [name,,expression] of cases){
      await native.goto(origin+'/'+name);await page.evaluate(url=>main_frame.navigate_to(url),origin+'/'+name);
      const source='JSON.stringify('+expression+')',expected=await native.evaluate(source=>eval(source),source),actual=await page.evaluate(source=>main_frame.eval_js(source),source);
      if(actual!==expected)throw new Error('Original HTML continuation differs for '+name+': '+actual+' expected '+expected);
    }
    if(direct.length)throw new Error('Original HTML continuation attempted direct HTTP: '+JSON.stringify(direct));
    return ['Written open elements and tables continue into original source','Written comments and raw text control subsequent original tokens','Parser scripts see only preceding markup and external writes retain their insertion point','Document writes continue inside declarative shadow roots'];
  }finally{await nativeContext.close();await page.unroute(/^https?:/,block);}
}
