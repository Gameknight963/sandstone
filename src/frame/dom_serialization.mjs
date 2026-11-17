import {serialize,serializeOuter,parseFragment} from 'parse5';
import {copy_resource_node} from './resource_nodes.mjs';
import {unwrap_document} from './document_identity.mjs';
import {shadow_root,track_shadow_root,shadow_mode} from './shadow_roots.mjs';
import {native_attach_shadow as attach,mark_inert_node} from './dom_operations.mjs';

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
const append=N?.appendChild,set=E?.setAttributeNS,set_attribute_node=E?.setAttributeNodeNS,remove=E?.removeAttributeNS;
const element_inner=descriptor(E,'innerHTML'),element_outer=descriptor(E,'outerHTML');
const shadow_inner=globalThis.ShadowRoot&&descriptor(ShadowRoot.prototype,'innerHTML');
const NativeSerializer=globalThis.XMLSerializer,native_serialize=NativeSerializer?.prototype.serializeToString;
const element_getHTML=E?.getHTML,shadow_getHTML=globalThis.ShadowRoot?.prototype.getHTML;
const shadow_host=globalThis.ShadowRoot&&descriptor(ShadowRoot.prototype,'host').get;
const shadow_serializable=globalThis.ShadowRoot&&descriptor(ShadowRoot.prototype,'serializable')?.get;
const standard_namespaces=new Set(['http://www.w3.org/1999/xhtml','http://www.w3.org/2000/svg','http://www.w3.org/1998/Math/MathML']);
let serialization_sequence=0;

// Build plain inert nodes, rather than cloning custom elements with their
// registries. Serialization must never invoke authored constructors/reactions.
function snapshot(source,options){
  const document=kind.call(source)===9?source:owner.call(source),inert=clone.call(document,false),pairs=[],scripting=new WeakMap(),copies=new WeakMap(),raw=new WeakSet(),xml=content_type.call(document)!=='text/html',projections=[];
  const selected=new Set(options?.shadowRoots||[]),explicit=new Map();
  for(const root of selected){track_shadow_root(root);explicit.set(shadow_host.call(root),root);}
  const shallow=node=>{
    const type=kind.call(node);let copy;
    if(type===1){
      const tag=(prefix.call(node)?prefix.call(node)+':':'')+local.call(node);
      // HTML parsing accepts names that XML-qualified creation rejects or
      // interprets as a prefix. These cannot name registered custom elements.
      if(!prefix.call(node)&&local.call(node).includes(':'))copy=import_node.call(inert,node,false);
      else try{copy=create.call(inert,namespace.call(node),tag);}
      catch(error){if(error.name!=='InvalidCharacterError')throw error;copy=import_node.call(inert,node,false);}
      mark_inert_node(copy);
      for(const attribute of attributes.call(node))set_attribute_node.call(copy,clone.call(attribute,false));
    }else if(type===9)copy=inert;
    else if(type===11)copy=options&&xml?attach.call(create.call(inert,'http://www.w3.org/1999/xhtml','div'),{mode:'open'}):fragment.call(inert);
    else copy=import_node.call(inert,node,false);
    if(type===1)scripting.set(copy,!!view.call(owner.call(node)));
    copies.set(node,copy);pairs.push([node,copy]);return copy;
  };
  const root=shallow(source),stack=[[source,root]];
  while(stack.length){
    const [node,copy]=stack.pop();let shadowTask;
    if(options&&kind.call(node)===1){
      const root=explicit.get(node)||shadow_root(node);
      if(root&&(selected.has(root)||options.serializableShadowRoots&&shadow_serializable?.call(root))){
        // Let the native serializer supply flag names and their order, including
        // newer shadow metadata. XML copies use private roots for namespace scope.
        const native=element_getHTML.call(node,native_options({shadowRoots:[root],serializableShadowRoots:false})).replace(/(\sshadowrootmode=")[^"]*"/,'$1'+shadow_mode(root)+'"'),end=native.indexOf('>');
        let target;
        if(xml){target=attach.call(copy,{mode:'open'});projections.push({host:copy,root:target,header:native.slice(0,end+1)});}
        else{
          const container=create.call(inert,'http://www.w3.org/1999/xhtml','div');element_inner.set.call(container,native.slice(0,end+1)+'</template>');
          const projection=children.call(container)[0];append.call(copy,projection);target=content.call(projection);
        }
        pairs.push([root,target]);copies.set(root,target);shadowTask=[root,target];
      }else if(options.opaque?.has(node)){
        const value=options.opaque.get(node);
        if(content_type.call(document)==='text/html'){
          const text=inert.createTextNode(value);raw.add(text);append.call(copy,text);
        }else{
          const end=value.indexOf('>')+1,target=attach.call(copy,{mode:'open'});
          shadow_inner.set.call(target,value.slice(end,value.lastIndexOf('</template>')));
          projections.push({host:copy,root:target,header:value.slice(0,end)});
        }
      }
    }
    const template=kind.call(node)===1&&namespace.call(node)==='http://www.w3.org/1999/xhtml'&&local.call(node)==='template';
    const from=template?content.call(node):node,to=template?content.call(copy):copy,next=[];
    for(const child of children.call(from)){const target=shallow(child);append.call(to,target);next.push([child,target]);}
    for(let index=next.length-1;index>=0;index--)stack.push(next[index]);
    if(shadowTask)stack.push(shadowTask);
  }
  for(let index=pairs.length-1;index>=0;index--)copy_resource_node(pairs[index][0],pairs[index][1],true,false,true);
  return {root,document,html:!xml,scripting:!!view.call(document),nodeScripting:scripting,empty:fragment.call(inert),raw,copies,projections,rawParent:create.call(inert,'http://www.w3.org/1999/xhtml','script')};
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
  return {...adapter,getParentNode(node){if(state.raw.has(node))return state.rawParent;const parent=adapter.getParentNode(node);return parent&&adapter.isElementNode(parent)&&adapter.getTagName(parent)==='noscript'&&!state.nodeScripting.get(parent)?state.empty:parent;}};
}
function serialize_snapshot(state,root=state.root,outer=false,getHTML=false){
  if(!state.html){
    if(getHTML)return xml_shadow_markup(state,root);
    if(kind.call(root)===11)return native_serialize.call(new NativeSerializer(),root);
    return (outer?element_outer:element_inner).get.call(root);
  }
  const options={treeAdapter:contextual_adapter(state),scriptingEnabled:state.scripting};
  return outer?serializeOuter(root,options):serialize(root,options);
}
function xml_shadow_markup(state,root){
  const method=kind.call(root)===11?shadow_getHTML:element_getHTML,options=native_options({serializableShadowRoots:false,shadowRoots:state.projections.map(value=>value.root)});
  let result=method.call(root,options);if(!state.projections.length)return result;
  let marker;do{marker='data-sandstone-serialize-'+serialization_sequence++;}while(result.includes(marker)||state.projections.some(value=>value.header.includes(marker)));
  for(let index=0;index<state.projections.length;index++)if(state.projections[index].host!==root)set.call(state.projections[index].host,null,marker,String(index));
  result=method.call(root,options);
  for(let index=0;index<state.projections.length;index++){
    const projection=state.projections[index],attribute=' '+marker+'="'+index+'"';
    const position=projection.host===root?0:result.indexOf(attribute);if(position<0)continue;
    const offset=projection.host===root?0:result.indexOf('>',position)+1;
    if(!result.startsWith('<template',offset))continue;
    const end=result.indexOf('>',offset)+1,header=result.slice(offset,end);
    // Native XML shadow serialization manages namespace scope across the
    // projection. Preserve those declarations while restoring source flags.
    const flags=projection.header.match(/\s+shadowroot[a-z-]*(?:="[^"]*")?/g)||[];
    const restored=header.replace(/\s+shadowroot[a-z-]*(?:="[^"]*")?/g,'').slice(0,-1)+flags.join('')+'>';
    result=result.slice(0,offset)+restored+result.slice(end);
  }
  for(let index=0;index<state.projections.length;index++){result=result.split(' '+marker+'="'+index+'"').join('');remove.call(state.projections[index].host,null,marker);}
  return result;
}
function native_options(options){
  return {serializableShadowRoots:options.serializableShadowRoots,shadowRoots:{[Symbol.iterator](){let index=0;return {next(){return index<options.shadowRoots.length?{value:options.shadowRoots[index++],done:false}:{value:undefined,done:true};}};}}};
}
function shadow_markup(value,locations=false){
  const tree=parseFragment(value,{scriptingEnabled:true,sourceCodeLocationInfo:locations});let count=0;
  const pending=[tree];while(pending.length){const node=pending.pop();if(node.tagName==='template'&&node.namespaceURI==='http://www.w3.org/1999/xhtml'&&node.attrs.some(attribute=>attribute.name==='shadowrootmode'))count++;for(const child of node.childNodes||[])pending.push(child);if(node.content)pending.push(node.content);}
  return {tree,count};
}
function opaque_roots(source,value,options,state){
  const opaque=new Map(),pending=[[source,value]],selected=new Set(options.shadowRoots);
  const native=native_options(options),empty=native_options({serializableShadowRoots:false,shadowRoots:[]});
  const body=node=>(kind.call(node)===11?shadow_getHTML:element_getHTML).call(node,native);
  const missing=(node,value)=>shadow_markup(value).count>shadow_markup(serialize_snapshot(state,state.copies.get(node),false,true)).count;
  while(pending.length){
    const [node,html]=pending.pop();let remaining=html,root=kind.call(node)===1?shadow_root(node):null;
    if(kind.call(node)===1&&!root){
      const parsed=shadow_markup(html,true).tree,first=parsed.childNodes[0];
      if(first?.tagName==='template'&&first.attrs.some(attribute=>attribute.name==='shadowrootmode')&&parsed.childNodes.length>shadow_markup(element_getHTML.call(node,empty)).tree.childNodes.length){
        const end=first.sourceCodeLocation.endOffset;opaque.set(node,html.slice(0,end));remaining=html.slice(end);
      }
    }
    if(!missing(node,remaining))continue;
    const template=kind.call(node)===1&&namespace.call(node)==='http://www.w3.org/1999/xhtml'&&local.call(node)==='template';
    for(const child of children.call(template?content.call(node):node))if(kind.call(child)===1){const value=body(child);if(missing(child,value))pending.push([child,value]);}
    if(root&&(selected.has(root)||options.serializableShadowRoots&&shadow_serializable?.call(root))){const value=body(root);if(missing(root,value))pending.push([root,value]);}
  }
  return opaque;
}
function markup(source,outer,shadows,raw){
  let state=snapshot(source,shadows),result=serialize_snapshot(state,state.root,outer,!!shadows);
  if(shadows&&(shadows.serializableShadowRoots||shadows.shadowRoots.length)&&shadow_markup(raw).count>shadow_markup(result).count){
    // Native declarative closed roots may have no JavaScript reference yet.
    // Preserve their exact native projection while restoring accessible nodes.
    const opaque=opaque_roots(source,raw,shadows,state);
    if(opaque.size){state=snapshot(source,{...shadows,opaque});result=serialize_snapshot(state,state.root,outer,true);}
  }
  return result;
}
function capture_options(input){
  const captured={serializableShadowRoots:false,shadowRoots:[]};
  if(input===null||typeof input!=='object'&&typeof input!=='function')return {value:input,captured};
  const records=[];
  const value={get serializableShadowRoots(){const value=Reflect.get(input,'serializableShadowRoots',input);captured.serializableShadowRoots=!!value;return value;},get shadowRoots(){
    const iterable=Reflect.get(input,'shadowRoots',input);
    if(iterable===null||typeof iterable!=='object'&&typeof iterable!=='function')return iterable;
    return {[Symbol.iterator](){
      const iterator=Reflect.apply(iterable[Symbol.iterator],iterable,[]);
      if(iterator===null||typeof iterator!=='object'&&typeof iterator!=='function')return iterator;
      const next=iterator.next;
      return {next(...args){
        const result=Reflect.apply(next,iterator,args);
        if(result===null||typeof result!=='object'&&typeof result!=='function')return result;
        const record={};records.push(record);
        return new Proxy(result,{get(target,key){const value=Reflect.get(target,key,target);if(key==='value')record.value=value;else if(key==='done')record.done=!!value;return value;}});
      },get return(){const close=iterator.return;return typeof close==='function'?function(...args){return Reflect.apply(close,iterator,args);}:close;}};
    }};
  }};
  return {value,captured,finish(){captured.shadowRoots=records.filter(record=>!record.done).map(record=>record.value);}};
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
  for(const [prototype,native] of [[E,element_getHTML],[globalThis.ShadowRoot?.prototype,shadow_getHTML]])if(native){
    prototype.getHTML=new Proxy(native,{apply(target,receiver,args){
      const options=capture_options(args[0]),converted=[...args];if(args.length)converted[0]=options.value;
      const raw=Reflect.apply(target,receiver,converted);options.finish?.();
      return markup(receiver,false,options.captured,raw);
    }});
  }
}
