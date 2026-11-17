// Binding a global method must not write .call/.apply onto the original function:
// window.addEventListener can share that function with EventTarget.prototype.
const native_targets=new WeakMap();
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
  return new Proxy(method, {
    apply(method, receiver, args) {
      if (receiver === virtual_target || receiver === undefined || receiver === null) receiver = target;
      return Reflect.apply(method, receiver, args);
    }
  });
}

export function create_obj_proxy(obj, ctx_vars, target, map_value) {
  const methods = new WeakMap();
  const proxy = new Proxy(target, {
    get: (_, key) => {
      const replacement = obj[key];
      if (replacement !== undefined || key in obj) return replacement;
      const native_value = target[key];
      const value = map_value ? map_value(native_value,key) : native_value;
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
    },
    set: (_, key, value) => {
      if (ctx_vars.includes(key)) obj[key] = value;
      else target[key] = value;
      return true;
    }
  });
  native_targets.set(proxy,target);
  return proxy;
}
