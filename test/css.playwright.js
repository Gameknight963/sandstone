async page => {
  await page.evaluate(async () => {
    const previous=sandstone.network.session.fetch;
    globalThis.cssRequests=[];
    sandstone.network.session.fetch=async (url,options) => {
      const path=new URL(url).pathname;
      if(!path.startsWith('/css-fixture/')) return previous(url,options);
      cssRequests.push(url);
      if(path.startsWith('/css-fixture/eof-import'))return new Response('#text-eof-import{padding-left:29px}',{headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/theme.css')) return new Response('@import "nested.css"; @import "cycle.css"; #imported {color:rgb(21,43,65)}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/nested.css')) return new Response('#nested {padding-left:17px; background-image:url("image (one).svg#shape")}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/cycle.css')) return new Response('@import "theme.css"; #cycle {margin-left:19px}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/dynamic.css')) {
        await new Promise(resolve=>setTimeout(resolve,50));
        return new Response('#dynamic {color:rgb(67,89,101)}',{headers:{'Content-Type':'text/css'}});
      }
      if(path.endsWith('/missing.css')) return new Response('',{status:404});
      if(path.endsWith('/slow.css')) {
        await new Promise(resolve=>globalThis.releaseSlowCSS=resolve);
        return new Response('#dynamic {color:rgb(1,2,3)}',{headers:{'Content-Type':'text/css'}});
      }
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect id="shape" width="2" height="2" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    };
    main_frame.special_pages['https://fixture.test/css-fixture/page']=`<!doctype html>
      <style>
        @import './theme.css' layer(theme) supports(display:grid) screen;
        @import './missing.css';
        #images {background-image:image-set('./one.svg' 1x type('image/svg+xml'), url('./two.svg') 2x)}
      </style>
      <body><div id="imported">Imported</div><div id="nested">Nested</div><div id="cycle">Cycle</div>
      <div id="images">Images</div><div id="dynamic">Dynamic</div>
      <script>
        const style=document.createElement('style');
        style.textContent='@import "/css-fixture/dynamic.css"; #dynamic { background-image:url("/css-fixture/dynamic.svg") }';
        document.head.append(style);
        window.fixtureDynamicStyle=style;
      <\/script>`;
    await main_frame.navigate_to('https://fixture.test/css-fixture/page');
  });
  const deadline=Date.now()+10000;
  let result;
  while(Date.now()<deadline) {
    result=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify({
      imported:getComputedStyle(document.getElementById('imported')).color,
      nested:getComputedStyle(document.getElementById('nested')).paddingLeft,
      cycle:getComputedStyle(document.getElementById('cycle')).marginLeft,
      dynamic:getComputedStyle(document.getElementById('dynamic')).color,
      image:getComputedStyle(document.getElementById('nested')).backgroundImage,
      images:getComputedStyle(document.getElementById('images')).backgroundImage
    })`)));
    if(result.imported==='rgb(21, 43, 65)' && result.nested==='17px' && result.cycle==='19px' && result.dynamic==='rgb(67, 89, 101)') break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(result.imported!=='rgb(21, 43, 65)' || result.nested!=='17px' || result.cycle!=='19px' || result.dynamic!=='rgb(67, 89, 101)') throw new Error('CSS imports failed: '+JSON.stringify(result));
  if(!result.image.includes('blob:') || !result.image.includes('#shape') || !result.images.includes('blob:')) throw new Error('CSS images did not use local blobs: '+JSON.stringify(result));
  const requested=await page.evaluate(()=>cssRequests.map(url=>new URL(url).pathname));
  for(const name of ['theme.css','nested.css','cycle.css','dynamic.css','missing.css','image%20(one).svg','one.svg','two.svg','dynamic.svg']) {
    if(!requested.includes('/css-fixture/'+name)) throw new Error('Missing relayed CSS request: '+name+' '+JSON.stringify(requested));
  }
  if(requested.filter(path=>path.endsWith('/theme.css')).length!==1) throw new Error('CSS import cycle was fetched repeatedly');
  await page.evaluate(()=>main_frame.eval_js(`fixtureDynamicStyle.innerHTML='@import "/css-fixture/slow.css";'; true`));
  await page.waitForFunction(()=>typeof releaseSlowCSS==='function');
  await page.evaluate(()=>main_frame.eval_js(`fixtureDynamicStyle.textContent='#dynamic {color:rgb(111,112,113)}'; true`));
  await page.evaluate(()=>releaseSlowCSS());
  // Wait for the obsolete response to finish crossing the relay before checking.
  await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>setTimeout(resolve,100))`));
  const final=await page.evaluate(()=>main_frame.eval_js(`getComputedStyle(document.getElementById('dynamic')).color`));
  if(final!=='rgb(111, 112, 113)') throw new Error('An obsolete stylesheet overwrote a later text update: '+final);
  await page.evaluate(()=>main_frame.eval_js(`
    window.styleTextFixtures=[];
    function textStyle(name,operation){
      const target=document.createElement('div');target.id='text-'+name;document.body.append(target);
      const style=document.createElement('style');document.head.append(style);
      const css='#text-'+name+'{padding-left:29px;background-image:url("/css-fixture/text-'+name+'.svg")}';
      const result=operation(style,css),nodes=Array.isArray(result)?result:Array.from(style.childNodes);
      styleTextFixtures.push({name,target,style,nodes});
    }
    const text=value=>document.createTextNode(value);
    textStyle('appendChild',(s,c)=>{const n=text(c);s.appendChild(n);return [n];});
    textStyle('append',(s,c)=>s.append(c));
    textStyle('prepend',(s,c)=>{s.append(text(''));s.prepend(c);});
    textStyle('fragment',(s,c)=>{const f=document.createDocumentFragment(),i=c.indexOf('url(')+6;f.append(text(c.slice(0,i)),text(c.slice(i)));const nodes=Array.from(f.childNodes);s.append(f);return nodes;});
    textStyle('insertBefore',(s,c)=>{const n=text('');s.append(n);s.insertBefore(text(c),n);});
    textStyle('replaceChildren',(s,c)=>s.replaceChildren(text(c)));
    for(const key of ['data','nodeValue','textContent'])textStyle(key,(s,c)=>{const n=text('');s.append(n);n[key]=c;return [n];});
    textStyle('appendData',(s,c)=>{const i=c.indexOf('url(')+6,n=text(c.slice(0,i));s.append(n);n.appendData(c.slice(i));n.appendData(' /* another edit while pending */');return [n];});
    textStyle('insertData',(s,c)=>{const n=text(c.replace('url(',''));s.append(n);n.insertData(c.indexOf('url('),'url(');return [n];});
    textStyle('replaceData',(s,c)=>{const n=text('placeholder');s.append(n);n.replaceData(0,n.length,c);return [n];});
    textStyle('deleteData',(s,c)=>{const i=c.indexOf('url(')+1,n=text(c.slice(0,i)+'XX'+c.slice(i));s.append(n);n.deleteData(i,2);return [n];});
    textStyle('splitText',(s,c)=>{const n=text(c);s.append(n);const other=n.splitText(n.data.indexOf('data:')+3);return [n,other];});
    textStyle('before',(s,c)=>{const n=text('');s.append(n);n.before(c);});
    textStyle('after',(s,c)=>{const n=text('');s.append(n);n.after(c);});
    textStyle('replaceWith',(s,c)=>{const n=text('');s.append(n);n.replaceWith(text(c));});
    textStyle('innerText',(s,c)=>s.innerText=c);
    textStyle('adjacentText',(s,c)=>s.insertAdjacentText('beforeend',c));
    textStyle('rangeInsert',(s,c)=>{const r=document.createRange();r.selectNodeContents(s);r.insertNode(text(c));});
    textStyle('rangeDelete',(s,c)=>{const i=c.indexOf('url(')+1,n=text(c.slice(0,i)+'XX'+c.slice(i));s.append(n);const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+2);r.deleteContents();return [n];});
    for(const name of ['moved','removedAndReinserted'])textStyle(name,(s,c)=>{const old=document.createElement('style'),n=text(c);old.append(n);document.head.append(old);if(name==='removedAndReinserted')old.removeChild(n);s.appendChild(n);old.remove();return [n];});
    true;
  `));
  let textResults;
  const textDeadline=Date.now()+10000;
  while(Date.now()<textDeadline){
    textResults=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify(styleTextFixtures.map(({name,target,style,nodes})=>({name,padding:getComputedStyle(target).paddingLeft,image:getComputedStyle(target).backgroundImage,identities:nodes.every(node=>node.parentNode===style),type:style.getAttribute('type')})))`)));
    if(textResults.every(result=>result.padding==='29px'&&result.image.includes('blob:')))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  for(const result of textResults)if(result.padding!=='29px'||!result.image.includes('blob:')||!result.identities||result.type!==null)throw new Error('Style text mutation failed: '+JSON.stringify(result));
  const textRequests=await page.evaluate(()=>cssRequests.map(url=>new URL(url).pathname));
  for(const result of textResults)if(!textRequests.includes('/css-fixture/text-'+result.name+'.svg'))throw new Error('Style text bypassed relay: '+result.name);
  await page.evaluate(()=>main_frame.eval_js(`
    window.eofStyles=[];
    for(const quoted of [false,true]){
      const suffix=quoted?'quoted':'unquoted',target=document.createElement('div');target.id='text-eof-'+suffix;document.body.append(target);
      const style=document.createElement('style');style.textContent='#text-eof-'+suffix+'{background-image:url('+(quoted?'"':'')+'/css-fixture/text-eof-'+suffix;
      document.head.append(style);eofStyles.push({style,target,quoted});
    }
    const imported=document.createElement('div');imported.id='text-eof-import';document.body.append(imported);
    window.eofImportStyle=document.createElement('style');eofImportStyle.append(document.createTextNode('@import "/css-fixture/eof-import'));document.head.append(eofImportStyle);true;
  `));
  const eofDeadline=Date.now()+10000;
  let eofReady=false;
  while(Date.now()<eofDeadline){
    eofReady=await page.evaluate(()=>main_frame.eval_js(`eofStyles.every(({target})=>getComputedStyle(target).backgroundImage.includes('blob:')) && getComputedStyle(document.getElementById('text-eof-import')).paddingLeft==='29px'`));
    if(eofReady)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(!eofReady)throw new Error('EOF resource syntax was not relayed');
  await page.evaluate(()=>main_frame.eval_js(`
    for(const {style,quoted} of eofStyles)style.firstChild.appendData('-finished.svg'+(quoted?'"':'')+')}');
    eofImportStyle.firstChild.appendData('.css";');true;
  `));
  await page.waitForFunction(()=>['text-eof-quoted-finished.svg','text-eof-unquoted-finished.svg','eof-import.css'].every(name=>cssRequests.some(url=>new URL(url).pathname==='/css-fixture/'+name)));
  await page.evaluate(()=>main_frame.eval_js(`
    window.disabledTextStyle=document.createElement('style');disabledTextStyle.type='text/css';
    disabledTextStyle.textContent='#dynamic{padding-left:99px}';document.head.append(disabledTextStyle);
    disabledTextStyle.sheet.disabled=true;
    disabledTextStyle.append(document.createTextNode('#dynamic{background-image:url("/css-fixture/text-disabled.svg")}'));true;
  `));
  await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>setTimeout(resolve,100))`));
  const disabled=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify({disabled:disabledTextStyle.sheet.disabled,type:disabledTextStyle.type,padding:getComputedStyle(document.getElementById('dynamic')).paddingLeft})`)));
  if(!disabled.disabled||disabled.type!=='text/css'||disabled.padding==='99px')throw new Error('Text rewriting enabled a disabled stylesheet: '+JSON.stringify(disabled));

  await page.evaluate(()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.heldTextStyles=[];
    sandstone.network.session.fetch=async(url,options)=>{
      if(new URL(url).pathname==='/css-fixture/text-slow.svg')await new Promise(resolve=>heldTextStyles.push(resolve));
      return previous(url,options);
    };
  });
  await page.evaluate(()=>main_frame.eval_js(`
    window.racingTextStyle=document.createElement('style');
    racingTextStyle.append(document.createTextNode('#dynamic{color:rgb(1,2,3);background-image:url("/css-fixture/text-slow.svg")}'));
    document.head.append(racingTextStyle);true;
  `));
  await page.waitForFunction(()=>heldTextStyles.length>0);
  await page.evaluate(()=>main_frame.eval_js(`racingTextStyle.firstChild.data='#dynamic{color:rgb(121,122,123);background-image:url("/css-fixture/text-fast.svg")}';true`));
  await page.evaluate(()=>{for(const resolve of heldTextStyles.splice(0))resolve();});
  await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>setTimeout(resolve,100))`));
  const race=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify({color:getComputedStyle(document.getElementById('dynamic')).color,image:getComputedStyle(document.getElementById('dynamic')).backgroundImage})`)));
  if(race.color!=='rgb(121, 122, 123)'||!race.image.includes('blob:'))throw new Error('Stale text-node stylesheet request won: '+JSON.stringify(race));

  await page.evaluate(()=>main_frame.eval_js(`
    window.concurrentTextStyle=document.createElement('style');
    concurrentTextStyle.append(document.createTextNode('#dynamic{background-image:url("/css-fixture/text-slow.svg")}'));
    document.head.append(concurrentTextStyle);true;
  `));
  await page.waitForFunction(()=>heldTextStyles.length>0);
  await page.evaluate(()=>main_frame.eval_js(`
    window.concurrentTextRule=concurrentTextStyle.sheet.cssRules[0];
    concurrentTextRule.style.color='rgb(131,132,133)';
    concurrentTextStyle.sheet.insertRule('#dynamic{margin-left:31px}',1);true;
  `));
  await page.evaluate(()=>{for(const resolve of heldTextStyles.splice(0))resolve();});
  await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>setTimeout(resolve,100))`));
  const concurrent=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify({identity:concurrentTextStyle.sheet.cssRules[0]===concurrentTextRule,color:getComputedStyle(document.getElementById('dynamic')).color,margin:getComputedStyle(document.getElementById('dynamic')).marginLeft,image:getComputedStyle(document.getElementById('dynamic')).backgroundImage})`)));
  if(!concurrent.identity||concurrent.color!=='rgb(131, 132, 133)'||concurrent.margin!=='31px'||!concurrent.image.includes('blob:'))throw new Error('Text resource hydration discarded CSSOM edits: '+JSON.stringify(concurrent));
  return ['Nested CSS imports with layers/supports/media', 'CSS import cycles and failed requests', 'Escaped/quoted CSS URLs and image-set', 'Dynamic stylesheet text updates and races', 'Style Text/CharacterData/Range mutations through the relay', 'Text node identity, split URL tokens and concurrent CSSOM edits', 'EOF URL/import continuations and disabled stylesheets'];
}
