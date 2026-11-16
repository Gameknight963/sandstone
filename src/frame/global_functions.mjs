// Binding a global method must not write .call/.apply onto the original function:
// window.addEventListener can share that function with EventTarget.prototype.
export function bind_global_function(target, method, virtual_target) {
  return new Proxy(method, {
    apply(method, receiver, args) {
      if (receiver === virtual_target || receiver === undefined || receiver === null) receiver = target;
      return Reflect.apply(method, receiver, args);
    }
  });
}
