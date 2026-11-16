export function define_event_handlers(prototype, types) {
  for (const type of types) {
    const slots = new WeakMap();
    Object.defineProperty(prototype, 'on' + type, {
      enumerable: true, configurable: true,
      get() { return slots.get(this)?.value || null; },
      set(value) {
        const slot = slots.get(this) || {value: null, listener: event => slots.get(this)?.value?.call(this, event)};
        slots.set(this, slot);
        value = typeof value === 'function' ? value : null;
        if (!slot.value && value) EventTarget.prototype.addEventListener.call(this, type, slot.listener);
        if (slot.value && !value) EventTarget.prototype.removeEventListener.call(this, type, slot.listener);
        slot.value = value;
      }
    });
  }
}
