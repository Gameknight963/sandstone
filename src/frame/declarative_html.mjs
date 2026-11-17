import {parse,parseFragment} from 'parse5';
import {parsing_context} from './scripting_html.mjs';
import {remember_declarative_root,remember_shadow_root,is_declarative_root,shadow_root} from './shadow_roots.mjs';
import {native_attach_shadow as attach} from './dom_operations.mjs';

const html='http://www.w3.org/1999/xhtml',E=globalThis.Element?.prototype,N=globalThis.Node?.prototype;
const get=E?.getAttribute,set=E?.setAttribute,remove=N?.removeChild,append=N?.appendChild,replace=N?.replaceChild,clone=N?.cloneNode;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get;
const parent=N&&Object.getOwnPropertyDescriptor(N,'parentNode').get;
const owner=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get;
const create=globalThis.Document?.prototype.createElementNS,native_set=E?.setHTMLUnsafe;
const native_parse=globalThis.Document?.parseHTMLUnsafe,adopt=globalThis.Document?.prototype.adoptNode;
const local=E&&Object.getOwnPropertyDescriptor(E,'localName').get;
const namespace=E&&Object.getOwnPropertyDescriptor(E,'namespaceURI').get;
const outer=E&&Object.getOwnPropertyDescriptor(E,'outerHTML').get;
const registry=E&&Object.getOwnPropertyDescriptor(E,'customElementRegistry')?.get;
const attributes=E&&Object.getOwnPropertyDescriptor(E,'attributes').get;
const remove_attribute_node=E?.removeAttributeNode,set_attribute_node=E?.setAttributeNodeNS;
const native_get=E?.getHTML,inner=E&&Object.getOwnPropertyDescriptor(E,'innerHTML').set;
const has=E?.hasAttribute,set_attribute=E?.setAttribute;
const remove_attribute=E?.removeAttribute,native_import=globalThis.Document?.prototype.importNode;
const root_registry=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'customElementRegistry')?.get;
const initialize=globalThis.CustomElementRegistry?.prototype.initialize;
const managed=new WeakMap();
let sequence=0;

function root_shell(host,template){
  const shell=clone.call(host,false);append.call(shell,clone.call(template,false));
  let replacement;
  if(local.call(host)==='body'){
    // Fragment parsing ignores a body start tag. Use a private full document,
    // then adopt its still-empty native declaration before moving any content.
    replacement=native_parse.call(Document,outer.call(shell)).body;
    adopt.call(owner.call(host),replacement);
  }else{
    const holder=create.call(owner.call(host),html,'div',{customElementRegistry:registry?.call(host)});
    native_set.call(holder,outer.call(shell));replacement=children.call(holder)[0];
  }
  // HTML serialization cannot retain every DOM attribute namespace or NUL.
  // Restore the exact native attributes before exposing the replacement node.
  for(const attribute of [...attributes.call(replacement)])remove_attribute_node.call(replacement,attribute);
  for(const attribute of attributes.call(host))set_attribute_node.call(replacement,clone.call(attribute,false));
  return {host:replacement,root:attach.call(replacement,{mode:get.call(template,'shadowrootmode').toLowerCase()})};
}

// Importing first into an inert document keeps native custom-element
// construction deferred. Rebuild managed roots there, where closed native
// copies would otherwise hide their resources from the preparation walk.
export function import_declarative_host(source,copy,source_root){
  const metadata=managed.get(source_root);if(!metadata)return copy;
  const existing=shadow_root(copy);
  if(existing){managed.set(existing,metadata);if(is_declarative_root(source_root))remember_declarative_root(copy,existing);return copy;}
  const projection=native_get.call(source,{shadowRoots:[source_root]});let end=0,quote='';
  for(;end<projection.length;end++){const c=projection[end];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>'){end++;break;}}
  const holder=create.call(owner.call(copy),html,'div');inner.call(holder,projection.slice(0,end)+'</template>');
  const template=children.call(holder)[0];if(metadata.keepNull)set_attribute.call(template,'shadowrootcustomelementregistry','');else remove_attribute.call(template,'shadowrootcustomelementregistry');
  const result=root_shell(copy,template);managed.set(result.root,metadata);
  const source_registry=root_registry?.call(source_root);
  if(source_registry&&initialize&&!root_registry.call(result.root)){
    // Scoped registries can be retained in inert documents. Global registries
    // instead follow the native adoption steps into the destination document.
    try{initialize.call(source_registry,result.root);}catch(error){if(error.name!=='NotSupportedError')throw error;}
  }
  if(is_declarative_root(source_root))remember_declarative_root(result.host,result.root);else remember_shadow_root(result.host,result.root);
  for(const child of [...children.call(copy)])append.call(result.host,child);
  for(const child of children.call(source_root))append.call(result.root,native_import.call(owner.call(copy),child,true));
  const container=parent.call(copy);if(container)replace.call(container,result.host,copy);
  return result.host;
}

// Keep declarations as ordinary templates until every closed root is reachable
// by the resource rewriter. Retaining the attribute name lets the native
// sanitizer decide whether a declaration is allowed, without extra attributes.
export function defer_declarative_roots(context,value,whole_document=false,scripting_enabled=!whole_document){
  if(!/shadowrootmode/i.test(value))return {value,restore(){}};
  const options={scriptingEnabled:scripting_enabled,sourceCodeLocationInfo:true};
  const parsed=whole_document?parse(value,options):parseFragment(parsing_context(context),value,options),edits=[],modes=new Map(),pending=[parsed];
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
          if(host instanceof Element&&namespace.call(host)===html&&host!==container&&!shadow_root(host)){
            let root,replacement;
            try{
              // Parse an empty native declaration to retain registry inheritance,
              // internals visibility, and current/future shadow metadata. Obtain
              // its reference before installing any authored content.
              const result=root_shell(host,node);replacement=result.host;root=result.root;
            }catch{}
            if(root){
              remember_declarative_root(replacement,root);
              managed.set(root,{keepNull:has.call(node,'shadowrootcustomelementregistry')});
              for(const child of [...children.call(node.content)])append.call(root,child);
              remove.call(host,node);for(const child of [...children.call(host)])append.call(replacement,child);
              replace.call(parent.call(host),replacement,host);pending.push(root);continue;
            }
          }
        }
        pending.push(node.content);
      }
      const next=[...children.call(node)];for(let index=next.length-1;index>=0;index--)pending.push(next[index]);
    }
  }};
}
