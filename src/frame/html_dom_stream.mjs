import {HTMLInputStream} from './html_input_stream.mjs';
import {parsing_context} from './scripting_html.mjs';
import {native_dom as dom} from './dom_operations.mjs';
import {shadow_root,remember_declarative_root} from './shadow_roots.mjs';
import {prepare_resources} from './resource_nodes.mjs';
import {rewrite_element} from './rewrite/element.mjs';
import {prime_inert_script,mark_parser_script,capture_script} from './rewrite/script.mjs';
import {mutate_styles} from './rewrite/style.mjs';
import {document_base_url,with_document_base_url} from './document_base.mjs';
import {resolve_base_href} from '../base_url.mjs';

const html='http://www.w3.org/1999/xhtml';
const attribute=(node,name)=>node.attrs?.find(attribute=>!attribute.namespace&&attribute.name===name)?.value;
const qualified=attribute=>attribute.prefix?attribute.prefix+':'+attribute.name:attribute.name;
const escaped=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;');
const query_document=globalThis.Document?.prototype.querySelectorAll,query_element=globalThis.Element?.prototype.querySelectorAll;

// Materialize parser mutations through an inactive document. New subtrees must
// receive resource interception before adoption can start image/media loads.
// Existing nodes are updated only when the parser changes them, preserving
// authored edits, listeners, form state and node identity between input writes.
export class HTMLDOMStream {
  #input;#target;#document;#inert;#before;#callback;#mode;#modeSet=false;#states=new Map();#resources=[];#pending=new Set();#syncing=false;
  constructor(target,{before=null,onScript,onMode,signal}={}){
    if(!(target instanceof Document||target instanceof Element||target instanceof DocumentFragment))throw new TypeError('A document, element or document fragment is required');
    if(onScript!==undefined&&typeof onScript!=='function')throw new TypeError('onScript must be a function');
    this.#document=target instanceof Document?target:dom.owner.call(target);this.#inert=this.#document.implementation.createHTMLDocument('');
    this.#target=target instanceof HTMLTemplateElement?dom.template.call(target):target;this.#before=before;this.#callback=onScript;this.#mode=onMode;
    this.#input=new HTMLInputStream({context:target instanceof Document?undefined:parsing_context(target),signal,onUpdate:()=>this.#sync(),onScript:(node,_context,input)=>{
      this.#sync();const state=this.#states.get(node);mark_parser_script(state.node);
      if(state.inert||!this.#callback)return;
      return this.#callback(state.node,{write:text=>{input.write(text);this.#sync();},get target(){return target;}});
    }});
    // A new document.open can discard this input before anyone calls close.
    // Keep that cancellation handled; finish/close still expose the rejection.
    this.#input.done.catch(()=>{});
    this.#states.set(this.#input.document,{node:this.#target,physical:false,inert:target instanceof HTMLTemplateElement||!dom.view.call(this.#document)});
  }
  write(text){this.#input.write(text);}
  get closed(){return this.#input.closed;}
  get pendingResources(){return this.#pending.size;}
  finish(){return this.#input.close();}
  settled(){return Promise.allSettled(this.#resources);}
  async close(){await this.finish();this.#sync();await this.settled();return this.#target;}
  #prepare(node){
    const operation=()=>{prepare_resources(node);return rewrite_element(node);};
    if([...query_document.call(this.#document,'base[href]')].some(node=>node instanceof HTMLBaseElement))return operation();
    const candidates=[...(node instanceof HTMLBaseElement?[node]:[]),...(node instanceof Element?query_element.call(node,'base[href]'):[])];
    const base=candidates.find(node=>node instanceof HTMLBaseElement&&node.hasAttribute('href'));
    return base?with_document_base_url(resolve_base_href(base.getAttribute('href'),document_base_url()),operation):operation();
  }
  #element(ast){
    try{
      const node=dom.create.call(this.#inert,ast.namespaceURI,ast.tagName,attribute(ast,'is')?{is:attribute(ast,'is')}:undefined);
      if(node.localName===ast.tagName&&!node.prefix)return node;
    }catch(error){if(!['InvalidCharacterError','NamespaceError'].includes(error.name))throw error;}
    // HTML tag names need not be valid XML qualified names. Parse an empty
    // shell in the same namespace without creating or activating resources.
    const context=dom.create.call(this.#inert,ast.namespaceURI,ast.namespaceURI===html?'div':ast.namespaceURI==='http://www.w3.org/2000/svg'?'svg':'math');
    dom.inner.call(context,'<'+ast.tagName+'></'+ast.tagName+'>');return context.firstChild;
  }
  #attribute(node,value){
    if(value.namespace){dom.attribute.call(node,value.namespace,qualified(value),value.value);return;}
    try{dom.plainAttribute.call(node,value.name,value.value);}
    catch(error){
      if(error.name!=='InvalidCharacterError')throw error;
      const holder=dom.create.call(this.#inert,html,'div');dom.inner.call(holder,'<i '+value.name+'="'+escaped(value.value)+'"></i>');
      dom.attributeNode.call(node,holder.firstChild.getAttributeNode(value.name));
    }
  }
  #create(ast,parent){
    let node,physical=true,inert=parent.inert;
    if(ast.nodeName==='#text')node=dom.text.call(this.#inert,ast.value);
    else if(ast.nodeName==='#comment')node=dom.comment.call(this.#inert,ast.data);
    else if(ast.nodeName==='#documentType')node=dom.doctype.call(this.#document.implementation,ast.name,ast.publicId,ast.systemId);
    else{
      node=this.#element(ast);
      if((ast.namespaceURI===html||ast.namespaceURI==='http://www.w3.org/2000/svg')&&ast.tagName==='script'){
        prime_inert_script(node);node.removeAttribute('type');node.__rewritten__=true;
        if(inert)node.__sandstone_inert__=true;
      }
      for(const value of ast.attrs)this.#attribute(node,value);
      if(ast.namespaceURI===html&&ast.tagName==='script')capture_script(node)(node);
      if(ast.content){
        const mode=attribute(ast,'shadowrootmode')?.toLowerCase();let root;
        if(parent.node!==this.#target&&parent.node instanceof Element&&parent.node.namespaceURI===html&&!shadow_root(parent.node)&&(mode==='open'||mode==='closed')){
          try{
            const options={mode,clonable:attribute(ast,'shadowrootclonable')!==undefined,serializable:attribute(ast,'shadowrootserializable')!==undefined,delegatesFocus:attribute(ast,'shadowrootdelegatesfocus')!==undefined};
            if(attribute(ast,'shadowrootcustomelementregistry')!==undefined)options.customElementRegistry=null;
            if(attribute(ast,'shadowrootreferencetarget')!==undefined)options.referenceTarget=attribute(ast,'shadowrootreferencetarget');
            root=parent.node.attachShadow(options);remember_declarative_root(parent.node,root);physical=false;
          }catch{}
        }
        this.#states.set(ast.content,{node:root||dom.template.call(node),physical:false,inert:inert||!root});
      }
    }
    const state={node,physical,inert,value:ast.value??ast.data,attributes:new Map((ast.attrs||[]).map(value=>[(value.namespace||'')+'\0'+value.name,value.value]))};
    this.#states.set(ast,state);return state;
  }
  #sync(){
    if(this.#syncing)return;this.#syncing=true;
    const seen=new Set();
    try{
      if(!this.#modeSet&&this.#target instanceof Document&&this.#input.document.childNodes.some(node=>node.tagName==='html'||node.nodeName==='#documentType')){
        this.#modeSet=true;this.#mode?.(this.#input.document.mode);
        for(const state of this.#states.values())if(state.parent?.node===this.#target)state.parent=undefined;
      }
      const visit=(ast,parent,position,siblings)=>{
        let state=this.#states.get(ast);if(!state)state=this.#create(ast,parent);
        seen.add(ast);
        const node=state.node;
        if(ast.nodeName==='#text'||ast.nodeName==='#comment'){
          const value=ast.value??ast.data;
          if(value!==state.value){
            mutate_styles([node],()=>value.startsWith(state.value)?dom.appendData.call(node,value.slice(state.value.length)):dom.data.call(node,value));state.value=value;
          }
        }else for(const value of state.physical?ast.attrs||[]:[]){
          const key=(value.namespace||'')+'\0'+value.name;
          if(state.attributes?.get(key)===value.value)continue;
          if(dom.view.call(dom.owner.call(node)))node.setAttributeNS(value.namespace||null,qualified(value),value.value);
          else this.#attribute(node,value);
          state.attributes?.set(key,value.value);
        }
        const descendants=ast.childNodes||[];
        for(let index=0;index<descendants.length;index++)visit(descendants[index],state,index,descendants);
        if(ast.content)visit(ast.content,state,0,[]);
        if(!parent||!state.physical)return;
        if(state.parent===parent)return;
        const target=parent.node,document=target instanceof Document?target:dom.owner.call(target);
        if(dom.view.call(document)&&dom.owner.call(node)!==document){
          const pending=this.#prepare(node);
          if(pending){const resource=Promise.resolve(pending);this.#pending.add(resource);resource.then(()=>this.#pending.delete(resource),()=>this.#pending.delete(resource));this.#resources.push(resource);}
          dom.adopt.call(document,node);
        }
        let before=null;
        for(let index=position+1;index<siblings.length;index++){
          const next=this.#states.get(siblings[index]);if(next?.physical&&dom.parent.call(next.node)===target){before=next.node;break;}
        }
        if(!before&&target===this.#target&&this.#before&&dom.parent.call(this.#before)===target)before=this.#before;
        mutate_styles([target,node],()=>dom.insert.call(target,node,before));state.parent=parent;
      };
      visit(this.#input.document,null,0,[]);
      for(const [ast,state] of this.#states)if(!seen.has(ast)&&state.physical&&state.parent){
        if(dom.parent.call(state.node)===state.parent.node)mutate_styles([state.parent.node,state.node],()=>dom.remove.call(state.parent.node,state.node));
        state.parent=undefined;
      }
    }finally{this.#syncing=false;}
  }
}
