import {parse_referrer_policy} from '../referrer.mjs';
import {decode_stylesheet_response} from '../text_encoding.mjs';
import {encoding_parse_url} from '../url_encoding.mjs';

const whitespace = character => /[\t\n\f\r ]/.test(character || "\0");
const name_character = character => /[\w\u0080-\uffff-]/.test(character || "\0");

function escape_end(source, index) {
  index++;
  if (/[\da-f]/i.test(source[index] || "z")) {
    let count = 0;
    while (count++ < 6 && /[\da-f]/i.test(source[index] || "z")) index++;
    if (source[index] === "\r" && source[index + 1] === "\n") return index + 2;
    return index + Number(whitespace(source[index]));
  }
  return index + (source[index] === "\r" && source[index + 1] === "\n" ? 2 : 1);
}

export function decode_css(value) {
  return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\r\f]|([^\n\r\f]))/gi, (_, hex, character) => {
    if (!hex) return character || "";
    const code = parseInt(hex, 16);
    return !code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff ? "\ufffd" : String.fromCodePoint(code);
  });
}

function string_end(source, index) {
  const quote = source[index++];
  while (index < source.length) {
    if (source[index] === quote) return index + 1;
    if (/[\n\r\f]/.test(source[index])) return index;
    index = source[index] === "\\" ? escape_end(source, index) : index + 1;
  }
  return Math.min(index, source.length);
}

function skip_space(source, index) {
  while (index < source.length) {
    if (whitespace(source[index])) index++;
    else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else break;
  }
  return index;
}

function import_supports(source, index) {
  while (index < source.length) {
    index = skip_space(source, index);
    const start = index;
    while (name_character(source[index]) || source[index] === "\\") index = source[index] === "\\" ? escape_end(source, index) : index + 1;
    const name = decode_css(source.slice(start, index)).toLowerCase();
    if (!["layer", "supports"].includes(name)) return {};
    if (source[index] !== "(") {
      if (name === "layer") continue;
      return {};
    }
    const content = ++index;
    let depth = 1;
    while (index < source.length && depth) {
      const next = skip_space(source, index);
      if (next !== index) { index = next; continue; }
      if (source[index] === '"' || source[index] === "'") { index = string_end(source, index); continue; }
      if (source[index] === "\\") { index = escape_end(source, index); continue; }
      if (source[index] === "(") depth++;
      if (source[index] === ")") depth--;
      index++;
    }
    if (depth) return {};
    if (name === "supports") return {condition: source.slice(content, index - 1), condition_start: start, condition_end: index};
  }
  return {};
}

// Preserve @import layers, supports() and media conditions while replacing URLs.
export function css_references(source) {
  const references = [];
  const functions = [];
  const blocks = [];
  let font_block = false, descriptor = '';
  let index = 0;
  let imported = false;
  let namespace = false;
  while (index < source.length) {
    const start = index;
    index = skip_space(source, index);
    if (index !== start) continue;
    const character = source[index];
    if (character === '"' || character === "'") {
      const end = string_end(source, index);
      const image = ["image-set", "-webkit-image-set"].includes(functions.at(-1));
      const closed = source[end - 1] === character;
      if ((imported || image) && (closed || end === source.length)) {
        references.push({start: index, end, url: decode_css(source.slice(index + 1, closed ? end - 1 : end)), imported, quoted: true,
          ...(!closed ? {ending: 'quote'} : {}),
          ...(imported ? import_supports(source, end) : {})});
      }
      imported = false;
      index = end;
      continue;
    }
    if (character === "@" || name_character(character) || character === "\\") {
      const at = character === "@";
      if (at) index++;
      const name_start = index;
      while (name_character(source[index]) || source[index] === "\\") index = source[index] === "\\" ? escape_end(source, index) : index + 1;
      const name = decode_css(source.slice(name_start, index)).toLowerCase();
      if (at) { imported = name === "import"; namespace = name === "namespace"; font_block = name === 'font-face'; continue; }
      if (blocks.at(-1) && source[skip_space(source, index)] === ':') descriptor = name;
      if (source[index] !== "(") { imported = false; continue; }
      if (name !== "url") { functions.push(name); index++; imported = false; continue; }
      const url_start = skip_space(source, index + 1);
      let end = url_start;
      let url;
      let ending, trailing = '';
      if (source[end] === '"' || source[end] === "'") {
        const string_start = end;
        end = string_end(source, end);
        const closed = source[end - 1] === source[string_start];
        if (closed || end === source.length) url = decode_css(source.slice(string_start + 1, closed ? end - 1 : end));
        end = skip_space(source, end);
        if (end === source.length) ending = closed ? 'parenthesis' : 'string';
      } else {
        while (end < source.length && source[end] !== ")" && !whitespace(source[end])) {
          if (source[end] === "\\") end = escape_end(source, end);
          else if (/["'(]/.test(source[end])) break;
          else end++;
        }
        url = decode_css(source.slice(url_start, end));
        const token_end = end;
        end = skip_space(source, end);
        if (end >= source.length) { ending = 'unquoted'; trailing = source.slice(token_end, end); }
      }
      if (!namespace && (source[end] === ")" || ending) && url !== undefined) references.push({start, end: Math.min(end + 1, source.length), url, imported, quoted: false,
        ...(blocks.at(-1) && descriptor === 'src' ? {font: true} : {}),
        ...(ending ? {ending, trailing} : {}),
        ...(imported ? import_supports(source, end + 1) : {})});
      imported = false;
      index = end + Number(source[end] === ")");
      continue;
    }
    if (character === "(") functions.push("");
    if (character === ")") functions.pop();
    if (character === '{') { blocks.push(font_block); font_block = false; descriptor = ''; }
    if (character === '}') { blocks.pop(); font_block = false; descriptor = ''; }
    if (character === ";") { namespace = false; font_block = false; descriptor = ''; }
    imported = false;
    index++;
  }
  // URL syntax inside a supports() test is a feature query, not a resource load.
  const conditions = references.filter(reference => reference.condition);
  return references.filter(reference => !conditions.some(condition => reference.start >= condition.condition_start && reference.end <= condition.condition_end));
}

const empty_resource = "data:application/octet-stream,";
const empty_stylesheet = "data:text/css,";
function resource_token(reference, url) {
  const value = JSON.stringify(url);
  if (reference.quoted) return reference.ending === 'quote' ? value.slice(0, -1) : value;
  if (reference.ending === 'unquoted') return 'url(' + url.replace(/[\s"'()\\]/g, character => '\\' + character.charCodeAt(0).toString(16) + ' ') + (reference.trailing || '');
  if (reference.ending === 'string') return 'url(' + value.slice(0, -1);
  if (reference.ending === 'parenthesis') return 'url(' + value;
  return `url(${value})`;
}
export function css_resource_references(source) {
  return css_references(String(source)).filter(reference => {
    if (!reference.url || reference.url.startsWith("#")) return false;
    return reference.imported || !/^(data|blob):/i.test(reference.url);
  });
}

// Synchronous CSSOM operations need valid, local placeholders until the relay
// finishes. Preserve token boundaries so comments, strings and data URLs survive.
export function prepare_css(source, prefix, supports) {
  source = String(source);
  const markers = new Map();
  const edits = [];
  for (const reference of css_resource_references(source)) {
    let url;
    if (reference.condition && supports && !supports(reference.condition)) url = empty_stylesheet;
    else {
      url = (reference.imported ? 'data:text/css,/*' : empty_resource) + prefix + markers.size + (reference.imported ? '*/' : '');
      markers.set(url, reference.url);
      if (reference.condition && supports) edits.push({start: reference.condition_start, end: reference.condition_end, value: ''});
    }
    edits.push({start: reference.start, end: reference.end, value: resource_token(reference, url)});
  }
  for (const {start, end, value} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + value + source.slice(end);
  return {css: source, markers, edits};
}

export function restore_css(source, markers, transform, prefixes = false) {
  const references = css_references(source);
  const edits = [];
  for (let index = references.length - 1; index >= 0; index--) {
    const reference = references[index], {start, end, url} = reference;
    const key = markers.has(url) ? url : prefixes ? [...markers.keys()].find(key => url.startsWith(key)) : undefined;
    if (key === undefined) continue;
    const replacement = resource_token(reference, markers.get(key) + url.slice(key.length));
    edits.push({start, end, value: replacement});
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return transform ? transform(edits) : source;
}

// Keep unaffected prefixes/suffixes in their original text nodes. A token
// replacement belongs to the node containing its first character.
export function edit_css_parts(parts, edits) {
  const offsets = [0];
  for (const part of parts) offsets.push(offsets.at(-1) + part.length);
  const output = parts.map(() => '');
  let cursor = 0, index = 0;
  const seek = position => {
    while (index < parts.length - 1 && offsets[index + 1] <= position) index++;
  };
  const copy = end => {
    seek(cursor);
    while (cursor < end && index < parts.length) {
      const last = Math.min(end, offsets[index + 1]);
      output[index] += parts[index].slice(cursor - offsets[index], last - offsets[index]);
      cursor = last;
      if (cursor < end) index++;
    }
    seek(end);
  };
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    copy(edit.start);
    if (parts.length) output[index] += edit.value;
    cursor = edit.end;
  }
  copy(offsets.at(-1));
  return output;
}

export function rewrite_css(source, base, {fetch, createURL, supports, transform, request, importPolicy, fontFace,encoding='UTF-8'}, ancestors = new Set()) {
  source = String(source);
  const references = css_resource_references(source);
  if (!references.length) return transform ? transform(source, []) : source;
  const pending = new Map();
  const replacements = references.map(reference => {
    if (reference.condition && supports) {
      reference.supported = supports(reference.condition);
      if (!reference.supported) return Promise.resolve(empty_stylesheet);
    }
    let url;
    try { url = encoding_parse_url(reference.url, base,reference.imported?'UTF-8':encoding); } catch { return Promise.resolve(reference.imported ? empty_stylesheet : empty_resource); }
    const hash = url.hash;
    url.hash = "";
    const font = !!(reference.font || fontFace);
    const key = `${reference.imported}:${font}:${url.href}`;
    if (!pending.has(key)) pending.set(key, (async () => {
      try {
        if (reference.imported && ancestors.has(url.href)) return empty_stylesheet;
        const options = {...request,destination:font?'font':reference.imported?'style':'image',
          ...(font?{mode:'cors',credentials:'same-origin'}:{}),
          ...(reference.imported&&importPolicy?{referrerPolicy:importPolicy}:{})};
        const response = await fetch(url.href, options);
        if (!response.ok) return reference.imported ? empty_stylesheet : empty_resource;
        const final = response.url || url.href;
        let blob;
        if (reference.imported) {
          if (ancestors.has(final)) return empty_stylesheet;
          const next = new Set([...ancestors, url.href, final]);
          const policy = response.headers.get('referrer-policy');
          const child_request = {...request, referrer: final, referrerPolicy: parse_referrer_policy(policy)};
          const child_import_policy = parse_referrer_policy(policy, importPolicy || request?.referrerPolicy);
          const decoded=await decode_stylesheet_response(response,encoding);
          const css = await rewrite_css(decoded.text, final, {fetch, createURL, supports, request: child_request, importPolicy: child_import_policy,encoding:decoded.encoding}, next);
          blob = new Blob([css], {type: "text/css;charset=utf-8"});
          return createURL(blob, final, {...child_request, importPolicy: child_import_policy,encoding:decoded.encoding});
        } else blob = await response.blob();
        return createURL(blob, final);
      } catch { return reference.imported ? empty_stylesheet : empty_resource; }
    })());
    return pending.get(key).then(value => value + (value.startsWith("blob:") ? hash : ""));
  });
  return Promise.all(replacements).then(values => {
    const edits = [];
    for (let index = 0; index < references.length; index++) {
      const {start, end} = references[index];
      edits.push({start, end, value: resource_token(references[index], values[index])});
      if (references[index].supported) edits.push({start: references[index].condition_start, end: references[index].condition_end, value: ""});
    }
    if (transform) return transform(source, edits);
    for (const {start, end, value} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + value + source.slice(end);
    return source;
  });
}
