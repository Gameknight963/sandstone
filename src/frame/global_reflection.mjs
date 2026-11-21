// Window's unforgeable accessor descriptors cannot be changed by a Proxy's
// getOwnPropertyDescriptor trap. Adapt the public reflection functions instead,
// without changing descriptors seen by the engine's Proxy-invariant checks.
const apply=Reflect.apply,ownKeys=Reflect.ownKeys,has=Reflect.has,get=Reflect.get;
const describe=Reflect.getOwnPropertyDescriptor;
const create=Object.create,objectDefine=Object.defineProperty;
const mapGet=WeakMap.prototype.get,setAdd=Set.prototype.add,setDelete=Set.prototype.delete,setValues=Set.prototype.values;
const deref=typeof WeakRef==='function'&&WeakRef.prototype.deref;
const views=new WeakMap();
// Same-origin frames can borrow each other's Object/Reflect methods and Window
// getters. Share alias lookup with an accessible parent before page code runs.
function reflection_group(){
  const registries=new Set();
  return {
    // Construct weak references in the group's owning realm. A reference with
    // a discarded child's prototype would itself keep that child's realm alive.
    register(registry){apply(setAdd,registries,[deref?new WeakRef(registry):registry]);},
    lookup(value){
      for(const reference of apply(setValues,registries,[])){
        const registry=deref?apply(deref,reference,[]):reference;
        if(!registry){apply(setDelete,registries,[reference]);continue;}
        const view=apply(mapGet,registry,[value]);if(view)return view;
      }
    }
  };
}
let group;
try{
  const parent=globalThis.parent;
  if(parent&&parent!==globalThis){parent.document;group=parent.sandstone_frame?.context.get_global_reflection_group?.();}
}catch{group=undefined;}
if(!group)group=reflection_group();
group.register(views);
export const get_global_reflection_group=()=>group;
const lookup=value=>apply(mapGet,views,[value])||group.lookup(value);
export const global_accessor_view=value=>lookup(value)?.accessor;
const key=value=>ownKeys({[value]:null})[0];
function descriptor(value){
  if(value===null||typeof value!=='object'&&typeof value!=='function')throw new TypeError('Property description must be an object');
  const result=create(null);
  for(const name of ['enumerable','configurable','value','writable','get','set'])if(has(value,name)){
    const field=get(value,name);
    if((name==='get'||name==='set')&&field!==undefined&&typeof field!=='function')throw new TypeError(name+' must be a function');
    result[name]=['enumerable','configurable','writable'].includes(name)?!!field:field;
  }
  if(('get'in result||'set'in result)&&('value'in result||'writable'in result))throw new TypeError('An accessor descriptor cannot have a value or writable flag');
  return result;
}
let installed=false;
export function register_global_reflection(value,view){
  views.set(value,view);
  if(installed)return;installed=true;
  const replace=(object,name,handler)=>{
    const property=describe(object,name);
    objectDefine(object,name,{...property,value:new Proxy(property.value,{apply:handler})});
  };
  for(const object of [Object,Reflect])replace(object,'getOwnPropertyDescriptor',(method,receiver,args)=>{
    const view=lookup(args[0]);if(!view?.describe)return apply(method,receiver,args);
    return view.describe(key(args[1]));
  });
  replace(Object,'getOwnPropertyDescriptors',(method,receiver,args)=>{
    const result=apply(method,receiver,args),view=lookup(args[0]);
    if(view?.describe)for(const name of ownKeys(result))if('get'in result[name]||'set'in result[name])result[name]=view.describe(name);
    return result;
  });
  for(const object of [Object,Reflect])replace(object,'defineProperty',(method,receiver,args)=>{
    const view=lookup(args[0]);if(!view?.define)return apply(method,receiver,args);
    const name=key(args[1]),input=descriptor(args[2]),success=view.define(name,input);
    if(object===Reflect)return success;
    if(!success)throw new TypeError('Cannot redefine property: '+String(name));
    return args[0];
  });
  replace(Object,'defineProperties',(method,receiver,args)=>{
    const view=lookup(args[0]);if(!view?.define)return apply(method,receiver,args);
    if(args[1]===null||args[1]===undefined)throw new TypeError('Cannot convert undefined or null to object');
    const properties=Object(args[1]),entries=[];
    for(const name of ownKeys(properties))if(describe(properties,name)?.enumerable)entries.push([name,descriptor(get(properties,name))]);
    for(const [name,input] of entries)if(!view.define(name,input))throw new TypeError('Cannot redefine property: '+String(name));
    return args[0];
  });
}
