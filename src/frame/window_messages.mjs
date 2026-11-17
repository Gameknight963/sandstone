import {ctx} from './context.mjs';
import {create_obj_proxy,unwrap_global_target} from './global_functions.mjs';
import {encode_message} from './polyfill/crypto.mjs';

const peers=new WeakMap(),received=new WeakMap();
const post=globalThis.Window&&globalThis.postMessage;
const data=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data');
const source=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');
const origin=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'origin');
const selfToken=Array.from(crypto.getRandomValues(new Uint32Array(4)),value=>value.toString(16)).join(':');
let parentWindow,ownOrigin;
const current_origin=()=>ownOrigin??ctx.location.origin;

function transfer_sequence(value){
  if(value===undefined)return undefined;
  if(value===null||!['object','function'].includes(typeof value))throw new TypeError('Invalid transfer sequence');
  const iterator=value[Symbol.iterator];
  if(typeof iterator!=='function')throw new TypeError('Invalid transfer sequence');
  return Array.from({[Symbol.iterator]:()=>Reflect.apply(iterator,value,[])},item=>{
    if(item===null||!['object','function'].includes(typeof item))throw new TypeError('Invalid transferable');
    return item;
  });
}

function target_options(args){
  if(!args.length)throw new TypeError('A message is required');
  let target='/',transfer;
  const options=args[1];
  if(options===null||options===undefined||typeof options==='object'||typeof options==='function'){
    if(options!=null){
      // StructuredSerializeOptions is the dictionary's base, so Web IDL
      // converts its transfer sequence before reading targetOrigin.
      transfer=transfer_sequence(options.transfer);
      const value=options.targetOrigin;
      if(value!==undefined)target=`${value}`;
    }
  }else{target=`${options}`;transfer=transfer_sequence(args[2]);}
  if(target==='/')target=current_origin()==='null'?'opaque:'+selfToken:current_origin();
  else if(target!=='*'){
    try{target=new URL(target).origin;}
    catch{throw new DOMException('Invalid target origin','SyntaxError');}
  }
  return {target,transfer};
}

export function window_post_message(target,token,args){
  const options=target_options(args);
  // The browser still clones synchronously, detaches transfers, queues the
  // trusted event and checks Window liveness. Only origin addressing is virtual.
  return Reflect.apply(post,target,[{
    sandstone_message:token,origin:current_origin(),target:options.target,
    data:encode_message(args[0])
  },'*',options.transfer]);
}

export function register_message_peer(target,token,window){peers.set(target,{token,window});}
export function parent_message_window(){return parentWindow||globalThis.parent;}
export function self_post_message(...args){return window_post_message(globalThis,selfToken,args);}

export function configure_window_messages(options){
  if(!post)return;
  ownOrigin=options.message_origin;
  register_message_peer(globalThis,selfToken,()=>ctx.window);
  if(!options.message_parent)return;
  const {token}=options.message_parent;
  const target=globalThis.parent,replacements=Object.create(null);
  Object.defineProperties(replacements,{
    postMessage:{value:(...args)=>window_post_message(target,token,args)},
    window:{get:()=>parentWindow},self:{get:()=>parentWindow},frames:{get:()=>parentWindow}
  });
  parentWindow=create_obj_proxy(replacements,[],target);
  register_message_peer(target,token,()=>parentWindow);
}

if(post){
  // Receive on the native posted-message task. Tokens are shared over the
  // private loader channel and bind the envelope to its actual source Window.
  globalThis.addEventListener('message',event=>{
    const value=data.get.call(event),peer=peers.get(unwrap_global_target(source.get.call(event)));
    if(!peer||!value||typeof value!=='object'||value.sandstone_message!==peer.token)return;
    const expected=current_origin()==='null'?'opaque:'+selfToken:current_origin();
    if(value.target!=='*'&&(value.target==='null'||value.target!==expected)){
      event.stopImmediatePropagation();return;
    }
    received.set(event,{data:value.data,origin:value.origin,source:peer.window()});
  },true);
  for(const [key,descriptor] of [['data',data],['origin',origin],['source',source]]){
    Object.defineProperty(MessageEvent.prototype,key,{
      ...descriptor,get(){return received.has(this)?received.get(this)[key]:descriptor.get.call(this);}
    });
  }
}
