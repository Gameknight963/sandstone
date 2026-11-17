import {parseFragment} from 'parse5';
import {parsing_context} from './scripting_html.mjs';
import {remember_declarative_root,shadow_root} from './shadow_roots.mjs';
import {native_attach_shadow as attach} from './dom_operations.mjs';

const html='http://www.w3.org/1999/xhtml',E=globalThis.Element?.prototype,N=globalThis.Node?.prototype;
const get=E?.getAttribute,has=E?.hasAttribute,set=E?.setAttribute,remove=N?.removeChild,append=N?.appendChild;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get;
const parent=N&&Object.getOwnPropertyDescriptor(N,'parentNode').get;
let sequence=0;

// Keep declarations as ordinary templates until every closed root is reachable
// by the resource rewriter. Retaining the attribute name lets the native
// sanitizer decide whether a declaration is allowed, without extra attributes.
export function defer_declarative_roots(context,value){
  if(!/shadowrootmode/i.test(value))return {value,restore(){}};
  const parsed=parseFragment(parsing_context(context),value,{scriptingEnabled:true,sourceCodeLocationInfo:true}),edits=[],modes=new Map(),pending=[parsed];
  let marker;do{marker='sandstone-shadow-'+sequence+++'-';}while(value.includes(marker));
  while(pending.length){
    const node=pending.pop(),attribute=node.attrs?.find(value=>value.name==='shadowrootmode'&&!value.namespace),mode=attribute?.value.toLowerCase();
    if(node.namespaceURI===html&&node.tagName==='template'&&(mode==='open'||mode==='closed')){
      const location=node.sourceCodeLocation?.attrs?.shadowrootmode;
      if(location){const key=marker+modes.size;modes.set(key,attribute.value);edits.push({start:location.startOffset,end:location.endOffset,value:'shadowrootmode="'+key+'"'});}
    }
    for(const child of node.childNodes||[])pending.push(child);
    if(node.content)pending.push(node.content);
  }
  edits.sort((a,b)=>b.start-a.start);for(const edit of edits)value=value.slice(0,edit.start)+edit.value+value.slice(edit.end);
  return {value,restore(container){
    const pending=[container];
    while(pending.length){
      const node=pending.pop();
      if(node instanceof HTMLTemplateElement){
        const original=modes.get(get.call(node,'shadowrootmode'));
        if(original!==undefined){
          set.call(node,'shadowrootmode',original);
          const host=parent.call(node);
          if(host instanceof Element&&host!==container&&!shadow_root(host)){
            let root;
            try{root=attach.call(host,{mode:original.toLowerCase(),delegatesFocus:has.call(node,'shadowrootdelegatesfocus'),clonable:has.call(node,'shadowrootclonable'),serializable:has.call(node,'shadowrootserializable'),slotAssignment:get.call(node,'shadowrootslotassignment')==='manual'?'manual':'named',referenceTarget:get.call(node,'shadowrootreferencetarget')});}catch{}
            if(root){remember_declarative_root(host,root,!has.call(node,'shadowrootcustomelementregistry'));for(const child of [...children.call(node.content)])append.call(root,child);remove.call(host,node);pending.push(root);continue;}
          }
        }
        pending.push(node.content);
      }
      const next=[...children.call(node)];for(let index=next.length-1;index>=0;index--)pending.push(next[index]);
    }
  }};
}
