import {range_points} from './intercept/ranges.mjs';
import {capture_resources,node_document,active_document} from './resource_nodes.mjs';
import {remember_shadow_root} from './shadow_roots.mjs';
import {with_dom_access} from './dom_operations.mjs';

const N=globalThis.Node?.prototype,E=globalThis.Element?.prototype,R=globalThis.Range?.prototype;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get,kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const namespace=E&&Object.getOwnPropertyDescriptor(E,'namespaceURI').get,local=E&&Object.getOwnPropertyDescriptor(E,'localName').get;
const attributes=E&&Object.getOwnPropertyDescriptor(E,'attributes').get;
const attributeName=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'name').get,attributeNamespace=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'namespaceURI').get;
const length=globalThis.NamedNodeMap&&Object.getOwnPropertyDescriptor(NamedNodeMap.prototype,'length').get,item=globalThis.NamedNodeMap?.prototype.item;
const Serializer=globalThis.XMLSerializer,serialize=Serializer?.prototype.serializeToString;
const contains=N?.contains,copyContents=R?.cloneContents,intersects=R?.intersectsNode,getRoot=N?.getRootNode;
const shadowHost=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;

function signature(node){
  const type=kind.call(node);if(type!==1)return ''+type;
  const map=attributes.call(node),values=[],serializer=new Serializer();
  // XMLSerializer emits an Attr's value; its name and namespace matter too.
  for(let index=0;index<length.call(map);index++){const attribute=item.call(map,index);values.push(JSON.stringify([attributeNamespace.call(attribute),attributeName.call(attribute),serialize.call(serializer,attribute)]));}
  return JSON.stringify([namespace.call(node),local.call(node),values.sort()]);
}
function compatible(source,copy){return kind.call(source)===kind.call(copy)&&(kind.call(source)!==1||namespace.call(source)===namespace.call(copy)&&local.call(source)===local.call(copy));}
function shape(node){return kind.call(node)===1?JSON.stringify([1,namespace.call(node),local.call(node)]):''+kind.call(node);}
export function capture_range_copy(range,extract=false){
  const points=range_points(range),originals=new Set();
  const plan=node=>{
    originals.add(node);
    const partial=contains.call(node,points.start)||contains.call(node,points.end),moved=extract&&!partial,restore=moved?null:capture_resources(node,true);
    const descendants=[...children.call(node)].filter(child=>!partial||intersects.call(range,child)).map(plan);
    return {source:node,signature:moved?null:signature(node),shape:shape(node),moved,restore,children:descendants};
  };
  const nodes=points.collapsed?[]:[3,4,7,8].includes(kind.call(points.common))?[plan(points.common)]:[...children.call(points.common)].filter(node=>intersects.call(range,node)).map(plan);
  return {points,nodes,originals};
}
export function restore_range_copy(snapshot,copy,inactive=false,prime=false){
  function restore(plans,targets){
    const used=new Set(),identities=new Set(targets);let signatures,shapes;
    const add=(map,key,node)=>{let bucket=map.get(key);if(!bucket){bucket={nodes:[],index:0};map.set(key,bucket);}bucket.nodes.push(node);};
    const take=bucket=>{while(bucket&&bucket.index<bucket.nodes.length){const node=bucket.nodes[bucket.index++];if(!used.has(node))return node;}};
    for(const plan of plans){
      if(plan.moved){if(identities.has(plan.source))used.add(plan.source);continue;}
      if(!signatures){
        signatures=new Map();shapes=new Map();
        // Original nodes already carry their own state. Reserve them even if a
        // callback has rearranged the returned fragment or inserted originals.
        for(const node of targets)if(!snapshot.originals.has(node)){add(signatures,signature(node),node);add(shapes,shape(node),node);}
      }
      const node=take(signatures.get(plan.signature))||take(shapes.get(plan.shape));
      if(!node)continue;used.add(node);
      plan.restore(node,inactive,prime);restore(plan.children,[...children.call(node)]);
    }
  }
  restore(snapshot.nodes,[...children.call(copy)]);return copy;
}
export function perform_range_copy(snapshot,operation){
  // Native reactions can inspect the fragment before the DOM API returns.
  // HTML constructor and virtual-this hooks restore metadata at that boundary.
  let restored;
  const sourceRoot=getRoot.call(snapshot.points.common);
  const inactive=!active_document(node_document(snapshot.points.common));
  return with_dom_access(element=>{
    if(restored)return;
    let root;try{root=getRoot.call(element);}catch{return;}
    while(shadowHost&&kind.call(root)===11){
      let host;try{host=shadowHost.call(root);}catch{break;}
      remember_shadow_root(host,root);root=getRoot.call(host);
    }
    if(kind.call(root)!==11||root===sourceRoot)return;
    const targets=[...children.call(root)];
    if(!snapshot.nodes.length||targets.length<snapshot.nodes.length||!snapshot.nodes.every((plan,index)=>compatible(plan.source,targets[index])))return;
    restored=root;restore_range_copy(snapshot,root,inactive);
  },()=>{
    const result=operation();return result===restored?result:restore_range_copy(snapshot,result,inactive);
  });
}
export function clone_range_contents(range,args){const snapshot=capture_range_copy(range);return perform_range_copy(snapshot,()=>Reflect.apply(copyContents,range,args));}
