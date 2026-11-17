async page=>{
  const origin='https://html-position.test',html='<!doctype html><main id="fixture"></main>',native=await page.context().newPage();
  const direct=[],block=route=>{direct.push(route.request().url());return route.abort();};
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    await native.goto(origin+'/start');
    const methods=await native.evaluate(()=>['append','prepend','before','after','replaceWith'].flatMap(position=>['','Unsafe'].map(suffix=>position+'HTML'+suffix)).filter(key=>typeof Element.prototype[key]==='function'));
    if(!methods.length)return ['Positional HTML methods unavailable in this browser'];
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;globalThis.htmlPositionRequests=[];sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const path=new URL(url).pathname;htmlPositionRequests.push(path);
      const image=path.endsWith('.svg'),css=path.endsWith('.css'),js=path.endsWith('.js');
      return Promise.resolve(new Response(image?'<svg xmlns="http://www.w3.org/2000/svg" width="9" height="4"/>':css?'.paint{color:rgb(23,45,67)}':js?'globalThis.posExternal=(globalThis.posExternal||0)+1':html,{headers:{'Content-Type':image?'image/svg+xml':css?'text/css':js?'text/javascript':'text/html'}}));
    };},{origin,html});
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    const cases=[];
    for(const method of methods){
      const child=/^(before|after|replaceWith)/.test(method);
      const setups=[
        ['HTML',`const parent=document.createElement('section');parent.innerHTML='<i>Before</i><div id="subject">Original</div><b>After</b>';fixture.append(parent);const subject=parent.children[1];`,'<p>Inserted</p>'],
        ['table',`const parent=document.createElement('tbody');parent.innerHTML='<tr><td>Original</td></tr>';fixture.append(parent);const subject=${child?'parent.firstElementChild':'parent'};`,'<tr><td>Inserted</td></tr>'],
        ['SVG',`const parent=document.createElementNS('http://www.w3.org/2000/svg','svg');parent.innerHTML='<g id="subject"><circle/></g>';fixture.append(parent);const subject=${child?'parent.firstElementChild':'parent'};`,'<g><rect/></g>'],
        ['MathML',`const parent=document.createElementNS('http://www.w3.org/1998/Math/MathML','math');parent.innerHTML='<mi>x</mi>';fixture.append(parent);const subject=${child?'parent.firstElementChild':'parent'};`,'<mrow><mi>y</mi></mrow>'],
        ['template contents',`const parent=document.createElement('template');parent.innerHTML='<div>Original</div>';fixture.append(parent);const subject=${child?'parent.content.firstElementChild':'parent'};`,'<tr><td>Inserted</td></tr>'],
        ['shadow context',`const host=document.createElement('div');fixture.append(host);const parent=host.attachShadow({mode:'closed',serializable:true});parent.innerHTML='<span>Original</span>';const subject=${child?'parent.firstElementChild':'parent'};`,'<b>Inserted</b>'],
        ['declarative roots',`const parent=document.createElement('section');parent.innerHTML='<div>Original</div>';fixture.append(parent);const subject=parent.firstElementChild;`,'<div><template shadowrootmode="closed" shadowrootserializable><b>Shadow</b></template><i>Light</i></div>'],
        ['detached',`const parent=document.createElement('section'),subject=document.createElement('div');subject.textContent='Original';`,'<b>Inserted</b>']
      ];
      if(child)for(const node of ['text','comment'])setups.push([node,`const parent=document.createElement('section');fixture.append(parent);const subject=document.${node==='text'?'createTextNode':'createComment'}('Original');parent.append(subject);`,'<b>Inserted</b>']);
      for(const [name,setup,markup] of setups)cases.push([method+' '+name,`${setup}subject.${method}(${JSON.stringify(markup)},{sanitizer:{}});return {fixture:fixture.getHTML({serializableShadowRoots:true}),subject:subject.nodeType===1?subject.getHTML({serializableShadowRoots:true}):subject.nodeType===11?subject.getHTML({serializableShadowRoots:true}):subject.data};`]);
      cases.push([method+' options and mutation',`const old=document.createElement('section'),next=document.createElement('select'),subject=document.createElement('div');fixture.append(old,next);old.append(subject);const events=[];subject.${method}({toString(){events.push('html');next.append(subject);return '<option>Moved</option><b>Text</b>'}},{get runScripts(){events.push('run');return false},get sanitizer(){events.push('sanitizer');return {get removeElements(){events.push('elements');return []}}}});return {events,html:fixture.innerHTML};`]);
      cases.push([method+' frozen options',`const subject=document.createElement('div');fixture.append(subject);subject.${method}('<b>Keep</b><i>Drop</i>',Object.freeze({runScripts:1,sanitizer:Object.freeze({removeElements:Object.freeze(['i'])})}));return fixture.innerHTML;`]);
      cases.push([method+' default sanitizer',`const subject=document.createElement('div');fixture.append(subject);subject.${method}('<b onclick="globalThis.bad=1">Text</b><script>globalThis.bad=1<\\/script>');return fixture.innerHTML;`]);
      cases.push([method+' identity and mutation records',`const subject=document.createElement('div'),kept=document.createElement('em');subject.append(kept);fixture.append(subject);const observer=new MutationObserver(()=>{});observer.observe(fixture,{subtree:true,childList:true,attributes:true,characterData:true});subject.${method}('Added');const records=observer.takeRecords().map(record=>({type:record.type,target:record.target===fixture?'fixture':record.target===subject?'subject':'other',added:record.addedNodes.length,removed:record.removedNodes.length}));observer.disconnect();return {same:subject.firstElementChild===kept,records,connected:subject.isConnected,html:fixture.innerHTML};`]);
      cases.push([method+' receiver validation',`let reads=0,error;try{Element.prototype.${method}.call({},{toString(){reads++;return ''}})}catch(e){error=e.name}return {reads,error};`]);
      cases.push([method+' hierarchy and option order',`const events=[];let error;const subject=${child?'document.documentElement':'document.documentElement'};try{subject.${method}({toString(){events.push('html');return '<p>Never</p>'}},{get sanitizer(){events.push('sanitizer');return {get removeElements(){events.push('elements');return []}}}})}catch(e){error=e.name}return {events,error};`]);
      if(child){
        cases.push([method+' coercion detaches the receiver',`const subject=document.createElement('div');fixture.append(subject);const reads=[];subject.${method}({toString(){reads.push('html');subject.remove();return '<img src="/never-detached.svg">'}},{get sanitizer(){reads.push('options');return {}}});return {reads,html:fixture.innerHTML};`]);
        cases.push([method+' CharacterData brand checks',`let reads=0,error;try{CharacterData.prototype.${method}.call(document.createElement('div'),{toString(){reads++;return ''}})}catch(e){error=e.name}return {reads,error};`]);
        cases.push([method+' unhosted fragment',`const fragment=document.createDocumentFragment(),subject=document.createElement('div');fragment.append(subject);let error;try{subject.${method}('<b>Never</b>')}catch(e){error=e.name}return {error,children:fragment.childNodes.length};`]);
        cases.push([method+' forbidden template parent',`const parent=document.createElement('template'),subject=document.createElement('div');parent.append(subject);let error;try{subject.${method}('<b>Never</b>')}catch(e){error=e.name}return {error,children:parent.childNodes.length};`]);
      }
      if(!child)cases.push([method+' native insertion bypasses authored append hooks',`const host=document.createElement('div');fixture.append(host);const root=host.attachShadow({mode:'open'}),old=DocumentFragment.prototype.${method.startsWith('append')?'append':'prepend'};let calls=0;DocumentFragment.prototype.${method.startsWith('append')?'append':'prepend'}=function(){calls++;throw new Error('authored override')};try{root.${method}('<b>Inserted</b>');return {calls,html:root.innerHTML}}finally{DocumentFragment.prototype.${method.startsWith('append')?'append':'prepend'}=old}`]);
      if(method.endsWith('Unsafe'))cases.push([method+' script execution after mutation',`globalThis.posExec=[];const subject=document.createElement('div');subject.id='subject';fixture.append(subject);subject.${method}('<script>posExec.push(document.getElementById("subject")?"present":"gone")<\\/script>',{runScripts:true});return posExec;`]);
    }
    if((await page.evaluate(()=>htmlPositionRequests)).includes('/never-detached.svg'))throw new Error('A detached positional no-op fetched its markup');
    const source=`(()=>{const fixture=document.getElementById('fixture');const cases=[${cases.map(([,code])=>'()=>{'+code+'}').join(',')}];return JSON.stringify(cases.map(test=>{fixture.replaceChildren();try{return test()}catch(error){return {error:error.name,message:error.message}}}));})()`;
    const expected=JSON.parse(await evaluate(false,source)),actual=JSON.parse(await evaluate(true,source));
    for(let index=0;index<cases.length;index++)if(JSON.stringify(expected[index])!==JSON.stringify(actual[index]))throw new Error(cases[index][0]+' differs: '+JSON.stringify(actual[index])+' expected '+JSON.stringify(expected[index]));
    for(const method of methods){
      await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
      const markup='<div id="inserted"><img src="/image-'+method+'.svg"><link rel="stylesheet" href="/style.css"><span class="paint">Paint</span><div id="host"><template shadowrootmode="closed"><img id="shadow-image" src="/shadow-'+method+'.svg"></template></div></div>';
      await evaluate(true,`(()=>{customElements.define('x-position-host',class extends HTMLElement{constructor(){super();this.internals=this.attachInternals()}});const subject=document.createElement('div');subject.id='subject';document.getElementById('fixture').append(subject);subject.${method}(${JSON.stringify(markup.replace('<div id="host">','<x-position-host id="host">').replace('</template></div>','</template></x-position-host>'))},{sanitizer:{}});return true;})()`);
      const deadline=Date.now()+5000;while(!await evaluate(true,`(()=>{const element=document.getElementById('inserted'),host=document.getElementById('host');return element?.querySelector('img').naturalWidth===9&&getComputedStyle(element.querySelector('.paint')).color==='rgb(23, 45, 67)'&&host?.internals.shadowRoot.getElementById('shadow-image').naturalWidth===9})()`)){if(Date.now()>deadline)throw new Error('Positional resources failed through relay: '+method+' '+JSON.stringify(direct));await new Promise(resolve=>setTimeout(resolve,20));}
    }
    if(direct.length)throw new Error('Positional HTML attempted direct HTTP: '+JSON.stringify(direct));
    return ['Positional HTML methods preserve native contexts, coercion, hierarchy and node identity','Positional HTML scripts run after mutation through the virtual document','Positional images, stylesheets and closed shadow resources stay on the relay'];
  }finally{await native.close();await page.unroute(/^https?:/,block);}
}
