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
  return index;
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
      if ((imported || image) && source[end - 1] === character) {
        references.push({start: index, end, url: decode_css(source.slice(index + 1, end - 1)), imported, quoted: true,
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
      if (at) { imported = name === "import"; namespace = name === "namespace"; continue; }
      if (source[index] !== "(") { imported = false; continue; }
      if (name !== "url") { functions.push(name); index++; imported = false; continue; }
      const url_start = skip_space(source, index + 1);
      let end = url_start;
      let url;
      if (source[end] === '"' || source[end] === "'") {
        const string_start = end;
        end = string_end(source, end);
        if (source[end - 1] === source[string_start]) url = decode_css(source.slice(string_start + 1, end - 1));
        end = skip_space(source, end);
      } else {
        while (end < source.length && source[end] !== ")" && !whitespace(source[end])) {
          if (source[end] === "\\") end = escape_end(source, end);
          else if (/["'(]/.test(source[end])) break;
          else end++;
        }
        url = decode_css(source.slice(url_start, end));
        end = skip_space(source, end);
      }
      if (!namespace && source[end] === ")" && url !== undefined) references.push({start, end: end + 1, url, imported, quoted: false,
        ...(imported ? import_supports(source, end + 1) : {})});
      imported = false;
      index = end + Number(source[end] === ")");
      continue;
    }
    if (character === "(") functions.push("");
    if (character === ")") functions.pop();
    if (character === ";") namespace = false;
    imported = false;
    index++;
  }
  // URL syntax inside a supports() test is a feature query, not a resource load.
  const conditions = references.filter(reference => reference.condition);
  return references.filter(reference => !conditions.some(condition => reference.start >= condition.condition_start && reference.end <= condition.condition_end));
}

const empty_resource = "data:application/octet-stream,";
const empty_stylesheet = "data:text/css,";
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
    edits.push({start: reference.start, end: reference.end, value: reference.quoted ? JSON.stringify(url) : `url(${JSON.stringify(url)})`});
  }
  for (const {start, end, value} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + value + source.slice(end);
  return {css: source, markers};
}

export function restore_css(source, markers) {
  const references = css_references(source);
  for (let index = references.length - 1; index >= 0; index--) {
    const {start, end, url, quoted} = references[index];
    if (!markers.has(url)) continue;
    const value = JSON.stringify(markers.get(url));
    source = source.slice(0, start) + (quoted ? value : `url(${value})`) + source.slice(end);
  }
  return source;
}

export function rewrite_css(source, base, {fetch, createURL, supports}, ancestors = new Set()) {
  source = String(source);
  const references = css_resource_references(source);
  if (!references.length) return source;
  const pending = new Map();
  const replacements = references.map(reference => {
    if (reference.condition && supports) {
      reference.supported = supports(reference.condition);
      if (!reference.supported) return Promise.resolve(empty_stylesheet);
    }
    let url;
    try { url = new URL(reference.url, base); } catch { return Promise.resolve(reference.imported ? empty_stylesheet : empty_resource); }
    const hash = url.hash;
    url.hash = "";
    const key = `${reference.imported}:${url.href}`;
    if (!pending.has(key)) pending.set(key, (async () => {
      try {
        if (reference.imported && ancestors.has(url.href)) return empty_stylesheet;
        const response = await fetch(url.href);
        if (!response.ok) return reference.imported ? empty_stylesheet : empty_resource;
        const final = response.url || url.href;
        let blob;
        if (reference.imported) {
          if (ancestors.has(final)) return empty_stylesheet;
          const next = new Set([...ancestors, url.href, final]);
          const css = await rewrite_css(await response.text(), final, {fetch, createURL, supports}, next);
          blob = new Blob([css], {type: "text/css"});
        } else blob = await response.blob();
        return createURL(blob, final);
      } catch { return reference.imported ? empty_stylesheet : empty_resource; }
    })());
    return pending.get(key).then(value => value + (value.startsWith("blob:") ? hash : ""));
  });
  return Promise.all(replacements).then(values => {
    const edits = [];
    for (let index = 0; index < references.length; index++) {
      const {start, end, quoted} = references[index];
      const value = JSON.stringify(values[index]);
      edits.push({start, end, value: quoted ? value : `url(${value})`});
      if (references[index].supported) edits.push({start: references[index].condition_start, end: references[index].condition_end, value: ""});
    }
    for (const {start, end, value} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + value + source.slice(end);
    return source;
  });
}
