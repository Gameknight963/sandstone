const N=globalThis.Node?.prototype;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get;
const kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const data=globalThis.CharacterData&&Object.getOwnPropertyDescriptor(CharacterData.prototype,'data').get;

// Script source is child text content, including CDATA, rather than the text
// of descendant elements. Preserve the authored DOM and read native slots.
export function script_text(node){
  return [...children.call(node)].filter(child=>[3,4].includes(kind.call(child))).map(child=>data.call(child)).join('');
}
