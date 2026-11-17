import {unwrap_global_target} from './frame/global_functions.mjs';

export let role = null;
export const rpc_handlers = {};
export const rpc_requests = {};
export let host = null;
export let on_attach = () => {};

//a flexible wrapper for message ports
export class RPCTarget {
  constructor(target=null) {
    this.target = null;
    this.extra_targets = [];
    this.extra_frame_targets = new Map();
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

  remove_extra_target(frame_id) {
    const target = this.extra_frame_targets.get(frame_id);
    if (!target) return;
    target.removeEventListener("message", this.msg_callback);
    target.close?.();
    this.extra_targets = this.extra_targets.filter(item => item !== target);
    this.extra_frame_targets.delete(frame_id);
  }

  handle_msg(event) {
    this.onmessage(event, this);
  }

  postMessage(...args) {
    this.target.postMessage(...args)
  }
}

async function handle_procedure_call(msg) {
  if (!rpc_handlers[msg.procedure]) {
    return;
  }

  let output;
  try {
    output = {
      value: await rpc_handlers[msg.procedure](...msg.arguments),
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

function handle_procedure_reply(msg) {
  if (!rpc_requests[msg.id]) {
    return;
  }
  rpc_requests[msg.id](msg.content);
  delete rpc_requests[msg.id];
}

export async function message_listener(event, target) {
  let msg = event.data;
  let source = event.source || event.currentTarget;
  if (!msg || typeof msg !== "object" || typeof msg.type === "undefined") return;

  if (msg.type === "procedure") {
    let output = await handle_procedure_call(msg);
    if (!source) return;
    if (output) {
      source.postMessage(output, {targetOrigin: "*"});
    }
  }
  else if (msg.type === "reply") {
    handle_procedure_reply(msg);
  }
  
  else if (msg.type === "attach") {
    let msg_port = event.ports[0];
    if (role === "frame") {
      host.postMessage(msg, {targetOrigin: "*", transfer: [msg_port]});
    }
    else {
      target.add_extra_target(msg_port, msg.frame_id);
      msg_port.start();
    }
  }
}

export async function call_procedure(target, procedure, args, {signal} = {}) {
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
    signal?.addEventListener('abort',abort,{once:true});
    try{target.postMessage(msg, {targetOrigin: "*"});}
    catch(error){cleanup();reject(error);}
  });
}

export function create_rpc_wrapper(target, procedure) {
  return function() {
    return call_procedure(target, procedure, [...arguments]);
  }
}

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
export function set_host(frame, msg_port) {
  let msg = {
    type: "set_host",
    id: Math.random() + ""
  };
  let msg_target = unwrap_global_target(frame.contentWindow || frame);
  msg_target.postMessage(msg, {targetOrigin: "*", transfer: [msg_port]})
}

export function wait_on_frame(frame,{signal}={}) {
  const id=Math.random()+':'+Math.random(),url=frame.src;
  return new Promise((resolve,reject)=>{
    let timer,finished=false;
    const cleanup=()=>{finished=true;clearTimeout(timer);globalThis.removeEventListener('message',receive);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason||new DOMException('The operation was aborted','AbortError'));};
    const receive=event=>{
      const message=event.data;
      if(message?.type!=='pong'||message.id!==id||message.url!==url||unwrap_global_target(event.source)!==unwrap_global_target(frame.contentWindow))return;
      cleanup();resolve();
    };
    const ping=()=>{
      try{unwrap_global_target(frame.contentWindow)?.postMessage({type:'ping',id,url},'*');}
      catch(error){cleanup();reject(error);return;}
      if(!finished)timer=setTimeout(ping,50);
    };
    if(signal?.aborted){abort();return;}
    globalThis.addEventListener('message',receive);
    signal?.addEventListener('abort',abort,{once:true});
    ping();
  });
}

//handle the initial set_host message from the host
function host_set_handler(event) {
  let msg = event.data;
  if (!msg || typeof msg !== "object") return;
  let msg_port = event.ports[0];

  if (msg.type === "ping" && event.source && msg.url===globalThis.location.href) {
    let msg = {
      type: "pong",
      id: event.data.id,
      url:globalThis.location.href
    };
    unwrap_global_target(event.source).postMessage(msg, "*");
    return;
  }

  if (msg.type === "set_host" && msg_port) {
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
export function set_on_attach(callback) {
  on_attach = callback;
}

//create an rpc target for the host if we are in a child frame
if (self.parent !== globalThis || typeof globalThis.importScripts === "function") {
  host = new RPCTarget();
  host.onmessage = message_listener;
  self.addEventListener("message", host_set_handler);
}
