import {document_states} from './document_identity.mjs';
import {listen_runtime} from './runtime_events.mjs';
import {on_shadow_root} from './shadow_roots.mjs';
import {native_dom} from './dom_operations.mjs';

const NativeFormData=globalThis.FormData,apply=Reflect.apply;
const entries=NativeFormData?.prototype.entries,append=NativeFormData?.prototype.append,remove=NativeFormData?.prototype.delete;
const pending=new WeakMap(),owners=document_states('form-internals-owners'),values=document_states('form-internals-values');
const descriptor=(constructor,name)=>constructor&&Object.getOwnPropertyDescriptor(constructor.prototype,name)?.get;
const form_elements=descriptor(globalThis.HTMLFormElement,'elements');
const collection_length=descriptor(globalThis.HTMLCollection,'length'),collection_item=globalThis.HTMLCollection?.prototype.item;
const input_type=descriptor(globalThis.HTMLInputElement,'type'),checked=descriptor(globalThis.HTMLInputElement,'checked'),files=descriptor(globalThis.HTMLInputElement,'files');
const file_count=descriptor(globalThis.FileList,'length'),button_type=descriptor(globalThis.HTMLButtonElement,'type');
const textarea_form=descriptor(globalThis.HTMLTextAreaElement,'form'),select_options=descriptor(globalThis.HTMLSelectElement,'selectedOptions');
const attribute=globalThis.Element?.prototype.getAttribute,closest=globalThis.Element?.prototype.closest,matches=globalThis.Element?.prototype.matches;
const form_data=descriptor(globalThis.FormDataEvent,'formData');
const event_target=descriptor(globalThis.Event,'target');
const charset_name=name=>typeof name==='string'&&name.toLowerCase()==='_charset_';
// Use this engine's native entry construction for platform differences such as
// datalist descendants and dirname on an unselected submit input. The probe is
// detached and runs before authored code or listeners are installed.
const direction_types=new Set();let datalist_entries=false,submit_direction=false;
if(globalThis.document){
  // HTML probe fragments must not use the active SVG/XHTML document's parser.
  const probe=document.implementation.createHTMLDocument('');
  const form=native_dom.create.call(probe,'http://www.w3.org/1999/xhtml','form');
  const has_charset=submitter=>Array.from(apply(entries,submitter?new NativeFormData(form,submitter):new NativeFormData(form),[])).some(([name])=>name==='_charset_');
  for(const type of ['hidden','text','search','tel','url','email','password','number','color','submit','button','reset','checkbox','radio','file']){
    native_dom.inner.call(form,'<input type="'+type+'" name="field" dirname="_charset_" checked>');
    if(has_charset())direction_types.add(type);
    if(type==='submit')submit_direction=has_charset(form.firstChild);
  }
  native_dom.inner.call(form,'<datalist><input type="hidden" name="_charset_"></datalist>');
  datalist_entries=has_charset();
}

if(globalThis.ElementInternals&&typeof ElementInternals.prototype.setFormValue==='function'){
  const attach=HTMLElement.prototype.attachInternals,set=ElementInternals.prototype.setFormValue;
  HTMLElement.prototype.attachInternals=new Proxy(attach,{apply(target,receiver,args){
    const internals=apply(target,receiver,args);owners.set(internals,receiver);values.set(receiver,[]);return internals;
  }});
  ElementInternals.prototype.setFormValue=new Proxy(set,{apply(target,receiver,args){
    const result=apply(target,receiver,args),owner=owners.get(receiver);
    if(owner){
      let keys=args[0]==null?[]:null;
      if(args[0]!=null)try{keys=Array.from(apply(entries,args[0],[]),([name])=>name);}catch{}
      values.set(owner,keys);
    }
    return result;
  }});
}

function list(collection){
  const result=[];
  for(let index=0;index<collection_length.call(collection);index++)result.push(collection_item.call(collection,index));
  return result;
}
function charset_entries(form,submitter){
  const positions=new Map();
  const add=(name,count,hidden=false)=>{
    if(!charset_name(name))return;
    let values=positions.get(name);if(!values)positions.set(name,values=[]);
    for(let index=0;index<count;index++)values.push(hidden);
  };
  for(const field of list(form_elements.call(form))){
    if(matches.call(field,':disabled')||!datalist_entries&&closest.call(field,'datalist'))continue;
    const name=attribute.call(field,'name');
    if(values.has(field)){
      const keys=values.get(field);if(keys===null)add(name,1);else for(const name of keys)add(name,1);
      continue;
    }
    const direction=attribute.call(field,'dirname');
    if(!name||!charset_name(name)&&!charset_name(direction))continue;
    let type;
    try{type=input_type.call(field);}catch{}
    if(type!==undefined){
      if(['checkbox','radio'].includes(type)&&!checked.call(field))continue;
      if(!['button','reset','image'].includes(type))add(name,type==='submit'&&field!==submitter?0:type==='file'?Math.max(1,file_count.call(files.call(field))):1,type==='hidden');
      if(type==='submit'&&field===submitter?submit_direction:direction_types.has(type))add(direction,1);
      continue;
    }
    try{const type=button_type.call(field);if(type==='submit'&&field===submitter)add(name,1);continue;}catch{}
    try{textarea_form.call(field);add(name,1);add(direction,1);continue;}catch{}
    try{add(name,list(select_options.call(field)).filter(option=>!matches.call(option,':disabled')).length);}catch{}
  }
  return positions;
}

function set_charset(event){
  const form=event_target.call(event),record=pending.get(form);
  if(!event.isTrusted||!record||record.encoding==='UTF-8')return;
  const positions=charset_entries(form,record.submitter);
  if(![...positions.values()].some(values=>values.some(Boolean)))return;
  const data=form_data.call(event),snapshot=Array.from(apply(entries,data,[])),offsets=new Map();
  for(const entry of snapshot){
    const index=offsets.get(entry[0])||0;offsets.set(entry[0],index+1);
    if(positions.get(entry[0])?.[index])entry[1]=record.encoding;
  }
  for(const name of new Set(snapshot.map(([name])=>name)))apply(remove,data,[name]);
  for(const entry of snapshot)apply(append,data,entry);
}
if(globalThis.document&&form_data){
  listen_runtime(globalThis,'formdata',set_charset,true);
  on_shadow_root(root=>listen_runtime(root,'formdata',set_charset,true));
}

export function submission_form_data(form,submitter,encoding){
  pending.set(form,{submitter,encoding});
  try{return submitter?new NativeFormData(form,submitter):new NativeFormData(form);}
  finally{pending.delete(form);}
}
