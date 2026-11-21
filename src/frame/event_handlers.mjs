export function define_event_handlers(prototype, types, {validate,state=()=>new WeakMap()}={}) {
  for (const type of types) {
    const slots = state(type);
    Object.defineProperty(prototype, 'on' + type, {
      enumerable: true, configurable: true,
      get() { validate?.(this);return slots.get(this)?.value || null; },
      set(value) {
        validate?.(this);
        if(!arguments.length)throw new TypeError('A handler value is required');
        const slot = slots.get(this) || {value: null, listener: event => {
          const callback=slots.get(this)?.value;
          if(callback&&Reflect.apply(callback,this,[event])===false)event.preventDefault();
        }};
        slots.set(this, slot);
        value = typeof value === 'function' ? value : null;
        if (!slot.value && value) EventTarget.prototype.addEventListener.call(this, type, slot.listener);
        if (slot.value && !value) EventTarget.prototype.removeEventListener.call(this, type, slot.listener);
        slot.value = value;
      }
    });
  }
}
