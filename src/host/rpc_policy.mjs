const self_calls=new Set(['navigate','navigate_target','history_mutate','history_go','window_name','storage_ready','cookies_ready','document_open','idb_command','idb_poll','idb_databases','cache_command','crypto','ws_new','ws_event','ws_send','ws_close','service_worker_open','service_worker_client','worker_entry_cancel']);
const context_calls=new Set(['beacon','fetch_keepalive','fetch_keepalive_read','fetch_keepalive_abort','fetch_keepalive_done','download_request','download_blob','broadcast_open','broadcast_command','lock_open','lock_query','filesystem_command']);
const denied=()=>{throw new DOMException('RPC source is not authorized','SecurityError');};

// Source identity belongs to the receiving MessagePort, not a frame ID supplied
// in its messages. Retired ports retain only their original document token.
export class RPCSourcePolicy {
  constructor({root,frames,contexts}){Object.assign(this,{root,frames,contexts});this.ports=new WeakMap();this.pending=new Map();}
  bind_root(port,context){this.pending.clear();this.ports.set(port,{id:this.root,context});}
  scope(port){
    const scope=this.ports.get(port),entry=scope&&this.contexts().get(scope.context);
    if(!scope||!entry||entry.frame!==scope.id)denied();
    return {...scope,entry};
  }
  active(scope){
    const frame=this.frames()[scope.id];
    if(scope.entry.retired||!frame||frame.root_id!==this.root||frame.document_context!==scope.context)denied();
  }
  owns(scope,id){const child=this.frames()[id];return child?.parent_id===scope.id&&child.parent_context===scope.context;}
  attach(source,port,id){
    const scope=this.scope(source);this.active(scope);
    if(!port||typeof port!=='object')denied();
    if(typeof id!=='string'||!id||id===scope.id)denied();
    const child=this.frames()[id],pending=this.pending.get(id);
    if(pending?.context)denied();
    if(child&&!this.owns(scope,id)||pending&&(pending.parent!==scope.id||pending.creator!==scope.context))denied();
    const binding={id,parent:scope.id,creator:scope.context,context:child?.document_context};
    this.pending.set(id,binding);this.ports.set(port,binding);
  }
  document(id,context,parent_context){
    const pending=this.pending.get(id);
    if(pending&&pending.creator===parent_context)pending.context=context;
  }
  forget(id){this.pending.delete(id);}
  authorize(message,source){
    const scope=this.scope(source),args=message.arguments;
    if(message.type!=='procedure'||!Array.isArray(args))denied();
    const procedure=message.procedure;
    if(context_calls.has(procedure)){if(args[0]!==scope.context)denied();return args;}
    if(procedure==='local_storage'||procedure==='session_storage'){
      if(args[0]!==scope.id||args[2]?.context!==scope.context)denied();return args;
    }
    if(procedure==='storage_disconnect'){
      if(args[0]!==scope.id||args[1]!==scope.context)denied();return args;
    }
    if(procedure==='cookie_set'){
      if(args[0]!==scope.id)denied();return [...args.slice(0,3),scope.context];
    }
    if(procedure==='frame_unregister'){
      if(this.frames()[args[0]]&&!this.owns(scope,args[0]))denied();return [args[0],{...args[1],source_frame:scope.id,source_document:scope.context}];
    }
    if(procedure==='storage_ready'||procedure==='cookies_ready'){
      if(args[0]!==scope.id||args[1]!==scope.context)denied();
      // Retirement can precede the physical navigation of the old document.
      // Cancel its own readiness requests without authorizing a snapshot.
      if(scope.entry.retired)throw new DOMException('Document was retired','AbortError');
    }
    this.active(scope);
    if(procedure==='service_worker_command'){
      if(args[0]!==scope.id||!this.frames()[scope.id]?.service_worker_host)denied();return args;
    }
    if(procedure==='fetch_worker_script'||procedure==='fetch_worker_request'||procedure==='filesystem_worker_command'){
      if(args[0]!==scope.id||!this.owns(scope,args[1])||!this.frames()[args[1]]?.worker)denied();return args;
    }
    if(procedure==='frame_register'){
      const pending=this.pending.get(args[1]);
      if(args[0]!==scope.id||typeof args[1]!=='string'||args[1]===scope.id||pending&&(pending.parent!==scope.id||pending.creator!==scope.context))denied();return args;
    }
    if(procedure==='fetch'||procedure==='fetch_read'||procedure==='fetch_abort'){
      // A parent prepares child navigations and reads that navigation's body.
      if(args[0]!==scope.id&&!(this.owns(scope,args[0])&&(procedure!=='fetch'||args[3]?.mode==='navigate')))denied();return args;
    }
    if(!self_calls.has(procedure)||args[0]!==scope.id)denied();
    if(['window_name','storage_ready','cookies_ready','document_open','navigate_target','service_worker_open','service_worker_client'].includes(procedure)&&args[1]!==scope.context)denied();
    return args;
  }
}
