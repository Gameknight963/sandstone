// Global lexical cells belong to the realm, separately from Window properties.
// Authored accessors close over the native cells, including their TDZ and const
// restrictions. Registration runs only after native declaration instantiation.
export function create_global_bindings(context){
  const cells=new Map();
  const globals=new Proxy(Object.create(null),{
    get:(_,key)=>cells.has(key)?cells.get(key).get():Reflect.get(context,key,context),
    set:(_,key,value)=>{
      const cell=cells.get(key);if(cell){cell.set(value);return true}
      return Reflect.set(context,key,value,context);
    },
    has:(_,key)=>cells.has(key)||Reflect.has(context,key),
    deleteProperty:(_,key)=>cells.has(key)?false:Reflect.deleteProperty(context,key)
  });
  return {globals,has:name=>cells.has(name),declare(definitions){
    for(const name of Reflect.ownKeys(definitions)){
      const descriptor=Reflect.getOwnPropertyDescriptor(definitions,name);
      cells.set(name,{get:descriptor.get,set:descriptor.set});
    }
  }};
}
