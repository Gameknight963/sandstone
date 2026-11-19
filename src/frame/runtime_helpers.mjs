const apply=Reflect.apply,describe=Reflect.getOwnPropertyDescriptor,prototype=Reflect.getPrototypeOf;
const create=Object.create,freeze=Object.freeze,define=Object.defineProperties;

// Compiled code uses immutable helper bindings; the site's Window remains a
// separate, mutable facade, including when it defines similarly named globals.
export function create_runtime_helpers(context,names){
  const descriptors=create(null);
  for(const name of names){
    let owner=context,descriptor;
    while(owner&&!(descriptor=describe(owner,name)))owner=prototype(owner);
    if(!descriptor)continue;
    if(typeof descriptor.value==='function'){
      const method=descriptor.value;
      descriptors[name]={value:(...args)=>apply(method,context,args)};
    }else if(descriptor.get){
      const getter=descriptor.get;
      descriptors[name]={get:()=>apply(getter,context,[])};
    }else descriptors[name]={value:descriptor.value};
  }
  return freeze(define(create(null),descriptors));
}
