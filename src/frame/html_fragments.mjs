// Parse with native context rules in a document without a browsing context.
// Detached elements in the live document can start resource requests before
// their nodes have been rewritten.
const element=globalThis.Element?.prototype,node=globalThis.Node?.prototype;
const inner=element&&Object.getOwnPropertyDescriptor(element,'innerHTML').set;
const outer=element&&Object.getOwnPropertyDescriptor(element,'outerHTML').set;
const adjacent=element?.insertAdjacentHTML,append=node?.appendChild,remove=node?.removeChild;
const parent=node&&Object.getOwnPropertyDescriptor(node,'parentElement').get;
const first=node&&Object.getOwnPropertyDescriptor(node,'firstChild').get;
const owner=node&&Object.getOwnPropertyDescriptor(node,'ownerDocument').get;
const importNode=globalThis.Document?.prototype.importNode;

export function html_fragment(context,value,operation='inner',position){
  const source=owner.call(context);
  const inert=source.contentType==='text/html'?source.implementation.createHTMLDocument(''):
    source.implementation.createDocument(source.documentElement?.namespaceURI||null,'',null);
  const copy=importNode.call(inert,context,false);
  let original=context,ancestor=copy;
  // The fragment parser's form pointer and namespace integration points can
  // depend on ancestors, even when those ancestors are detached.
  while((original=parent.call(original))){
    const container=importNode.call(inert,original,false);
    append.call(container,ancestor);ancestor=container;
  }
  let container=copy;
  if(operation==='outer'||operation==='adjacent'&&['beforebegin','afterend'].includes(position)){
    container=parent.call(copy);
    if(!container){container=inert.createDocumentFragment();append.call(container,copy);}
  }
  if(operation==='inner')inner.call(copy,value);
  else if(operation==='outer')outer.call(copy,value);
  else{
    adjacent.call(copy,position,value);
    if(container!==copy)remove.call(container,copy);
  }
  const fragment=inert.createDocumentFragment();
  while(first.call(container))append.call(fragment,first.call(container));
  for(const script of fragment.querySelectorAll('script'))script.__sandstone_inert__=true;
  return fragment;
}
