import assert from 'node:assert/strict';

export async function verifyNodeDocuments(page){
  const origin='https://node-documents.test',html='<!doctype html><html><head><title>Node documents</title></head><body><main id="fixture"></main></body></html>';
  const native=await page.context().newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.evaluate(({origin,html})=>{
    const fetch=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,...args)=>new URL(url).origin===origin?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):fetch.call(sandstone.network.session,url,...args);
  },{origin,html});
  const cases=[
    ['node document identities',`const element=document.getElementById('fixture');return [element.ownerDocument===document,document.documentElement.parentNode===document,document.doctype.parentNode===document,element.getRootNode()===document,document.getRootNode()===document];`],
    ['connected ancestor walks',`let node=document.getElementById('fixture');const names=[];while(node&&node!==document){names.push(node.nodeName);node=node.parentNode}return {connected:node===document,names};`],
    ['borrowed Node accessors',`return ['ownerDocument','parentNode','nodeType','childNodes','textContent'].map(key=>{const get=Object.getOwnPropertyDescriptor(Node.prototype,key).get;const value=get.call(document);return key==='childNodes'?value.length:key==='textContent'?value:value===null?null:value});`],
    ['document Node method receivers and arguments',`return [Node.prototype.contains.call(document,document.body),document.body.ownerDocument.contains(document),Node.prototype.isSameNode.call(document,document.body.ownerDocument),Node.prototype.isEqualNode.call(document,document.body.ownerDocument),Node.prototype.compareDocumentPosition.call(document,document.body.ownerDocument),Node.prototype.getRootNode.call(document)===document];`],
    ['borrowed Document methods',`const owner=document.body.ownerDocument;return [Document.prototype.getElementById.call(owner,'fixture')===document.getElementById('fixture'),Document.prototype.querySelector.call(owner,'body')===document.body,Document.prototype.createElement.call(owner,'p').ownerDocument===document];`],
    ['borrowed Document accessors and virtual metadata',`const owner=document.body.ownerDocument,get=name=>Object.getOwnPropertyDescriptor(Document.prototype,name).get.call(owner);return [get('body')===document.body,get('documentElement')===document.documentElement,get('defaultView')===window,get('URL')===location.href,get('documentURI')===location.href,get('readyState')===document.readyState];`],
    ['borrowed metadata getters ignore own overrides',`const get=Object.getOwnPropertyDescriptor(Document.prototype,'URL').get;Object.defineProperty(document,'URL',{configurable:true,value:'author override'});try{return [document.URL,get.call(document)===location.href]}finally{delete document.URL}`],
    ['document arguments preserve DOM errors',`const values=[];for(const operation of [()=>document.body.appendChild(document),()=>Node.prototype.appendChild.call(document,document),()=>document.body.removeChild(document),()=>Document.prototype.adoptNode.call(document,document)])try{operation();values.push('unexpected')}catch(error){values.push(error.name)}return values;`],
    ['detached and inert node ownership',`const element=document.createElement('div'),fragment=document.createDocumentFragment(),inert=document.implementation.createHTMLDocument('Inert');fragment.append(element);return [element.ownerDocument===document,element.getRootNode()===fragment,inert.body.ownerDocument===inert,inert.documentElement.parentNode===inert,inert.body.getRootNode()===inert,inert.defaultView===null];`],
    ['shadow root identity and composed traversal',`const host=document.createElement('div'),root=host.attachShadow({mode:'closed'}),child=document.createElement('p');root.append(child);document.body.append(host);const result=[child.ownerDocument===document,child.getRootNode()===root,child.getRootNode({composed:true})===document];host.remove();return result;`],
    ['native invalid receivers avoid author getters',`let reads=0;const fake=new Proxy({},{get(){reads++;throw new Error('author getter')}}),errors=[];for(const operation of [()=>Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get.call(fake),()=>Node.prototype.getRootNode.call(fake),()=>Node.prototype.contains.call(fake,document)])try{operation()}catch(error){errors.push(error.name)}return {reads,errors};`],
    ['traversers accept document references from nodes',`const owner=document.body.ownerDocument,walker=document.createTreeWalker(owner),iterator=document.createNodeIterator(owner);return [walker.root===document,walker.currentNode===document,iterator.root===document,iterator.referenceNode===document,iterator.nextNode()===document];`],
    ['document location assignment uses the page location',`document.body.ownerDocument.location='#document-node';return [location.hash,document.location.href===location.href];`],
    ['same-origin child document references',`const frame=document.createElement('iframe');frame.src='${origin}/child';await new Promise(resolve=>{frame.onload=resolve;document.body.append(frame)});try{const child=frame.contentWindow,doc=child.document;return [doc.body.ownerDocument===doc,doc.documentElement.parentNode===doc,doc.body.getRootNode()===doc,Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get.call(doc.body)===doc,Node.prototype.contains.call(doc,doc.body),Document.prototype.querySelector.call(doc,'body')===doc.body,Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get.call(doc)===doc.defaultView,Object.getOwnPropertyDescriptor(Document.prototype,'URL').get.call(doc)===doc.URL]}finally{frame.remove()}`]
  ];
  try{
    const outcomes=[[],[]];
    for(const [index,proxy] of [false,true].entries()){
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
      for(const [name,source] of cases){
        const expression='(async()=>{try{return JSON.stringify({result:await(async()=>{'+source+'})()})}catch(error){return JSON.stringify({error:error.name,message:error.message})}})()';
        const value=proxy?await page.evaluate(source=>main_frame.eval_js(source),expression):await native.evaluate(source=>eval(source),expression);
        outcomes[index].push(JSON.parse(value));
      }
    }
    const differences=[];
    for(let index=0;index<cases.length;index++){
      assert.equal(outcomes[0][index].error,undefined,'Native '+cases[index][0]);
      if(JSON.stringify(outcomes[1][index])!==JSON.stringify(outcomes[0][index]))differences.push({name:cases[index][0],expected:outcomes[0][index],actual:outcomes[1][index]});
    }
    assert.deepEqual(differences,[],'Node document parity');
    return cases.map(([name])=>'Node document identity: '+name);
  }finally{await native.close();}
}
