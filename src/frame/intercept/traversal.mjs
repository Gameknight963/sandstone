import {unwrap_frame_document as unwrap_document,document_states} from '../document_identity.mjs';

const traversers=document_states('traversers');
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const mapped=(state,node)=>state.documents.has(node)?state.documents.get(node):node;
function adapt_filter(filter,state){
  if(typeof filter==='function'){
    const adapter=function(node){return Reflect.apply(filter,this===adapter?filter:this,[mapped(state,node)]);};
    return adapter;
  }
  if(filter!==null&&typeof filter==='object')return {acceptNode(node){return Reflect.apply(filter.acceptNode,filter,[mapped(state,node)]);}};
  return filter;
}
if(globalThis.Document){
  for(const name of ['createTreeWalker','createNodeIterator']){
    const original=Document.prototype[name];
    Document.prototype[name]=new Proxy(original,{apply(target,receiver,args){
      const converted=[...args];if(args.length)converted[0]=unwrap_document(args[0]);
      // ownerDocument can supply the native document. Retain the input root's
      // identity even if a TreeWalker later receives the virtual currentNode.
      const state={filter:args[2]??null,root:args[0],documents:new WeakMap()};
      // Capture the root's document after native argument conversion succeeds.
      if(args.length>2)converted[2]=adapt_filter(args[2],state);
      const result=Reflect.apply(target,unwrap_document(receiver),converted);
      const document=kind.call(converted[0])===9?converted[0]:owner.call(converted[0]);
      if(document)state.documents.set(document,converted[0]===document?args[0]:document);
      traversers.set(result,state);return result;
    }});
  }
  for(const Constructor of [globalThis.TreeWalker,globalThis.NodeIterator]){
    if(!Constructor)continue;
    for(const name of ['root','currentNode','referenceNode','filter']){
      const property=Object.getOwnPropertyDescriptor(Constructor.prototype,name);if(!property)continue;
      Object.defineProperty(Constructor.prototype,name,{...property,
        get(){const value=property.get.call(this),state=traversers.get(this);return !state?value:name==='filter'?state.filter:name==='root'?state.root:mapped(state,value);},
        ...(property.set?{set:new Proxy(property.set,{apply(target,receiver,args){
          const converted=[...args];if(args.length&&traversers.has(receiver))converted[0]=unwrap_document(args[0]);
          const result=Reflect.apply(target,receiver,converted);
          if(traversers.has(receiver)&&kind.call(converted[0])===9)traversers.get(receiver).documents.set(converted[0],args[0]);
          return result;
        }})}:{})
      });
    }
    for(const name of ['parentNode','firstChild','lastChild','previousSibling','nextSibling','previousNode','nextNode']){
      const original=Constructor.prototype[name];if(!original)continue;
      Constructor.prototype[name]=new Proxy(original,{apply(target,receiver,args){const value=Reflect.apply(target,receiver,args),state=traversers.get(receiver);return state?mapped(state,value):value;}});
    }
  }
}
