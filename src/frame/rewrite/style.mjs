import {ctx} from '../context.mjs';
import {parse_css} from './css.mjs';
import {prepare_css, restore_css, edit_css_parts, css_references} from '../css.mjs';

const states = new WeakMap();
const node_markers = new WeakMap();
const data = globalThis.CharacterData && Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
const getAttribute = globalThis.Element?.prototype.getAttribute;
const setAttribute = globalThis.Element?.prototype.setAttribute;
const removeAttribute = globalThis.Element?.prototype.removeAttribute;
let active = false, sequence = 0;
const supports = condition => CSS.supports(condition) || CSS.supports(`(${condition})`);
const text_nodes = element => [...element.childNodes].filter(node => node.nodeType === 3 || node.nodeType === 4);

function write(nodes, values) {
  for (let i = 0; i < nodes.length; i++) if (data.get.call(nodes[i]) !== values[i]) data.set.call(nodes[i], values[i]);
}

// Only declarations still containing our markers receive the resolved URLs.
function fill_rules(sheet, replacements) {
  for (const rule of [...sheet.cssRules]) {
    if (rule.style) {
      for (const name of [...rule.style]) {
        const before = rule.style.getPropertyValue(name);
        const after = restore_css(before, replacements);
        if (before !== after) rule.style.setProperty(name, after, rule.style.getPropertyPriority(name));
      }
    }
    if (rule.cssRules) fill_rules(rule, replacements);
    if (globalThis.CSSImportRule && rule instanceof CSSImportRule && replacements.has(rule.href)) {
      const index = [...sheet.cssRules].indexOf(rule);
      const css = restore_css(rule.cssText, replacements);
      sheet.deleteRule(index); sheet.insertRule(css, index);
    }
  }
}

function update(element) {
  let state = states.get(element);
  if (!state) states.set(element, state = {generation: 0, markers: new Map()});
  const nodes = text_nodes(element);
  let parts = nodes.map(node => data.get.call(node));
  if (state.nodes?.length === nodes.length && nodes.every((node, i) => node === state.nodes[i] && parts[i] === state.safe[i])) return;
  const generation = ++state.generation;
  const markers = new Map(state.markers);
  for (const node of nodes) for (const entry of node_markers.get(node) || []) markers.set(...entry);
  parts = restore_css(parts.join(''), markers, edits => edit_css_parts(parts, edits), true);
  const source = parts.join('');
  const prepared = prepare_css(source, 'sandstone-style-' + ++sequence + '-', supports);
  state.markers = prepared.markers;
  const safe = edit_css_parts(parts, prepared.edits);
  state.nodes = nodes;
  state.safe = safe;
  write(nodes, safe);
  for (const node of nodes) node_markers.set(node, state.markers);
  state.pending = undefined;
  if (!prepared.markers.size) return;
  state.pending = Promise.resolve(parse_css(source, ctx.document.baseURI, (source, edits) => edit_css_parts(parts, edits))).then(resolved => {
    if (state.generation !== generation) return;
    if (nodes.some((node, i) => node.parentNode !== element || data.get.call(node) !== safe[i])) return;
    const unchanged = state.sheetSnapshot === snapshot(element);
    if (unchanged) {
      with_disabled([element], () => write(nodes, resolved));
      state.safe = resolved;
      state.markers = new Map();
      const original = css_references(source), rewritten = css_references(resolved.join(''));
      for (let i = 0; i < original.length; i++) if (original[i].ending && rewritten[i]) state.markers.set(rewritten[i].url, original[i].url);
      for (const node of nodes) node_markers.set(node, state.markers);
    } else if (element.sheet) {
      // DOM text replacement recreates the sheet. Hydrate its current rules in
      // place instead if insertRule/declaration edits occurred during the fetch.
      const before = css_references(prepared.css), after = css_references(resolved.join(''));
      const replacements = new Map();
      for (let i = 0; i < before.length; i++) if (prepared.markers.has(before[i].url) && after[i]) replacements.set(before[i].url, after[i].url);
      fill_rules(element.sheet, replacements);
    }
  }).catch(console.error);
}

function snapshot(element) {
  return element.sheet ? [...element.sheet.cssRules].map(rule => rule.cssText).join('\n') : null;
}

function with_disabled(elements, operation) {
  const types = elements.map(element => getAttribute.call(element, 'type'));
  const disabled = elements.map(element => element.sheet?.disabled);
  for (const element of elements) setAttribute.call(element, 'type', 'text/sandstone-pending');
  try { return operation(); }
  finally {
    for (let i = 0; i < elements.length; i++) {
      if (types[i] === null) removeAttribute.call(elements[i], 'type');
      else setAttribute.call(elements[i], 'type', types[i]);
      if (disabled[i] !== undefined && elements[i].sheet) elements[i].sheet.disabled = disabled[i];
    }
  }
}

export function mutate_styles(nodes, operation) {
  if (active || !data) return operation();
  const elements = new Set();
  function collect(node, deep) {
    if (node?.nodeType === 1 && node.localName === 'style') elements.add(node);
    if (node?.parentNode?.localName === 'style') elements.add(node.parentNode);
    if (deep && node?.querySelectorAll) for (const style of node.querySelectorAll('style')) elements.add(style);
  }
  nodes.forEach((node, index) => collect(node, index > 0));
  if (!elements.size) return operation();
  active = true;
  try {
    return with_disabled([...elements], () => {
      try { return operation(); }
      finally { for (const element of elements) update(element); }
    });
  } finally {
    active = false;
    for (const element of elements) states.get(element).sheetSnapshot = snapshot(element);
  }
}

export function rewrite_style(element) {
  mutate_styles([element], () => {});
  return states.get(element)?.pending;
}
export function clone_style(source,copy){
  const state=states.get(source);if(!state)return;
  const nodes=text_nodes(source),targets=text_nodes(copy),parts=nodes.map(node=>data.get.call(node)),markers=new Map(state.markers);
  for(const node of nodes)for(const entry of node_markers.get(node)||[])markers.set(...entry);
  const restored=restore_css(parts.join(''),markers,edits=>edit_css_parts(parts,edits),true);
  if(targets.length===restored.length)write(targets,restored);
}
