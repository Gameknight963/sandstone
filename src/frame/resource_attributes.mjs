const sources=new WeakMap();
const orders=new WeakMap();
const set=globalThis.Element?.prototype.setAttribute,remove=globalThis.Element?.prototype.removeAttribute;
const attributes=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'attributes').get;
const getNode=globalThis.Element?.prototype.getAttributeNode;
const removeNode=globalThis.Element?.prototype.removeAttributeNode,setNode=globalThis.Element?.prototype.setAttributeNodeNS;
export function remember_attribute_order(element,fields){
  let order=orders.get(element);if(!order){order={names:[...attributes.call(element)].map(node=>node.name),fields:new Set()};orders.set(element,order);}
  for(const field of fields)order.fields.add(field);
}
export function resource_attribute(element,name,read){remember_attribute_order(element,[name]);let fields=sources.get(element);if(!fields){fields=new Map();sources.set(element,fields);}fields.set(name,read);}
export function copy_resource_attributes(source,copy,serializing=false){
  for(const [name,read] of sources.get(source)||[]){const value=read();if(value===null)remove.call(copy,name);else set.call(copy,name,value);}
  if(!serializing)return;
  const order=orders.get(source);if(!order)return;
  const nodes=[...attributes.call(copy)];
  for(const field of order.fields){
    const original=order.names.indexOf(field),node=getNode.call(copy,field);
    if(original<0||!node)continue;
    nodes.splice(nodes.indexOf(node),1);
    const following=order.names.slice(original+1).map(name=>nodes.findIndex(node=>node.name===name)).find(index=>index>=0);
    const preceding=order.names.slice(0,original).reverse().map(name=>nodes.findIndex(node=>node.name===name)).find(index=>index>=0);
    nodes.splice(following??(preceding===undefined?0:preceding+1),0,node);
  }
  for(const node of [...attributes.call(copy)])removeNode.call(copy,node);
  for(const node of nodes)setNode.call(copy,node);
}
export function capture_resource_attributes(source){
  const values=[...sources.get(source)||[]].map(([name,read])=>[name,read()]);
  return copy=>{for(const [name,value] of values)if(value===null)remove.call(copy,name);else set.call(copy,name,value);};
}
