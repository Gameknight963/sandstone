import {serialize,serializeOuter} from 'parse5';
import {copy_resource_node} from './resource_nodes.mjs';
import {unwrap_document} from './document_identity.mjs';

const N=globalThis.Node?.prototype,E=globalThis.Element?.prototype,D=globalThis.Document?.prototype;
const descriptor=(prototype,key)=>prototype&&Object.getOwnPropertyDescriptor(prototype,key);
const kind=descriptor(N,'nodeType')?.get,children=descriptor(N,'childNodes')?.get,parent=descriptor(N,'parentNode')?.get;
const owner=descriptor(N,'ownerDocument')?.get,clone=N?.cloneNode;
const namespace=descriptor(E,'namespaceURI')?.get,local=descriptor(E,'localName')?.get,prefix=descriptor(E,'prefix')?.get;
const attributes=descriptor(E,'attributes')?.get,content=globalThis.HTMLTemplateElement&&descriptor(HTMLTemplateElement.prototype,'content').get;
const attribute_fields=Object.fromEntries(['name','localName','namespaceURI','prefix','value'].map(key=>[key,globalThis.Attr&&descriptor(Attr.prototype,key).get]));
const data=globalThis.CharacterData&&descriptor(CharacterData.prototype,'data').get;
const content_type=descriptor(D,'contentType')?.get,view=descriptor(D,'defaultView')?.get;
const create=D?.createElementNS,import_node=D?.importNode,fragment=D?.createDocumentFragment;
const append=N?.appendChild,set=E?.setAttributeNS;
const element_inner=descriptor(E,'innerHTML'),element_outer=descriptor(E,'outerHTML');
const shadow_inner=globalThis.ShadowRoot&&descriptor(ShadowRoot.prototype,'innerHTML');
const native_serialize=globalThis.XMLSerializer?.prototype.serializeToString;
const standard_namespaces=new Set(['http://www.w3.org/1999/xhtml','http://www.w3.org/2000/svg','http://www.w3.org/1998/Math/MathML']);

// Build plain inert nodes, rather than cloning custom elements with their
// registries. Serialization must never invoke authored constructors/reactions.
function snapshot(source){
  const document=kind.call(source)===9?source:owner.call(source),inert=clone.call(document,false),pairs=[],scripting=new WeakMap();
  const shallow=node=>{
    const type=kind.call(node);let copy;
    if(type===1){
      const tag=(prefix.call(node)?prefix.call(node)+':':'')+local.call(node);
      copy=create.call(inert,namespace.call(node),tag);
      for(const attribute of attributes.call(node))set.call(copy,attribute_fields.namespaceURI.call(attribute),attribute_fields.name.call(attribute),attribute_fields.value.call(attribute));
    }else if(type===9)copy=inert;
    else if(type===11)copy=fragment.call(inert);
    else copy=import_node.call(inert,node,false);
    if(type===1)scripting.set(copy,!!view.call(owner.call(node)));
    pairs.push([node,copy]);return copy;
  };
  const root=shallow(source),stack=[[source,root]];
  while(stack.length){
    const [node,copy]=stack.pop();
    const template=kind.call(node)===1&&namespace.call(node)==='http://www.w3.org/1999/xhtml'&&local.call(node)==='template';
    const from=template?content.call(node):node,to=template?content.call(copy):copy,next=[];
    for(const child of children.call(from)){const target=shallow(child);append.call(to,target);next.push([child,target]);}
    for(let index=next.length-1;index>=0;index--)stack.push(next[index]);
  }
  for(let index=pairs.length-1;index>=0;index--)copy_resource_node(pairs[index][0],pairs[index][1],true,false,true);
  return {root,document,html:content_type.call(document)==='text/html',scripting:!!view.call(document),nodeScripting:scripting,empty:fragment.call(inert)};
}
const adapter={
  isElementNode:node=>kind.call(node)===1,
  isTextNode:node=>[3,4].includes(kind.call(node)),
  isCommentNode:node=>kind.call(node)===8,
  isDocumentTypeNode:node=>kind.call(node)===10,
  getNamespaceURI:node=>namespace.call(node),
  getTagName:node=>(standard_namespaces.has(namespace.call(node))||!prefix.call(node)?'':prefix.call(node)+':')+local.call(node),
  getChildNodes:node=>[...children.call(node)],
  getTemplateContent:node=>content.call(node),
  getParentNode:node=>parent.call(node),
  getTextNodeContent:node=>data.call(node),
  getCommentNodeContent:node=>data.call(node),
  getDocumentTypeNodeName:node=>node.name,
  getAttrList:node=>[...attributes.call(node)].map(attribute=>{
    const ns=attribute_fields.namespaceURI.call(attribute),p=attribute_fields.prefix.call(attribute);
    return {name:attribute_fields.localName.call(attribute),namespace:ns&&!p&&!['http://www.w3.org/XML/1998/namespace','http://www.w3.org/2000/xmlns/','http://www.w3.org/1999/xlink'].includes(ns)?null:ns,prefix:p,value:attribute_fields.value.call(attribute)};
  })
};
function contextual_adapter(state){
  return {...adapter,getParentNode(node){const parent=adapter.getParentNode(node);return parent&&adapter.isElementNode(parent)&&adapter.getTagName(parent)==='noscript'&&!state.nodeScripting.get(parent)?state.empty:parent;}};
}
function markup(source,outer){
  const state=snapshot(source);
  if(!state.html)return (outer?element_outer:element_inner).get.call(state.root);
  const options={treeAdapter:contextual_adapter(state),scriptingEnabled:state.scripting};
  if(outer)return serializeOuter(state.root,options);
  return serialize(state.root,options);
}
export function install_serialization(){
  if(!E)return;
  for(const [key,native] of [['innerHTML',element_inner],['outerHTML',element_outer]]){
    const current=descriptor(E,key);
    Object.defineProperty(E,key,{...current,get:new Proxy(native.get,{apply(target,receiver,args){Reflect.apply(target,receiver,args);return markup(receiver,key==='outerHTML');}})});
  }
  if(shadow_inner){
    const current=descriptor(ShadowRoot.prototype,'innerHTML');
    Object.defineProperty(ShadowRoot.prototype,'innerHTML',{...current,get:new Proxy(shadow_inner.get,{apply(target,receiver,args){Reflect.apply(target,receiver,args);const state=snapshot(receiver);if(state.html)return serialize(state.root,{treeAdapter:contextual_adapter(state),scriptingEnabled:state.scripting});const host=create.call(owner.call(state.root),'http://www.w3.org/1999/xhtml','div');for(const child of [...children.call(state.root)])append.call(host,child);return element_inner.get.call(host);}})});
  }
  if(native_serialize)XMLSerializer.prototype.serializeToString=new Proxy(native_serialize,{apply(target,receiver,args){
    const converted=[...args];if(converted.length)converted[0]=unwrap_document(converted[0]);
    Reflect.apply(target,receiver,converted);
    const state=snapshot(converted[0]);return Reflect.apply(target,receiver,[state.root]);
  }});
}
