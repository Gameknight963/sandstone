async page => {
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const read=async source=>JSON.parse(await evaluate(`(async()=>JSON.stringify(await (${source})))()`));
  const until=async source=>{
    const deadline=Date.now()+10000;
    while(!await evaluate(source)){
      if(Date.now()>deadline)throw new Error('CSSOM condition timed out: '+source);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await page.evaluate(async()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.cssomRequests=[];
    globalThis.releaseCSSOM=[];
    sandstone.network.session.fetch=async(url,options)=>{
      const path=new URL(url).pathname;
      if(!path.startsWith('/cssom-fixture/'))return previous(url,options);
      cssomRequests.push(url);
      if(path.includes('/slow-'))await new Promise(resolve=>releaseCSSOM.push(resolve));
      if(path.endsWith('/slow-active.css'))return new Response('#imported {margin-left:29px}',{headers:{'Content-Type':'text/css'}});
      if(path.endsWith('.css'))return new Response('#imported {color:rgb(12,34,56)}',{headers:{'Content-Type':'text/css'}});
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    };
    main_frame.special_pages['https://fixture.test/cssom-fixture/page']='<!doctype html><base href="/cssom-fixture/"><style id="sheet"></style><body><div id="inline">Inline</div><div id="rule">Rule</div><div id="custom">Custom</div><div id="constructed">Constructed</div><div id="imported">Import</div><div id="host"></div>';
    await main_frame.navigate_to('https://fixture.test/cssom-fixture/page');
  });
  const synchronous=await read(`(()=>{
    const node=document.getElementById('inline');
    node.style.background='red url(inline.svg) center / cover';
    node.style.backgroundColor='rgb(11,22,33)';
    window.inlineStyle=node.style;
    const sheet=document.getElementById('sheet').sheet;
    const index=sheet.insertRule('#rule {background-image:url(rule.svg); padding-left:17px}',0);
    window.cssomRule=sheet.cssRules[index];window.cssomDeclaration=cssomRule.style;
    cssomRule.selectorText='#rule, #custom';cssomRule.style.color='rgb(21,43,65)';
    sheet.insertRule('@media (min-width:1px) {}',1);
    sheet.cssRules[1].insertRule('#custom {mask-image:url(mask.svg)}',0);
    sheet.insertRule('@keyframes motion {from{background-image:url(frame.svg)}}',2);
    sheet.cssRules[2].appendRule('to{background-image:url(frame-last.svg)}');
    node.style.setProperty('--asset','url(variable.svg)');
    node.append(document.getElementById('custom'));
    document.getElementById('custom').style.setProperty('background-image','var(--asset)');
    return {index,padding:getComputedStyle(document.getElementById('rule')).paddingLeft,
      same:node.style===inlineStyle,brand:node.style instanceof CSSStyleDeclaration};
  })()`);
  if(JSON.stringify(synchronous)!==JSON.stringify({index:0,padding:'17px',same:true,brand:true}))throw new Error('Synchronous CSSOM behavior changed: '+JSON.stringify(synchronous));
  await until(`inlineStyle.backgroundImage.includes('blob:') && cssomRule.style.backgroundImage.includes('blob:') &&
    document.getElementById('sheet').sheet.cssRules[1].cssRules[0].style.maskImage.includes('blob:') &&
    document.getElementById('sheet').sheet.cssRules[2].cssRules[1].style.backgroundImage.includes('blob:') &&
    inlineStyle.getPropertyValue('--asset').includes('blob:') &&
    getComputedStyle(document.getElementById('custom')).backgroundImage.includes('blob:')`);
  const preserved=await read(`({color:inlineStyle.backgroundColor,ruleColor:cssomRule.style.color,selector:cssomRule.selectorText,
    rule:cssomRule===document.getElementById('sheet').sheet.cssRules[0],style:cssomDeclaration===cssomRule.style})`);
  if(JSON.stringify(preserved)!==JSON.stringify({color:'rgb(11, 22, 33)',ruleColor:'rgb(21, 43, 65)',selector:'#rule, #custom',rule:true,style:true}))throw new Error('Asynchronous CSS rewrites lost existing state: '+JSON.stringify(preserved));
  await evaluate(`(()=>{
    const node=document.getElementById('inline');
    node.setAttribute('style','border-image-source:url(attribute.svg);margin-left:23px');
    CSSStyleDeclaration.prototype.setProperty.call(node.style,'mask-image','url(prototype.svg)','important');
    node.style.cursor='url(cursor.svg), auto';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.style.fill='url(svg.svg#shape)';document.body.append(svg);window.cssomSVG=svg;
    window.constructedSheet=new CSSStyleSheet({baseURL:'https://fixture.test/cssom-fixture/constructed/'});
    constructedSheet.replaceSync('#constructed {background-image:url(sheet.svg); color:rgb(54,76,98)}');
    window.constructedRule=constructedSheet.cssRules[0];document.adoptedStyleSheets=[constructedSheet];
    return true;
  })()`);
  await until(`inlineStyle.borderImageSource.includes('blob:') && inlineStyle.maskImage.includes('blob:') &&
    inlineStyle.cursor.includes('blob:') && cssomSVG.style.fill.includes('blob:') && constructedRule.style.backgroundImage.includes('blob:')`);
  const constructed=await read(`({priority:inlineStyle.getPropertyPriority('mask-image'),margin:inlineStyle.marginLeft,
    same:constructedSheet.cssRules[0]===constructedRule,color:getComputedStyle(document.getElementById('constructed')).color})`);
  if(JSON.stringify(constructed)!==JSON.stringify({priority:'important',margin:'23px',same:true,color:'rgb(54, 76, 98)'}))throw new Error('Inline or constructed stylesheet failed: '+JSON.stringify(constructed));
  await evaluate(`inlineStyle.setProperty('list-style-image','url(slow-priority.svg)'); true`);
  await page.waitForFunction(()=>releaseCSSOM.length===1);
  await evaluate(`inlineStyle.setProperty('list-style-image',inlineStyle.getPropertyValue('list-style-image'),'important'); true`);
  await page.evaluate(()=>releaseCSSOM.splice(0).forEach(resolve=>resolve()));
  await until(`inlineStyle.listStyleImage.includes('blob:')`);
  if(await evaluate(`inlineStyle.getPropertyPriority('list-style-image')`)!=='important')throw new Error('A priority edit while loading was lost');
  const asyncSheet=await read(`(async()=>{
    const sheet=new CSSStyleSheet();
    const result=await sheet.replace('#shadow {background-image:url(shadow.svg);color:rgb(31,41,59)}');
    const shadow=document.getElementById('host').attachShadow({mode:'open'});
    const child=document.createElement('div');child.id='shadow';shadow.append(child);shadow.adoptedStyleSheets=[sheet];
    return {same:result===sheet,blob:sheet.cssRules[0].style.backgroundImage.includes('blob:'),color:getComputedStyle(child).color};
  })()`);
  if(JSON.stringify(asyncSheet)!==JSON.stringify({same:true,blob:true,color:'rgb(31, 41, 59)'}))throw new Error('Asynchronous constructed stylesheet failed: '+JSON.stringify(asyncSheet));
  await evaluate(`document.getElementById('sheet').sheet.insertRule('@import "import.css" layer(theme) supports(display:grid) screen;',0); true`);
  await until(`getComputedStyle(document.getElementById('imported')).color==='rgb(12, 34, 56)'`);
  await evaluate(`document.getElementById('sheet').sheet.insertRule('@import "slow-active.css" print;',0); true`);
  await page.waitForFunction(()=>releaseCSSOM.length===1);
  await evaluate(`document.getElementById('sheet').sheet.cssRules[0].media.mediaText='screen'; true`);
  await page.evaluate(()=>releaseCSSOM.splice(0).forEach(resolve=>resolve()));
  await until(`getComputedStyle(document.getElementById('imported')).marginLeft==='29px'`);
  if(await evaluate(`document.getElementById('sheet').sheet.cssRules[0].media.mediaText`)!=='screen')throw new Error('A media edit while loading an import was lost');
  await evaluate(`(()=>{
    inlineStyle.backgroundImage='url(slow-old.svg)';
    const sheet=document.getElementById('sheet').sheet;
    const index=sheet.insertRule('#removed {background:url(slow-rule.svg)}',sheet.cssRules.length);
    sheet.deleteRule(index);
    window.beforeImport=sheet.cssRules.length;
    sheet.insertRule('@import "slow-import.css";',0);sheet.deleteRule(0);
    return true;
  })()`);
  await page.waitForFunction(()=>releaseCSSOM.length===3);
  await evaluate(`inlineStyle.backgroundImage='url(latest.svg)'; true`);
  await until(`inlineStyle.backgroundImage.includes('blob:')`);
  const latest=await read('inlineStyle.backgroundImage');
  const invalid=await read(`(()=>{
    const errors=[];const sheet=document.getElementById('sheet').sheet;
    try{sheet.insertRule();}catch(error){errors.push(error.name);}
    try{sheet.insertRule('#bad {background:url(ignored.svg)} INVALID');}catch(error){errors.push(error.name);}
    inlineStyle.backgroundImage='unknown(url(ignored-value.svg))';
    return {errors,image:inlineStyle.backgroundImage};
  })()`);
  if(JSON.stringify(invalid.errors)!==JSON.stringify(['TypeError','SyntaxError'])||invalid.image!==latest)throw new Error('Invalid CSSOM operations changed existing state: '+JSON.stringify(invalid));
  await page.evaluate(()=>releaseCSSOM.forEach(resolve=>resolve()));
  await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  const final=await read(`({image:inlineStyle.backgroundImage,count:document.getElementById('sheet').sheet.cssRules.length,before:beforeImport})`);
  if(final.image!==latest||final.count!==final.before)throw new Error('Stale CSS requests resurrected deleted state: '+JSON.stringify(final));
  const requests=await page.evaluate(()=>cssomRequests.map(url=>new URL(url).pathname));
  if(requests.some(url=>url.includes('ignored')))throw new Error('Invalid CSS declarations fetched resources');
  for(const file of ['inline.svg','rule.svg','mask.svg','frame.svg','frame-last.svg','variable.svg','attribute.svg','prototype.svg','cursor.svg','svg.svg','constructed/sheet.svg','slow-priority.svg','shadow.svg','import.css','slow-active.css','slow-old.svg','slow-rule.svg','slow-import.css','latest.svg']) {
    if(!requests.includes('/cssom-fixture/'+file))throw new Error('Missing relayed CSSOM resource: '+file+' '+JSON.stringify(requests));
  }
  return ['CSSOM insertRule/group/keyframe URL rewriting','Inline styles/shorthands/custom properties through the relay',
    'Constructed/adopted/shadow stylesheets','CSS rule identity, concurrent edits and deleted-request handling'];
}
