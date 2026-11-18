async page=>{
  const origin='https://frame-traversal.test',html='<!doctype html><body><p>Traversal fixture</p>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const cases=[
    ['borrowed document traversal',`const doc=child.document,seen=[],filter=node=>{seen.push(node===doc);return NodeFilter.FILTER_ACCEPT},iterator=Document.prototype.createNodeIterator.call(doc,doc,NodeFilter.SHOW_ALL,filter),walker=Document.prototype.createTreeWalker.call(doc,doc);const first=iterator.nextNode();walker.firstChild();result={root:iterator.root===doc,first:first===doc,seen,filter:iterator.filter===filter,parent:walker.parentNode()===doc};`],
    ['borrowed iterator accessors',`const doc=child.document,filter=node=>NodeFilter.FILTER_ACCEPT,iterator=doc.createNodeIterator(doc,NodeFilter.SHOW_ALL,filter);const get=name=>Object.getOwnPropertyDescriptor(NodeIterator.prototype,name).get.call(iterator);result={root:get('root')===doc,reference:get('referenceNode')===doc,filter:get('filter')===filter,first:NodeIterator.prototype.nextNode.call(iterator)===doc};`],
    ['borrowed walker assignment',`const doc=child.document,walker=doc.createTreeWalker(doc),property=Object.getOwnPropertyDescriptor(TreeWalker.prototype,'currentNode');walker.firstChild();property.set.call(walker,doc);result={current:property.get.call(walker)===doc,next:TreeWalker.prototype.nextNode.call(walker).nodeName};`],
    ['walker outside its root document',`const doc=child.document,walker=doc.createTreeWalker(doc),property=Object.getOwnPropertyDescriptor(TreeWalker.prototype,'currentNode');property.set.call(walker,document);const parent=property.get.call(walker)===document;walker.firstChild();const back=walker.parentNode()===document;walker.currentNode=doc;result={parent,back,child:property.get.call(walker)===doc,root:walker.root===doc};`],
    ['observer of multiple frame documents',`const doc=child.document,observer=new MutationObserver(()=>{});observer.observe(document,{childList:true});observer.observe(doc,{childList:true});document.insertBefore(document.createComment('parent'),document.documentElement);doc.insertBefore(doc.createComment('child'),doc.documentElement);const records=observer.takeRecords(),get=Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target').get;result=records.map(record=>({target:record.target===(record.addedNodes[0].data==='parent'?document:doc),borrowed:get.call(record)===(record.addedNodes[0].data==='parent'?document:doc)}));observer.disconnect();`],
    ['borrowed child observer methods',`const doc=child.document,observer=new child.MutationObserver(()=>{});MutationObserver.prototype.observe.call(observer,doc,{childList:true});doc.insertBefore(doc.createComment('child observer'),doc.documentElement);const records=MutationObserver.prototype.takeRecords.call(observer);result={target:records[0]?.target===doc,borrowed:Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target').get.call(records[0])===doc};observer.disconnect();`],
    ['observer callback across documents',`let resolve;const done=new Promise(value=>resolve=value),doc=child.document,observer=new child.MutationObserver(function(records,self){resolve({receiver:this===observer,self:self===observer,targets:records.map(record=>record.target===(record.addedNodes[0].data==='parent'?document:doc))})});MutationObserver.prototype.observe.call(observer,document,{childList:true});observer.observe(doc,{childList:true});document.insertBefore(document.createComment('parent'),document.documentElement);doc.insertBefore(doc.createComment('child'),doc.documentElement);result=await done;observer.disconnect();`],
    ['detached frame traversal identity',`const doc=child.document,iterator=doc.createNodeIterator(doc);document.querySelector('iframe').remove();result={root:Object.getOwnPropertyDescriptor(NodeIterator.prototype,'root').get.call(iterator)===doc,first:NodeIterator.prototype.nextNode.call(iterator)===doc};`],
    ['unregistered objects retain native validation',`const errors=[],fake=new Proxy({},{get(){throw new Error('author getter')}});for(const operation of [()=>Document.prototype.createTreeWalker.call(fake,document),()=>document.createNodeIterator(fake),()=>new MutationObserver(()=>{}).observe(fake,{childList:true})])try{operation();errors.push(null)}catch(error){errors.push(error.name)}result=errors;`]
  ];
  try{
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(url,options);},{origin,html});
    const differences=[];
    for(const [name,source] of cases){
      const outcomes=[];
      for(const proxy of [false,true]){
        if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');else await native.goto(origin+'/parent');
        await evaluate(proxy,`new Promise(resolve=>{const frame=document.createElement('iframe');frame.src='${origin}/child';frame.onload=()=>{globalThis.child=frame.contentWindow;resolve(true)};document.body.append(frame)})`);
        outcomes.push(JSON.parse(await evaluate(proxy,`(async()=>{let result;try{${source};return JSON.stringify({result})}catch(error){return JSON.stringify({error:error.name})}})()`)));
      }
      if(JSON.stringify(outcomes[0])!==JSON.stringify(outcomes[1]))differences.push({name,expected:outcomes[0],actual:outcomes[1]});
    }
    if(differences.length)throw new Error('Frame traversal parity: '+JSON.stringify(differences));
    return ['Same-origin frames preserve document and filter identity through borrowed traversal APIs','MutationObservers preserve targets across multiple same-origin frame documents and borrowed methods'];
  }finally{await native.close();}
}
