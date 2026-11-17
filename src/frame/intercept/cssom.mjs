import { ctx, get_dom_property } from '../context.mjs';
import * as network from '../network.mjs';
import { prepare_css, restore_css, css_references } from '../css.mjs';
import { parse_css } from '../rewrite/css.mjs';

const NativeSheet = globalThis.CSSStyleSheet;
const sheet_bases = new WeakMap();
let sequence = 0;
const supports = condition => CSS.supports(condition) || CSS.supports(`(${condition})`);

// Keep a native CSSStyleSheet instance: adoption, instanceof, rule identities and
// the browser's selector/media/cascade implementation continue to work normally.
export const FakeCSSStyleSheet = NativeSheet && new Proxy(NativeSheet, {
  construct(target, args, constructor) {
    const sheet = Reflect.construct(target, args, constructor);
    sheet_bases.set(sheet, new URL(args[0]?.baseURL || ctx.document.baseURI, ctx.document.baseURI).href);
    return sheet;
  }
});

if (globalThis.CSSStyleDeclaration && NativeSheet) {
  const prototype = CSSStyleDeclaration.prototype;
  const native = Object.fromEntries(['setProperty', 'removeProperty', 'getPropertyValue', 'getPropertyPriority', 'item'].map(key => [key, prototype[key]]));
  const text = Object.getOwnPropertyDescriptor(prototype, 'cssText');
  const parent = Object.getOwnPropertyDescriptor(prototype, 'parentRule');
  const length = Object.getOwnPropertyDescriptor(prototype, 'length');
  const nativeReplace = NativeSheet.prototype.replaceSync;
  const nativeInsert = NativeSheet.prototype.insertRule;
  const nativeDelete = NativeSheet.prototype.deleteRule;
  const raw_to_proxy = new WeakMap();
  const proxy_to_raw = new WeakMap();
  const unwrap = value => proxy_to_raw.get(value) || value;
  const sheet_base = sheet => sheet_bases.get(sheet) || network.known_urls[sheet?.href] || sheet?.href || ctx.document.baseURI;
  const declaration_base = declaration => sheet_base(parent.get.call(declaration)?.parentStyleSheet);
  const sheet_request = sheet => network.stylesheet_contexts[sheet?.href];
  const snapshot = (declaration, prefix) => {
    const result = new Map();
    for (let index = 0; index < length.get.call(declaration); index++) {
      const name = native.item.call(declaration, index);
      const value = native.getPropertyValue.call(declaration, name);
      if (value.includes(prefix)) result.set(name, value);
    }
    return result;
  };
  const apply = (declaration, expected, resolved) => {
    for (const [name, before] of expected) {
      if (native.getPropertyValue.call(declaration, name) !== before) continue;
      // A priority edit does not change which resource this placeholder owns.
      // Preserve the latest priority while filling in the relayed URL.
      const priority = native.getPropertyPriority.call(declaration, name);
      native.setProperty.call(declaration, name, native.getPropertyValue.call(resolved, name), priority);
    }
  };
  let scratch;
  function scratch_declaration() {
    if (!scratch) scratch = unwrap(document.createElement('span').style);
    text.set.call(scratch, '');
    return scratch;
  }

  function change(declaration, value, operation) {
    declaration = unwrap(declaration);
    const prefix = 'sandstone-css-' + ++sequence + '-';
    const prepared = prepare_css(value === null ? '' : value, prefix, supports);
    const result = operation(declaration, prepared.css);
    if (!prepared.markers.size) return result;
    const expected = snapshot(declaration, prefix);
    if (expected.size) {
      const accepted = restore_css(text.get.call(declaration), prepared.markers);
      const pending = parse_css(accepted, declaration_base(declaration), undefined, sheet_request(parent.get.call(declaration)?.parentStyleSheet));
      Promise.resolve(pending).then(css => {
        const resolved = scratch_declaration();
        text.set.call(resolved, css);
        apply(declaration, expected, resolved);
      }).catch(console.error);
    }
    return result;
  }
  function wrap(declaration) {
    if (raw_to_proxy.has(declaration)) return raw_to_proxy.get(declaration);
    const proxy = new Proxy(declaration, {
      get: (target, key) => Reflect.get(target, key, target),
      set(target, key, value) {
        if (key === 'cssText') { change(target, value, (target, css) => text.set.call(target, css)); return true; }
        const name = typeof key === 'string' ? key.replace(/[A-Z]/g, value => '-' + value.toLowerCase()).replace(/^webkit-/, '-webkit-') : '';
        if (name && name in target && CSS.supports(name, 'initial')) {
          return change(target, value, (target, css) => Reflect.set(target, key, css, target));
        }
        return Reflect.set(target, key, value, target);
      }
    });
    raw_to_proxy.set(declaration, proxy);
    proxy_to_raw.set(proxy, declaration);
    return proxy;
  }
  // Prototype calls must also accept the declaration proxy as their receiver.
  for (const key of ['getPropertyValue', 'getPropertyPriority', 'item', 'removeProperty']) {
    prototype[key] = function(...args) { return Reflect.apply(native[key], unwrap(this), args); };
  }
  prototype.setProperty = function(name, value = '', priority = '') {
    if (!arguments.length) return Reflect.apply(native.setProperty, unwrap(this), []);
    return change(this, value ?? '', (target, css) => native.setProperty.call(target, name, css, priority));
  };
  Object.defineProperty(prototype, 'cssText', {
    ...text, get() { return text.get.call(unwrap(this)); },
    set(value) { change(this, value, (target, css) => text.set.call(target, css)); }
  });
  // CSS property names live on native declaration instances, not the prototype.
  // Wrap style getters on elements and all native rules that expose declarations.
  const owners = [globalThis.HTMLElement, globalThis.SVGElement, globalThis.MathMLElement];
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!/^CSS.*Rule$/.test(key)) continue;
    const constructor = globalThis[key];
    if (constructor?.prototype) owners.push(constructor);
  }
  for (const owner of new Set(owners.filter(Boolean))) {
    const descriptor = Object.getOwnPropertyDescriptor(owner.prototype, 'style');
    if (!descriptor?.get) continue;
    Object.defineProperty(owner.prototype, 'style', {
      ...descriptor,
      get() { return wrap(descriptor.get.call(this)); },
      ...(descriptor.set ? {set(value) { change(descriptor.get.call(this), value, (target, css) => text.set.call(target, css)); }} : {})
    });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (arguments.length < 2) return Reflect.apply(setAttribute, this, arguments);
    if (String(name).toLowerCase() === 'style') {
      const declaration = get_dom_property(this, 'style');
      if (declaration) { change(declaration, value, (target, css) => text.set.call(target, css)); return; }
    }
    return Reflect.apply(setAttribute, this, arguments);
  };
  const setAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function(namespace, name, value) {
    if (arguments.length < 3) return Reflect.apply(setAttributeNS, this, arguments);
    if ((namespace === null || namespace === '') && String(name).toLowerCase() === 'style') return Element.prototype.setAttribute.call(this, name, value);
    return Reflect.apply(setAttributeNS, this, arguments);
  };

  function declarations(rules) {
    const result = [];
    for (const rule of rules) {
      const declaration = rule.style;
      if (declaration) result.push(unwrap(declaration));
      if (rule.cssRules) result.push(...declarations(rule.cssRules));
    }
    return result;
  }
  async function hydrate(rules, prepared, base, keyframe = false, request) {
    const originals = declarations(rules);
    const expected = originals.map(declaration => snapshot(declaration, prepared.prefix));
    if (!expected.some(value => value.size)) return;
    const accepted = restore_css(Array.from(rules, rule => rule.cssText).join('\n'), prepared.markers);
    const resolved = await parse_css(accepted, base, undefined, request);
    const sheet = new NativeSheet();
    nativeReplace.call(sheet, keyframe ? `@keyframes sandstone_pending {${resolved}}` : resolved);
    const replacements = declarations(sheet.cssRules);
    for (let index = 0; index < originals.length; index++) if (replacements[index]) apply(originals[index], expected[index], replacements[index]);
  }
  function prepare(source) {
    const prefix = 'sandstone-css-' + ++sequence + '-';
    return {...prepare_css(source, prefix, supports), prefix};
  }
  function intercept_insert(prototype, key, keyframe = false) {
    const original = prototype?.[key];
    if (!original) return;
    prototype[key] = function(source, ...args) {
      if (!arguments.length) return Reflect.apply(original, this, []);
      const prepared = prepare(source);
      const result = Reflect.apply(original, this, [prepared.css, ...args]);
      const rule = this.cssRules[keyframe ? this.cssRules.length - 1 : result];
      const base = sheet_base(this.parentStyleSheet || this);
      const request = sheet_request(this.parentStyleSheet || this);
      if (rule instanceof CSSImportRule && prepared.markers.size) {
        // Import rule hrefs are read-only. Replace this one only if it still exists;
        // index shifts and deletions during the request must not resurrect it.
        const accepted = restore_css(rule.cssText, prepared.markers);
        Promise.resolve(parse_css(accepted, base, undefined, request)).then(css => {
          const index = Array.from(this.cssRules).indexOf(rule);
          if (index < 0) return;
          const resolved = css_references(css).find(reference => reference.imported);
          const current = css_references(rule.cssText).find(reference => reference.imported && prepared.markers.has(reference.url));
          if (!resolved || !current) return;
          // media.mediaText is writable while the import is being relayed.
          // Replace its href without discarding a newer media condition.
          const replacement = restore_css(rule.cssText, new Map([[current.url, resolved.url]]));
          nativeDelete.call(this, index);
          nativeInsert.call(this, replacement, index);
        }).catch(console.error);
      } else if (rule) hydrate([rule], prepared, base, keyframe, request).catch(console.error);
      return result;
    };
  }
  intercept_insert(NativeSheet.prototype, 'insertRule');
  intercept_insert(globalThis.CSSGroupingRule?.prototype, 'insertRule');
  intercept_insert(globalThis.CSSKeyframesRule?.prototype, 'appendRule', true);
  if (nativeReplace) NativeSheet.prototype.replaceSync = function(source) {
    if (!arguments.length) return nativeReplace.call(this);
    const prepared = prepare(source);
    const result = nativeReplace.call(this, prepared.css);
    hydrate(Array.from(this.cssRules), prepared, sheet_base(this)).catch(console.error);
    return result;
  };
  const replace = NativeSheet.prototype.replace;
  if (replace) NativeSheet.prototype.replace = function(source) {
    if (!arguments.length) return replace.call(this);
    const prepared = prepare(source);
    return replace.call(this, prepared.css).then(async sheet => {
      await hydrate(Array.from(sheet.cssRules), prepared, sheet_base(sheet));
      return sheet;
    });
  };
}
