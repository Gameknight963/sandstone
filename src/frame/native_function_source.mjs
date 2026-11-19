// Capture before either Function adapter installs its public toString wrapper.
export const stringify_function=Function.prototype.toString;
export const apply_function=Reflect.apply;
