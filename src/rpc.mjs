import {unwrap_global_target} from './frame/global_functions.mjs';
import {listen_runtime,unlisten_runtime,runtime_message,stop_runtime_message,post_bootstrap_message} from './frame/runtime_events.mjs';
import {bootstrap_attribute,bootstrap_global,runtime_content_type} from './bootstrap.mjs';

const native_timeout=globalThis.setTimeout.bind(globalThis),native_clear_timeout=globalThis.clearTimeout.bind(globalThis);

export let role = null;
export const rpc_handlers = Object.create(null);
export const rpc_requests = Object.create(null);
export let host = null;
export let on_attach = () => {};
const rpc_targets=new WeakSet();
const bootstrap_waiters=new Set();
const bootstrap_parent=globalThis.parent;
const bootstrap_worker=typeof globalThis.importScripts==='function';
const bootstrap_window=typeof globalThis.Window==='function';
const bootstrap_script=globalThis.document?.currentScript;
let bootstrap_config;
try{bootstrap_config=bootstrap_script?.hasAttribute(bootstrap_attribute)?JSON.parse(decodeURIComponent(bootstrap_script.getAttribute(bootstrap_attribute))):globalThis[bootstrap_global];}catch{}
bootstrap_script?.removeAttribute(bootstrap_attribute);delete globalThis[bootstrap_global];
const bootstrap_nonce=bootstrap_config?.nonce;
const bootstrap_channels=bootstrap_config?.channels===1?1:2;
let bootstrap_connections=0,bootstrap_listening=false;
function listen_bootstrap(){if(!bootstrap_listening){listen_runtime(globalThis,'message',host_set_handler,true);bootstrap_listening=true;}}
function release_bootstrap(){if(bootstrap_listening&&!host&&!bootstrap_waiters.size){unlisten_runtime(globalThis,'message',host_set_handler,true);bootstrap_listening=false;}}

//a flexible wrapper for message ports
export class RPCTarget {
  constructor(target=null) {
    rpc_targets.add(this);
    this.target = null;
    this.extra_targets = [];
    this.extra_frame_targets = new Map();
    this.retired_targets = new Map();
    this.msg_callback = this.handle_msg.bind(this);
    this.onmessage = () => {};
    if (target)
      this.set_target(target);
  }

  set_target(new_target) {
    if (this.target) {
      this.target.removeEventListener("message", this.msg_callback);
      this.target.close?.();
    }
    for (let target of this.extra_targets) {
      target.removeEventListener("message", this.msg_callback);
      target.close?.();
    }
    this.target = new_target;
    this.extra_targets = [];
    this.extra_frame_targets.clear();
    this.target.addEventListener("message", this.msg_callback);
  }

  add_extra_target(target, frame_id) {
    if (frame_id) this.remove_extra_target(frame_id);
    target.addEventListener("message", this.msg_callback);
    this.extra_targets.push(target);
    if (frame_id) this.extra_frame_targets.set(frame_id, target);
  }

  detach_extra_target(frame_id) {
    const target = this.extra_frame_targets.get(frame_id);
    if (!target) return;
    target.removeEventListener("message", this.msg_callback);
    this.extra_targets = this.extra_targets.filter(item => item !== target);
    this.extra_frame_targets.delete(frame_id);
    return target;
  }

  remove_extra_target(frame_id) {
    this.detach_extra_target(frame_id)?.close?.();
  }

  retire_extra_target(frame_id,{procedures,timeout=10000}) {
    const target=this.detach_extra_target(frame_id);
    if(!target)return;
    const allowed=new Set(procedures);
    const receive=event=>{
      const message=event.data;
      if(message?.type==='reply'||message?.type==='procedure'&&allowed.has(message.procedure))this.msg_callback(event);
    };
    const close=()=>{
      native_clear_timeout(timer);target.removeEventListener('message',receive);target.close?.();this.retired_targets.delete(target);
    };
    // Unload tasks from another frame can arrive after its parent's teardown
    // message. Only context-bound operations retain this short delivery window.
    const timer=native_timeout(close,timeout);timer.unref?.();
    this.retired_targets.set(target,close);target.addEventListener('message',receive);
  }

  handle_msg(event) {
    this.onmessage(event, this);
  }

  postMessage(...args) {
    this.target.postMessage(...args)
  }
}

async function handle_procedure_call(msg,target,source) {
  if (!rpc_handlers[msg.procedure]&&!target?.authorize) {
    return;
  }

  let output;
  try {
    const args=target?.authorize?target.authorize(msg,source):msg.arguments;
    if(!rpc_handlers[msg.procedure])throw new TypeError('Unknown RPC procedure');
    output = {
      value: await rpc_handlers[msg.procedure](...args),
      success: true
    };
  }
  catch (e) {
    // The caller receives this rejection and may handle it (for example XHR
    // aborts/timeouts). Logging here would report handled API errors as uncaught.
    output = {
      value: e,
      success: false
    };
  }

  return {
    type: "reply",
    id: msg.id,
    content: output
  };
}

function handle_procedure_reply(msg,source) {
  if (!rpc_requests[msg.id]) {
    return;
  }
  const expected=rpc_requests[msg.id].source;
  if(source&&expected&&unwrap_global_target(source)!==unwrap_global_target(expected))return;
  rpc_requests[msg.id](msg.content);
  delete rpc_requests[msg.id];
}

export async function message_listener(event, target) {
  let msg = event.data;
  let source = event.source || event.currentTarget;
  if (!msg || typeof msg !== "object" || typeof msg.type === "undefined") return;

  if (msg.type === "procedure") {
    let output = await handle_procedure_call(msg,target,source);
    if (!source) return;
    if (output) {
      source.postMessage(output, {targetOrigin: "*"});
    }
  }
  else if (msg.type === "reply") {
    handle_procedure_reply(msg,source);
  }
  else if(msg.type==='notification'){
    try{const args=target?.authorize?target.authorize(msg,source):msg.arguments;if(rpc_handlers[msg.procedure])await rpc_handlers[msg.procedure](...args);}catch(error){if(!target?.authorize)throw error;}
  }
  
  else if (msg.type === "attach") {
    let msg_port = event.ports[0];
    if (role === "frame") {
      host.postMessage(msg, {targetOrigin: "*", transfer: [msg_port]});
    }
    else {
      try{target.authorize_attach?.(source,msg_port,msg.frame_id);}catch{msg_port?.close();return;}
      target.add_extra_target(msg_port, msg.frame_id);
      msg_port.start();
    }
  }
}

export async function call_procedure(target, procedure, args, {signal,transfer} = {}) {
  if (globalThis.HTMLIFrameElement && target instanceof globalThis.HTMLIFrameElement) {
    target = unwrap_global_target(target.contentWindow || target);
  }
  let msg = {
    type: "procedure",
    id: Math.random() + "",
    procedure: procedure,
    arguments: args
  };

  return await new Promise((resolve, reject) => {
    const cleanup=()=>{delete rpc_requests[msg.id];signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason||new DOMException('The operation was aborted','AbortError'));};
    if(signal?.aborted){abort();return;}
    rpc_requests[msg.id] = (reply) => {
      cleanup();
      if (reply.success) resolve(reply.value);
      else reject(reply.value);
    }
    rpc_requests[msg.id].source=rpc_targets.has(target)?target.target:target;
    signal?.addEventListener('abort',abort,{once:true});
    try{target.postMessage(msg, {targetOrigin: "*",transfer});}
    catch(error){cleanup();reject(error);}
  });
}

export function create_rpc_wrapper(target, procedure) {
  return function() {
    return call_procedure(target, procedure, [...arguments]);
  }
}

export function notify(target,procedure,args){target.postMessage({type:'notification',procedure,arguments:args});}

//attach an additional message port to the host
export function attach_host(msg_port, frame_id) {
  let msg = {
    type: "attach",
    frame_id,
    id: Math.random() + ""
  };
  host.postMessage(msg, {targetOrigin: "*", transfer: [msg_port]});
}

//tell a child frame to set a message port as the host rpc target
export function set_host(frame, msg_port, {nonce}={}) {
  let msg = {
    type: "set_host",
    sandstone_bootstrap:1,nonce,
    id: Math.random() + ""
  };
  const window_frame=!!globalThis.HTMLIFrameElement&&frame instanceof HTMLIFrameElement;
  const msg_target=unwrap_global_target(window_frame?frame.contentWindow:frame);
  post_bootstrap_message(msg_target,msg,[msg_port],!window_frame);
}

export function load_frame_runtime(frame,html,nonce,{signal,mime='text/html'}={}){
  mime=runtime_content_type(mime);
  const id='runtime:'+Math.random()+':'+Math.random();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{bootstrap_waiters.delete(receive);release_bootstrap();signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason||new DOMException('The operation was aborted','AbortError'));};
    const receive=(message,source)=>{
      if(message.type!=='runtime_url'||message.id!==id||message.nonce!==nonce||unwrap_global_target(source)!==unwrap_global_target(frame.contentWindow)||typeof message.url!=='string'||!message.url.startsWith('blob:'))return;
      cleanup();resolve(message.url);
    };
    if(signal?.aborted){abort();return;}
    bootstrap_waiters.add(receive);listen_bootstrap();signal?.addEventListener('abort',abort,{once:true});
    try{post_bootstrap_message(unwrap_global_target(frame.contentWindow),{type:'runtime',sandstone_bootstrap:1,id,html,nonce,mime});}catch(error){cleanup();reject(error);}
  });
}
export function commit_frame_runtime(frame,url,nonce){post_bootstrap_message(unwrap_global_target(frame.contentWindow),{type:'commit_runtime',sandstone_bootstrap:1,url,nonce});}

export function wait_on_frame(frame,{signal,url=frame.src,nonce}={}) {
  const id=Math.random()+':'+Math.random();
  return new Promise((resolve,reject)=>{
    let timer,finished=false;
    const cleanup=()=>{finished=true;native_clear_timeout(timer);bootstrap_waiters.delete(receive);release_bootstrap();signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason||new DOMException('The operation was aborted','AbortError'));};
    const receive=(message,source)=>{
      if(message.type!=='pong'||message.id!==id||message.url!==url||nonce!==undefined&&message.nonce!==nonce||unwrap_global_target(source)!==unwrap_global_target(frame.contentWindow))return;
      cleanup();resolve(message.url);
    };
    const ping=()=>{
      // A data URL contains the runtime source and its private nonce. Do not
      // disclose the intended URL to the previous document during readiness.
      try{const target=unwrap_global_target(frame.contentWindow);if(target)post_bootstrap_message(target,{type:'ping',sandstone_bootstrap:1,id,...(nonce===undefined?{url}:{})});}
      catch(error){cleanup();reject(error);return;}
      if(!finished)timer=native_timeout(ping,50);
    };
    if(signal?.aborted){abort();return;}
    bootstrap_waiters.add(receive);listen_bootstrap();
    signal?.addEventListener('abort',abort,{once:true});
    ping();
  });
}

//handle the initial set_host message from the host
function host_set_handler(event) {
  const msg=runtime_message(event,'data'),source=runtime_message(event,'source'),ports=runtime_message(event,'ports')||[];
  if(!msg||msg.sandstone_bootstrap!==1||!['ping','pong','set_host','runtime','runtime_url','commit_runtime'].includes(msg.type))return;
  if((bootstrap_window||host)&&!event.isTrusted)return;
  stop_runtime_message(event);
  if(msg.type==='runtime'||msg.type==='commit_runtime'){for(const port of ports)port.close();return;}
  if(msg.type==='pong'||msg.type==='runtime_url'){
    for(const receive of [...bootstrap_waiters])receive(msg,source);
    for(const port of ports)port.close();
    return;
  }
  if(!host||!bootstrap_worker&&source!==bootstrap_parent){for(const port of ports)port.close();return;}
  if(msg.type==='ping'){
    if(source&&(msg.url===undefined||msg.url===globalThis.location.href))post_bootstrap_message(source,{type:'pong',sandstone_bootstrap:1,id:msg.id,url:globalThis.location.href,nonce:bootstrap_nonce});
    for(const port of ports)port.close();
    return;
  }
  const msg_port=ports[0];
  if(ports.length!==1||msg.nonce!==bootstrap_nonce||!bootstrap_nonce||bootstrap_connections>=bootstrap_channels){for(const port of ports)port.close();return;}
  if (msg_port) {
    bootstrap_connections++;
    if (!host.target) {
      host.set_target(msg_port);
      on_attach();
    }
    else {
      host.add_extra_target(msg_port);
    }
    msg_port.start();
  }
}

export function set_role(value) {
  role = value;
}

export function connect_frame_host(port,nonce){
  if(!host||!nonce||nonce!==bootstrap_nonce||bootstrap_connections>=bootstrap_channels)throw new DOMException('Invalid bootstrap connection','SecurityError');
  Reflect.apply(MessagePort.prototype.start,port,[]);bootstrap_connections++;
  if(!host.target){host.set_target(port);on_attach();}else host.add_extra_target(port);
}
export function set_on_attach(callback) {
  on_attach = callback;
}

//create an rpc target for the host if we are in a child frame
if (self.parent !== globalThis || typeof globalThis.importScripts === "function") {
  host = new RPCTarget();
  host.onmessage = message_listener;
  listen_bootstrap();
}
