import {register_global_reflection,global_accessor_view} from './global_reflection.mjs';
// Binding a global method must not write .call/.apply onto the original function:
// window.addEventListener can share that function with EventTarget.prototype.
const native_targets=new WeakMap();
const native_bindings=new WeakMap();
const virtual_accessor_functions=new WeakMap();
const native_function_targets=new WeakMap();
export function unwrap_global_function(value){while(native_function_targets.has(value))value=native_function_targets.get(value);return value;}
export function bind_native_property(proxy,key){native_bindings.get(proxy)?.(key);}
export function bind_declared_property(proxy,key){native_bindings.get(proxy)?.(key,true);}
const scope_targets=new WeakMap();
// Keep template-engine locals and intrinsic direct eval in native lexical
// scopes, with virtual globals as their outer fallback environment.
export function create_global_scope(context,names,globals=context){
  const keys=new Set(names.filter(name=>name!=='eval'));
  const scope=new Proxy(Object.create(null),{
    has:(_,key)=>keys.has(key),
    get:(_,key)=>key===Symbol.unscopables?undefined:Reflect.get(globals,key,globals),
    set:(_,key,value)=>Reflect.set(globals,key,value,globals)
  });
  native_targets.set(scope,unwrap_global_target(context));
  scope_targets.set(scope,context);
  return scope;
}
export function scope_global(value){return scope_targets.get(value);}
// Bare globals must use the same receiver adapter as window.method. Frameworks
// commonly save a native method with .bind(globalThis), whose virtual Window
// does not satisfy the browser's native receiver checks.
export function global_method_names(target){
  const names=new Set();
  for(let object=target;object&&object!==Object.prototype;object=Object.getPrototypeOf(object)){
    for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))){
      const value=descriptor.value;
      if(name!=='constructor'&&!name.startsWith('__')&&typeof value==='function'&&!value.prototype)names.add(name);
    }
  }
  return [...names];
}
export function unwrap_global_target(value){return native_targets.get(value)||value;}
export function bind_global_function(target, method, virtual_target) {
  const bound=new Proxy(method, {
    apply(method, receiver, args) {
      if (receiver === virtual_target || receiver === undefined || receiver === null || native_targets.get(receiver)===target) receiver = target;
      return Reflect.apply(method, receiver, args);
    }
  });
  native_function_targets.set(bound,method);return bound;
}

export function create_obj_proxy(obj, ctx_vars, target, map_value,read_native,write_native,{virtual_accessors=false,read_accessor=read_native}={}) {
  const methods = new WeakMap(),overrides=new Map(),deleted=new Set(),accessors=new Map(),generated_accessors=new Map(),live=new Set();
  const originalOwn=new Set(Reflect.ownKeys(target));
  const descriptor=(object,key)=>{while(object){const found=Reflect.getOwnPropertyDescriptor(object,key);if(found)return found;object=Reflect.getPrototypeOf(object);}};
  const remember=value=>{if(typeof value==='function'&&!methods.has(value))methods.set(value,value);return value;};
  // Overlay class constructors describe the adapter, not the native object.
  // Explicit constructor overrides remain supported like other virtual slots.
  const replacement_allowed=key=>key!=='constructor'||ctx_vars.includes(key)||Object.hasOwn(obj,key);
  const read=(key,receiver=proxy)=>{
      const fixed=Reflect.getOwnPropertyDescriptor(target,key);
      if(fixed&&!fixed.configurable){
        if('value'in fixed&&!fixed.writable)return fixed.value;
        if(!('value'in fixed)&&!fixed.get)return undefined;
      }
      if(live.has(key)){
        const value=read_native?read_native(key):target[key];
        return remember(map_value?map_value(value,key):value);
      }
      const override=overrides.get(key);
      if(override)return remember('value'in override?override.value:override.get?.call(receiver));
      if(!deleted.has(key)&&replacement_allowed(key)){
        const replacement = obj[key];
        if (replacement !== undefined || key in obj) return remember(replacement);
      }
      const native_value = read_native?read_native(key):target[key];
      const value = map_value ? map_value(native_value,key) : native_value;
      // Event-handler getters expose the assigned callback, even for arrows
      // and native functions. They are callback values, not global methods.
      if(typeof value==='function'&&typeof key==='string'&&key.startsWith('on'))return value;
      if (typeof value === 'function' && methods.has(value))return methods.get(value);
      if (typeof value === 'function' && !value.prototype) {
        // Sites patch globals after first use. Cache by function identity so a
        // replacement takes effect, and restoring a method restores its wrapper.
        if (!methods.has(value)) {
          const bound = bind_global_function(target, value, proxy);
          methods.set(value, bound);
          methods.set(bound, bound);
        }
        return methods.get(value);
      }
      return value;
  };
  const own=(key,reflected=false)=>{
    const native=Reflect.getOwnPropertyDescriptor(target,key),override=overrides.get(key);
    if(live.has(key))return native&&'value'in native?{...native,value:read(key)}:native;
    if(native&&!native.configurable&&('value'in native||!reflected))return 'value'in native&&native.writable?{...native,value:read(key)}:native;
    if(!native&&!Reflect.isExtensible(target))return;
    if(override)return {...override};
    if(!native)return;
    if('value'in native)return {...native,value:read(key)};
    if(deleted.has(key)||!replacement_allowed(key))return native;
    let implementation=key in obj?descriptor(obj,key):undefined;
    if(!implementation&&virtual_accessors){
      implementation=generated_accessors.get(key);
      if(!implementation||implementation.nativeGet!==native.get||implementation.nativeSet!==native.set){
        implementation={nativeGet:native.get,nativeSet:native.set,
          get:()=>read_accessor?read_accessor(key):native.get&&Reflect.apply(native.get,target,[]),
          set:value=>write_native?write_native(key,value,proxy):native.set&&Reflect.apply(native.set,target,[value])};
        generated_accessors.set(key,implementation);
      }
    }
    if(!implementation)return native;
    let cached=accessors.get(key);
    if(!cached||cached.nativeGet!==native.get||cached.nativeSet!==native.set||cached.get!==implementation.get||cached.set!==implementation.set||cached.value!==implementation.value){
      const adapt=(method,operation,kind)=>{
        if(!method)return;
        const wrapped=new Proxy(method,{apply(fn,receiver,args){
        if(receiver===proxy||receiver===target||virtual_accessors&&receiver==null)return operation(...args);
        const view=virtual_accessors&&global_accessor_view(receiver);
        if(view)return kind==='get'?view.get(key):view.set(key,args[0]);
        return Reflect.apply(fn,unwrap_global_target(receiver),args);
        }});
        virtual_accessor_functions.set(wrapped,method);return wrapped;
      };
      cached={nativeGet:native.get,nativeSet:native.set,...implementation,
        getter:adapt(native.get,()=>implementation.get?implementation.get.call(obj):implementation.value,'get'),
        setter:adapt(native.set,value=>implementation.set?implementation.set.call(obj,value):Reflect.set(target,key,value,target),'set')};
      accessors.set(key,cached);
    }
    return {...native,get:cached.getter,set:cached.setter};
  };
  const keys=()=>{
    const native=Reflect.ownKeys(target);if(!Reflect.isExtensible(target))return native;
    const all=[...new Set([...native,...overrides.keys()])],indices=[],strings=[],symbols=[];
    for(const key of all){
      if(typeof key==='symbol'){symbols.push(key);continue;}
      const index=Number(key);
      if(Number.isInteger(index)&&index>=0&&index<2**32-1&&String(index)===key)indices.push(key);
      else strings.push(key);
    }
    return [...indices.sort((a,b)=>Number(a)-Number(b)),...strings,...symbols];
  };
  const define=(key,input)=>{
    const physical=Reflect.getOwnPropertyDescriptor(target,key);
    // A native declaration can replace an old configurable virtual accessor
    // with fixed writable data. Installing an explicit value never needs to
    // observe that accessor while checking the new descriptor.
    const current=physical&&!physical.configurable&&Object.hasOwn(input,'value')?physical:own(key),scratch=Object.create(null);
    if(current)Reflect.defineProperty(scratch,key,current);
    if(!Reflect.defineProperty(scratch,key,input))return false;
    const complete=Reflect.getOwnPropertyDescriptor(scratch,key);
    const virtual=overrides.has(key)||ctx_vars.includes(key)||!deleted.has(key)&&replacement_allowed(key)&&key in obj;
    // Fixed descriptors must agree with the real Proxy target. Configurable
    // virtual slots can stay separate from native APIs used by the runtime.
    const fixed=Reflect.getOwnPropertyDescriptor(target,key);
    if(live.has(key)||!virtual||!complete.configurable||!physical&&Reflect.has(target,key)){
      if(!Reflect.defineProperty(target,key,complete))return false;
    }else if(!Reflect.getOwnPropertyDescriptor(target,key)&&!Reflect.isExtensible(target))return false;
    if(live.has(key)){overrides.delete(key);deleted.delete(key);return true;}
    if(virtual){if(!fixed||fixed.configurable||'value'in fixed)overrides.set(key,complete);deleted.delete(key);}
    return true;
  };
  const proxy = new Proxy(target, {
    get: (_, key, receiver) => read(key,receiver),
    getOwnPropertyDescriptor:(_,key)=>own(key),
    ownKeys:keys,
    has:(_,key)=>overrides.has(key)||Reflect.has(target,key),
    defineProperty:(_,key,input)=>define(key,input),
    deleteProperty:(_,key)=>{
      const current=own(key);if(current&&!current.configurable)return false;
      if(!Reflect.deleteProperty(target,key))return false;
      overrides.delete(key);
      if(originalOwn.has(key)&&key in obj)deleted.add(key);
      return true;
    },
    set: (_, key, value,receiver) => {
      if(receiver!==proxy&&receiver!==target){
        const fixed=Reflect.getOwnPropertyDescriptor(target,key),current=fixed&&!fixed.configurable?fixed:overrides.get(key)||descriptor(target,key),scratch=Object.create(null);
        if(current)Reflect.defineProperty(scratch,key,current);
        return Reflect.set(scratch,key,value,receiver);
      }
      if(live.has(key)){
        const assigned=write_native?write_native(key,value,proxy):Reflect.set(target,key,value,target);
        if(assigned){remember(value);deleted.delete(key);}return assigned;
      }
      const override=overrides.get(key);
      if(override){
        if(!('value'in override)){if(!override.set)return false;override.set.call(receiver,value);return true;}
        if(!override.writable)return false;
        return define(key,{value});
      }
      if(ctx_vars.includes(key)){
        const native=descriptor(target,key),virtual=deleted.has(key)?undefined:descriptor(obj,key);
        if(native&&('value'in native?!native.writable:!native.set))return false;
        if(virtual?.set){virtual.set.call(obj,value);return true;}
        if(virtual&&'value'in virtual&&virtual.writable)Reflect.set(obj,key,value,obj);
        return define(key,Reflect.has(target,key)&&Reflect.getOwnPropertyDescriptor(target,key)?{value}:{value,writable:true,enumerable:true,configurable:true});
      }
      const assigned=write_native?write_native(key,value,proxy):Reflect.set(target,key,value,target);
      if(assigned)remember(value);
      return assigned;
    },
    preventExtensions:()=>{
      for(const key of overrides.keys())if(!Reflect.getOwnPropertyDescriptor(target,key)&&!Reflect.defineProperty(target,key,own(key)))return false;
      if(!Reflect.preventExtensions(target))return false;
      for(const key of Reflect.ownKeys(target))if(!Reflect.defineProperty(target,key,own(key)))return false;
      return true;
    }
  });
  native_targets.set(proxy,target);
  if(virtual_accessors){
    const view={get(key){const implementation=descriptor(obj,key);return implementation?.get?implementation.get.call(obj):implementation&&'value'in implementation?implementation.value:read_accessor?read_accessor(key):read(key);},
      set(key,value){const implementation=descriptor(obj,key);return implementation?.set?implementation.set.call(obj,value):write_native?write_native(key,value,proxy):Reflect.set(target,key,value,target);}};
    register_global_reflection(target,{accessor:view});
    register_global_reflection(proxy,{accessor:view,describe:key=>own(key,true),define(key,input){
      const physical=Reflect.getOwnPropertyDescriptor(target,key),normalized={...input};
      if(physical&&!physical.configurable)for(const name of ['get','set']){
        const original=virtual_accessor_functions.get(input[name]);
        if(original&&original===physical[name])normalized[name]=original;
      }
      return define(key,normalized);
    }});
  }
  // A published global declaration remains a native variable binding. Raw
  // identifier writes, property writes and later descriptors share that slot.
  native_bindings.set(proxy,(key,declared=false)=>{
    if(declared&&(originalOwn.has(key)||!Reflect.getOwnPropertyDescriptor(target,key)))return;
    live.add(key);overrides.delete(key);deleted.delete(key);accessors.delete(key);
  });
  return proxy;
}
