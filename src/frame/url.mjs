// Keep native URL instances and their prototype shared with static parsers.
// Only argument conversion and relocation of internal resource URLs differ.
export function create_url_constructor(NativeURL,resolve){
  const construct=Reflect.construct,apply=Reflect.apply;
  const describe=Object.getOwnPropertyDescriptor,define=Object.defineProperty;
  const arguments_for=args=>{
    if(!args.length)return args;
    const result=[...args];
    // Web IDL uses the string hint and rejects Symbols. Convert each argument
    // once, in order, before looking up a possibly relocated blob URL.
    result[0]=resolve(`${args[0]}`);
    if(args.length>1&&args[1]!==undefined)result[1]=resolve(`${args[1]}`);
    return result;
  };
  const URL=new Proxy(NativeURL,{construct(target,args,newTarget){return construct(target,arguments_for(args),newTarget)}});
  for(const key of ['parse','canParse']){
    const descriptor=describe(NativeURL,key);
    if(typeof descriptor?.value!=='function')continue;
    const method=new Proxy(descriptor.value,{apply(target,receiver,args){return apply(target,receiver,arguments_for(args))}});
    define(NativeURL,key,{...descriptor,value:method});
  }
  define(NativeURL.prototype,'constructor',{...describe(NativeURL.prototype,'constructor'),value:URL});
  return URL;
}
