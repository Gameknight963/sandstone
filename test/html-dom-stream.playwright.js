async page=>{
  const origin='https://html-dom-stream.test',native=await page.context().newPage(),direct=[];
  const html='<!doctype html><main id="fixture"><i id="existing">Existing</i><b id="anchor">Anchor</b></main>';
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;globalThis.htmlDOMRequests=[];sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const path=new URL(url).pathname;htmlDOMRequests.push(path);const image=path.endsWith('.svg'),css=path.endsWith('.css');
      return Promise.resolve(new Response(image?'<svg xmlns="http://www.w3.org/2000/svg" width="19" height="7"/>':css?'.paint{color:rgb(12,34,56)}':html,{headers:{'Content-Type':image?'image/svg+xml':css?'text/css':'text/html'}}));
    };},{origin,html});
    await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    await evaluate(true,`globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'),{before:document.getElementById('anchor')});stream.write('<p id="written" data-value="a&gt;b">one &am');true`);
    let snapshot=JSON.parse(await evaluate(true,`JSON.stringify({text:document.getElementById('written').textContent,attr:document.getElementById('written').getAttribute('data-value'),order:Array.from(document.getElementById('fixture').children,node=>node.id)})`));
    if(snapshot.text!=='one '||snapshot.attr!=='a>b'||snapshot.order.join(',')!=='existing,written,anchor')throw new Error('Partial DOM stream is incorrect: '+JSON.stringify(snapshot));
    await evaluate(true,`globalThis.savedWritten=document.getElementById('written');savedWritten.firstChild.data='Author ';savedWritten.setAttribute('data-author','retained');savedWritten.addEventListener('probe',()=>savedWritten.dataset.event='yes');stream.write('p; two<b>bold</b></p>');stream.close();true`);
    snapshot=JSON.parse(await evaluate(true,`document.getElementById('written').dispatchEvent(new Event('probe'));JSON.stringify({same:savedWritten===document.getElementById('written'),text:savedWritten.textContent,author:savedWritten.dataset.author,event:savedWritten.dataset.event})`));
    if(!snapshot.same||snapshot.text!=='Author & twobold'||snapshot.author!=='retained'||snapshot.event!=='yes')throw new Error('DOM stream replaced or reset authored nodes: '+JSON.stringify(snapshot));
    const cases=[
      '<b><i>one</b>two</i><table>foster<tr><td>cell</table>',
      '<textarea>a<b>&amp;</textarea><svg><foreignObject><p>HTML</p></foreignObject></svg>',
      '<foo:bar a:b="value" @click="callback" [value]="binding"><foo<bar>Odd names</foo<bar></foo:bar>',
      '<template shadowrootmode="open" shadowrootserializable><b>Context declaration stays a template</b></template>',
      '<div><template shadowrootmode="open" shadowrootclonable shadowrootserializable><b>Shadow</b></template><i>Light</i></div>',
      '<div><template shadowrootmode="closed" shadowrootclonable shadowrootserializable><b>Closed</b></template><i>Light</i></div>',
      '<template><div><template shadowrootmode="open"><b>Nested</b></template></div><script>throw new Error("inert")</script></template>'
    ];
    for(const source of cases){
      const expected=await native.evaluate(source=>{const container=document.createElement('div');container.setHTMLUnsafe(source);return container.getHTML({serializableShadowRoots:true});},source);
      await evaluate(true,`document.getElementById('fixture').replaceChildren();globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'));true`);
      for(let offset=0;offset<source.length;offset+=7)await page.evaluate(chunk=>main_frame.eval_js('stream.write('+JSON.stringify(chunk)+');true'),source.slice(offset,offset+7));
      const actual=await evaluate(true,`stream.close();document.getElementById('fixture').getHTML({serializableShadowRoots:true})`);
      if(actual!==expected)throw new Error('Streamed DOM differs: '+actual+' expected '+expected);
      if(await evaluate(true,`document.getElementById('fixture').shadowRoot!==null`))throw new Error('A top-level fragment declaration attached to its parsing context');
    }
    const nested='<p id="inserted">Written</p><script>streamEvents.push("inner");</script>';
    const outer='const outer=document.currentScript;input.write('+JSON.stringify(nested).replace(/<\/script/gi,'<\\/script')+');streamEvents.push(document.currentScript===outer,!!document.getElementById("inserted"));';
    const markup='<script>'+outer+'</script><b>after</b>';
    await evaluate(true,`document.getElementById('fixture').replaceChildren();globalThis.streamEvents=[];globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'),{onScript(node,input){const previous=globalThis.input;globalThis.input=input;try{sandstone_frame.loader.eval_script(node,node.textContent);}finally{globalThis.input=previous;}}});stream.write(${JSON.stringify(markup)});stream.close();true`);
    const events=JSON.parse(await evaluate(true,'JSON.stringify(streamEvents)'));
    if(JSON.stringify(events)!==JSON.stringify(['inner',true,true]))throw new Error('Nested streamed scripts lost insertion order or currentScript: '+JSON.stringify(events));
    await evaluate(true,`document.getElementById('fixture').replaceChildren();globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'));stream.write('<script id="external" src="external.js"></script>');stream.close();true`);
    if(await evaluate(true,`document.getElementById('external').src`)!==origin+'/external.js')throw new Error('A streamed script lost its virtual source URL');
    await evaluate(true,`document.getElementById('fixture').replaceChildren();globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'));stream.write('<div id="shadow"><template shadowrootmode="closed" shadowrootserializable><style>.paint{color:rgb(12,34,56)}</style><img src="/image.svg"><span class="paint">Paint</span></template></div><link rel="stylesheet" href="/style.css"><span class="paint" id="outside">Outside</span>');stream.close();true`);
    const deadline=Date.now()+5000;
    while(!JSON.parse(await evaluate(true,`JSON.stringify(getComputedStyle(document.getElementById('outside')).color==='rgb(12, 34, 56)')`))){if(Date.now()>deadline)throw new Error('Streamed stylesheet failed');await new Promise(resolve=>setTimeout(resolve,20));}
    const requests=await page.evaluate(()=>htmlDOMRequests);
    for(const path of ['/image.svg','/style.css'])if(!requests.includes(path))throw new Error('Missing relayed streamed resource: '+path);
    await evaluate(true,`document.getElementById('fixture').replaceChildren();globalThis.stream=new sandstone_frame.html_stream.HTMLDOMStream(document.getElementById('fixture'));stream.write('<style>.continuation{background-image:url("/ima');stream.write('ge.svg");color:rgb(45,67,89)}');stream.write('</style><span id="continuation" class="continuation">Continuation</span>');stream.close();true`);
    const styleDeadline=Date.now()+5000;
    while(!await evaluate(true,`getComputedStyle(document.getElementById('continuation')).color==='rgb(45, 67, 89)'`)){if(Date.now()>styleDeadline)throw new Error('Continued style text was lost');await new Promise(resolve=>setTimeout(resolve,20));}
    if(direct.length)throw new Error('Streamed HTML attempted direct HTTP: '+JSON.stringify(direct));
    return ['Incremental HTML DOM output preserves partial tokens, node identity and authored edits','Streamed formatting, tables, namespaces and declarative roots match native parsing','Nested streamed script callbacks retain insertion order and currentScript','Streamed HTML resources are prepared before adoption and stay on the relay'];
  }finally{await native.close();await page.unroute(/^https?:/,block);}
}
