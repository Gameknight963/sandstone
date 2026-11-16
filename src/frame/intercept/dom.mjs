import * as rewrite from "../rewrite/index.mjs";
import { proxy_function } from "../context.mjs";
import * as loader from "../loader.mjs";

function prepare(node) {
  const pending = rewrite.element(node);
  pending?.catch(console.error);
}

function execute(node) {
  if (!loader.is_loaded) return;
  node?.__sandstone_execute__?.();
  for (const child of node?.children || []) execute(child);
}

function intercept(target, key, first_only = false) {
  if (!target || typeof target[key] !== "function") return;
  proxy_function(target, key, (original, receiver, args) => {
    const nodes = first_only ? args.slice(0, 1) : args;
    // A fragment is empty after insertion; retain its children for execution.
    const inserted = nodes.flatMap(node => node?.nodeType === 11 ? [...node.childNodes] : [node]);
    for (const node of nodes) prepare(node);
    const result = Reflect.apply(original, receiver, args);
    for (const node of inserted) execute(node);
    return result;
  });
}

if (globalThis.Node) {
  for (const key of ["appendChild", "insertBefore", "replaceChild"]) intercept(Node.prototype, key, true);
  for (const target of [globalThis.Element?.prototype, globalThis.Document?.prototype, globalThis.DocumentFragment?.prototype]) {
    for (const key of ["append", "prepend", "replaceChildren"]) intercept(target, key);
  }
  for (const key of ["before", "after", "replaceWith"]) intercept(Element.prototype, key);

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const replace = Element.prototype.replaceChildren;
  function fragment(value) {
    const template = document.createElement("template");
    descriptor.set.call(template, value);
    for (const script of template.content.querySelectorAll("script")) script.__sandstone_inert__ = true;
    prepare(template.content);
    return template.content;
  }
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...descriptor,
    set(value) {
      if (["SCRIPT", "STYLE", "TEXTAREA", "TEMPLATE"].includes(this.tagName)) {
        descriptor.set.call(this, value);
        return;
      }
      const content = fragment(value);
      Reflect.apply(replace, this, [content]);
    }
  });
  Element.prototype.insertAdjacentHTML = function(position, value) {
    const content = fragment(value);
    switch (String(position).toLowerCase()) {
      case "beforebegin": this.before(content); break;
      case "afterbegin": this.prepend(content); break;
      case "beforeend": this.append(content); break;
      case "afterend": this.after(content); break;
      default: throw new DOMException("Invalid position", "SyntaxError");
    }
  };
}

if (globalThis.Image) {
  globalThis.Image = new Proxy(globalThis.Image, {
    construct(target, args) {
      const image = Reflect.construct(target, args);
      prepare(image);
      return image;
    }
  });
}
