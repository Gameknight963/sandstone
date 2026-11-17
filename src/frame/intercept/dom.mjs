import * as rewrite from "../rewrite/index.mjs";
import { proxy_function, get_dom_property } from "../context.mjs";
import * as loader from "../loader.mjs";
import {mutate_styles as mutate_style_sources} from '../rewrite/style.mjs';
import {mutate_document_base} from '../document_base.mjs';
import {reconcile_iframes} from '../iframe_lifecycle.mjs';
const mutate_styles=(nodes,operation)=>mutate_document_base(()=>mutate_style_sources(nodes,operation));

function prepare(node) {
  const pending = rewrite.element(node);
  pending?.catch(console.error);
}

function execute(node) {
  if (!loader.is_loaded) return;
  if (typeof node?.__sandstone_execute__ === "function") node.__sandstone_execute__();
  for (const child of get_dom_property(node, "children") || []) execute(child);
}

function intercept(target, key, first_only = false) {
  if (!target || typeof target[key] !== "function") return;
  proxy_function(target, key, (original, receiver, args) => {
    const nodes = first_only ? args.slice(0, 1) : args;
    // A fragment is empty after insertion; retain its children for execution.
    const inserted = nodes.flatMap(node => node?.nodeType === 11 ? [...node.childNodes] : [node]);
    const result = mutate_styles([receiver, ...nodes], () => {
      for (const node of nodes) prepare(node);
      return Reflect.apply(original, receiver, args);
    });
    for (const node of inserted) {reconcile_iframes(node);execute(node);}
    return result;
  });
}

if (globalThis.Node) {
  for (const key of ["appendChild", "insertBefore", "replaceChild"]) intercept(Node.prototype, key, true);
  for (const target of [globalThis.Element?.prototype, globalThis.Document?.prototype, globalThis.DocumentFragment?.prototype]) {
    for (const key of ["append", "prepend", "replaceChildren"]) intercept(target, key);
  }
  for (const target of [Element.prototype, CharacterData.prototype]) {
    for (const key of ["before", "after", "replaceWith"]) intercept(target, key);
  }
  proxy_function(Element.prototype, 'insertAdjacentText', (original, receiver, args) => mutate_styles([receiver], () => Reflect.apply(original, receiver, args)));
  for (const prototype of [Node.prototype, globalThis.CharacterData?.prototype, Element.prototype]) {
    for (const key of prototype === Node.prototype ? ['removeChild', 'normalize'] : ['before', 'after', 'replaceWith', 'remove']) {
      if (!Object.hasOwn(prototype, key)) continue;
      const original = prototype[key];
      prototype[key] = function(...args) {
        return mutate_styles([this, ...(key === 'normalize' ? [this] : args)], () => Reflect.apply(original, this, args));
      };
    }
  }
  for (const [prototype, keys] of [[Node.prototype, ['textContent', 'nodeValue']], [CharacterData.prototype, ['data']], [HTMLElement.prototype, ['innerText']]]) {
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(prototype, key);
      Object.defineProperty(prototype, key, {...property, set(value) {
        return mutate_styles([this], () => property.set.call(this, value));
      }});
    }
  }
  if (globalThis.Range) {
    for (const key of ['deleteContents', 'extractContents', 'insertNode', 'surroundContents']) {
      const original = Range.prototype[key];
      Range.prototype[key] = function(...args) {
        return mutate_styles([this.commonAncestorContainer, ...args], () => Reflect.apply(original, this, args));
      };
    }
  }
  for (const [prototype, keys] of [[CharacterData.prototype, ['appendData', 'insertData', 'deleteData', 'replaceData']], [Text.prototype, ['splitText']]]) {
    for (const key of keys) {
      const original = prototype[key];
      prototype[key] = function(...args) {
        return mutate_styles([this], () => Reflect.apply(original, this, args));
      };
    }
  }

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
        mutate_styles([this], () => descriptor.set.call(this, value));
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
