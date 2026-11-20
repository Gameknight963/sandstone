// Relay and cache responses retain their internal response type and URL even
// when authored code shadows the public properties.
const records=new WeakMap();
const filtered=new WeakMap(),NativeResponse=globalThis.Response;
const body_get=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'body').get,read_blob=NativeResponse.prototype.blob;
const header_get=Headers.prototype.get,header_each=Headers.prototype.forEach,define=Object.defineProperty;
// Native slots keep the body and headers empty. Guard the consumption hooks
// separately so cache writes and respondWith can consume private snapshots.
const used=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'bodyUsed');
Object.defineProperty(NativeResponse.prototype,'bodyUsed',{...used,get:new Proxy(used.get,{apply(target,receiver,args){const value=Reflect.apply(target,receiver,args);return filtered.get(receiver)?.used??value;}})});
for(const name of ['text','json','blob','arrayBuffer','formData','bytes']){
  const descriptor=Object.getOwnPropertyDescriptor(NativeResponse.prototype,name);if(!descriptor)continue;
  Object.defineProperty(NativeResponse.prototype,name,{...descriptor,value:new Proxy(descriptor.value,{apply(target,receiver,args){
    if(filtered.get(receiver)?.used)return Promise.reject(new TypeError('Response body is already used'));
    return Reflect.apply(target,receiver,args);
  }})});
}
const clone=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'clone');
Object.defineProperty(NativeResponse.prototype,'clone',{...clone,value:new Proxy(clone.value,{apply(target,receiver,args){
  const state=filtered.get(receiver);if(!state){
    const copy=Reflect.apply(target,receiver,args),metadata=records.get(receiver);
    if(metadata){
      // Borrowed prototype calls must retain the same trusted metadata as the
      // per-response wrappers, without consulting authored own properties.
      for(const key of ['url','type','redirected','status','statusText'])if(metadata[key]!==undefined)
        define(copy,key,{value:key==='url'?metadata[key].split('#')[0]:metadata[key]});
      if(metadata.status!==undefined)define(copy,'ok',{value:metadata.status>=200&&metadata.status<=299});
      remember_response(copy,metadata);
    }
    return copy;
  }
  if(state.used)throw new TypeError('Response body is already used');
  return filtered_redirect(state.inner,state.snapshot);
}})});
const getters=Object.fromEntries(['status','statusText','url','type','redirected','headers'].map(key=>[key,Object.getOwnPropertyDescriptor(Response.prototype,key).get]));
export function response_metadata(response){
  const native=Object.fromEntries(Object.entries(getters).map(([key,get])=>[key,get.call(response)]));
  return {...native,...records.get(response),headers:native.headers};
}
export function remember_response(response,metadata){
  getters.status.call(response);
  records.set(response,Object.fromEntries(['status','statusText','url','type','redirected','internal_response'].filter(key=>metadata[key]!==undefined).map(key=>[key,metadata[key]])));
  return response;
}
export function response_header(response,name){return Reflect.apply(header_get,Reflect.apply(getters.headers,response,[]),[name]);}

function filtered_redirect(inner,snapshot){
  const response=NativeResponse.error(),state={inner,snapshot,used:false};filtered.set(response,state);
  Object.defineProperties(response,{
    type:{value:'opaqueredirect'},url:{value:inner.url.split('#')[0]},redirected:{value:false},
  });
  return remember_response(response,{status:0,statusText:'',type:'opaqueredirect',url:inner.url,redirected:false,internal_response:inner});
}

export function opaque_redirect_response(response){
  const metadata=response_metadata(response),body=body_get.call(response);
  const headers=[];Reflect.apply(header_each,metadata.headers,[(value,key)=>define(headers,headers.length,{value:[key,value],enumerable:true,configurable:true,writable:true})]);
  const inner={status:metadata.status,statusText:metadata.statusText,url:metadata.url,type:metadata.type,redirected:metadata.redirected,headers,has_body:body!==null};
  let snapshot;
  if(response_header(response,'location')){
    // A real redirect's body is never used by navigation. Cancel it promptly
    // even when the server leaves that body open indefinitely.
    void body?.cancel().catch(()=>{});snapshot=Promise.resolve(body===null?null:new Blob([]));
  }else snapshot=body===null?Promise.resolve(null):Reflect.apply(read_blob,response,[]);
  snapshot.catch(()=>{});
  return filtered_redirect(inner,snapshot);
}

export function restore_opaque_redirect(metadata,body){
  return filtered_redirect(metadata.internal_response,Promise.resolve(metadata.internal_response.has_body?body:null));
}

// Only cache writes and respondWith consume the hidden body. Script-facing
// text/blob/stream methods continue to see the null body of Response.error().
export function consume_filtered_response(response){
  const state=filtered.get(response);if(!state)return;
  if(state.used)throw new TypeError('Response body is already used');
  if(state.inner.has_body)state.used=true;
  return state.snapshot;
}
