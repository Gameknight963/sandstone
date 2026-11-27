import {native_srcset_urls,native_rewrite_srcset} from '../native/css.mjs';

const space = character => /[\t\n\f\r ]/.test(character || "\0");

// HTML's srcset tokenizer: commas inside URLs (notably data URLs) are not
// separators. Leave descriptor validation and candidate selection to the browser.
// https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
export function srcset_urls(input) {
  input = String(input);
  const native=native_srcset_urls(input);if(native!==null)return native;
  const urls = [];
  let position = 0;
  while (position < input.length) {
    while (space(input[position]) || input[position] === ",") position++;
    if (position >= input.length) break;
    const start = position;
    while (position < input.length && !space(input[position])) position++;
    let end = position;
    while (input[end - 1] === ",") end--;
    if (end > start) urls.push({start, end, url: input.slice(start, end)});
    if (end !== position) continue;
    let parens = false;
    while (position < input.length) {
      const character = input[position++];
      if (parens) { if (character === ")") parens = false; }
      else if (character === "(") parens = true;
      else if (character === ",") break;
    }
  }
  return urls;
}

export async function rewrite_srcset(input, rewrite) {
  input = String(input);
  const references = srcset_urls(input);
  const urls = await Promise.all(references.map(reference => rewrite(reference.url)));
  const native=native_rewrite_srcset(input,urls);if(native!==null)return native.value;
  for (let index = references.length - 1; index >= 0; index--) {
    const {start, end} = references[index];
    input = input.slice(0, start) + urls[index] + input.slice(end);
  }
  return input;
}
