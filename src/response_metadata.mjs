// Relay and cache responses retain their internal response type and URL even
// when authored code shadows the public properties.
const records=new WeakMap();
const filtered=new WeakMap(),mutable_filtered_headers=new WeakMap(),NativeResponse=globalThis.Response;
const body_get=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'body').get,read_blob=NativeResponse.prototype.blob;
const header_get=Headers.prototype.get,header_each=Headers.prototype.forEach,define=Object.defineProperty;
const array_map=Array.prototype.map,array_filter=Array.prototype.filter,promise_resolve=Promise.resolve.bind(Promise),promise_then=Promise.prototype.then;
const immutable_headers=new WeakSet(),immutable=NativeResponse.error().headers;
for(const name of ['append','set','delete']){
  const descriptor=Object.getOwnPropertyDescriptor(Headers.prototype,name);
  define(Headers.prototype,name,{...descriptor,value:new Proxy(descriptor.value,{apply(target,receiver,args){return Reflect.apply(target,immutable_headers.has(receiver)?immutable:receiver,args);}})});
}
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
    if(immutable_headers.has(Reflect.apply(getters.headers,receiver,[])))immutable_response_headers(copy);
    return copy;
  }
  if(state.used)throw new TypeError('Response body is already used');
  return filtered_response(state.inner,state.snapshot,state.type,state.mutable?header_pairs(Reflect.apply(getters.headers,receiver,[])):undefined);
}})});
const getters=Object.fromEntries(['status','statusText','url','type','redirected','headers'].map(key=>[key,Object.getOwnPropertyDescriptor(Response.prototype,key).get]));
const header_descriptor=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'headers');
getters.headers=new Proxy(header_descriptor.get,{apply(target,receiver,args){const headers=Reflect.apply(target,receiver,args);return mutable_filtered_headers.get(receiver)||headers;}});
define(NativeResponse.prototype,'headers',{...header_descriptor,get:getters.headers});
export function response_metadata(response){
  const native=Object.fromEntries(Object.entries(getters).map(([key,get])=>[key,get.call(response)]));
  return {...native,...records.get(response),headers:native.headers};
}
export function remember_response(response,metadata){
  getters.status.call(response);
  records.set(response,Object.fromEntries(['status','statusText','url','type','redirected','internal_response','cors_exposed'].filter(key=>metadata[key]!==undefined).map(key=>[key,metadata[key]])));
  return response;
}
export function response_header(response,name){return Reflect.apply(header_get,Reflect.apply(getters.headers,response,[]),[name]);}

export function immutable_response_headers(response){immutable_headers.add(Reflect.apply(getters.headers,response,[]));return response;}
function header_pairs(headers){const pairs=[];Reflect.apply(header_each,headers,[(value,key)=>define(pairs,pairs.length,{value:[key,value],enumerable:true,configurable:true,writable:true})]);return pairs;}
function inner_response(response,metadata=response_metadata(response)){
  return {status:metadata.status,statusText:metadata.statusText,url:metadata.url,type:metadata.type,redirected:metadata.redirected,headers:header_pairs(metadata.headers),has_body:body_get.call(response)!==null,...(metadata.cors_exposed?{cors_exposed:metadata.cors_exposed}:{})};
}
function filtered_response(inner,snapshot,type='opaqueredirect',headers){
  const response=NativeResponse.error(),state={inner,snapshot,type,used:false,mutable:headers!==undefined};filtered.set(response,state);
  if(state.mutable)mutable_filtered_headers.set(response,new Headers(headers));
  Object.defineProperties(response,{
    type:{value:type},url:{value:type==='opaque'?'':inner.url.split('#')[0]},redirected:{value:false},
  });
  return remember_response(response,{status:0,statusText:'',type,url:inner.url,redirected:false,internal_response:inner});
}

export function opaque_redirect_response(response){
  const metadata=response_metadata(response),body=body_get.call(response);
  const inner=inner_response(response,metadata);
  let snapshot;
  if(response_header(response,'location')){
    // A real redirect's body is never used by navigation. Cancel it promptly
    // even when the server leaves that body open indefinitely.
    void body?.cancel().catch(()=>{});snapshot=promise_resolve(body===null?null:new Blob([]));
  }else snapshot=body===null?promise_resolve(null):Reflect.apply(read_blob,response,[]);
  Reflect.apply(promise_then,snapshot,[undefined,()=>{}]);
  return filtered_response(inner,snapshot);
}

export function restore_filtered_response(metadata,body,headers=[]){
  return filtered_response(metadata.internal_response,promise_resolve(metadata.internal_response.has_body?body:null),metadata.type,headers);
}

export function expose_response(response,credentials){
  const metadata=response_metadata(response),inner=inner_response(response,metadata),body=Reflect.apply(body_get,response,[]);
  if(metadata.type==='opaque'){
    const snapshot=body===null?promise_resolve(null):Reflect.apply(read_blob,response,[]);Reflect.apply(promise_then,snapshot,[undefined,()=>{}]);
    return filtered_response(inner,snapshot,'opaque');
  }
  const type=metadata.type==='default'?'basic':metadata.type,forbidden=new Set(['set-cookie','set-cookie2']);
  let headers=inner.headers,cors_exposed;
  if(type==='cors'){
    cors_exposed=metadata.cors_exposed;
    if(!cors_exposed){
      cors_exposed=['cache-control','content-language','content-length','content-type','expires','last-modified','pragma'];
      const exposed=(response_header(response,'access-control-expose-headers')||'').split(',').map(name=>name.trim().toLowerCase());
      if(exposed.every(name=>!name||/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))){
        if(exposed.includes('*')&&credentials!=='include')cors_exposed.push(...Reflect.apply(array_map,headers,[pair=>pair[0]]));
        else cors_exposed.push(...exposed);
      }
    }
    const names=new Set(cors_exposed);headers=Reflect.apply(array_filter,headers,[pair=>names.has(pair[0])]);
  }
  headers=Reflect.apply(array_filter,headers,[pair=>!forbidden.has(pair[0])]);
  const output=new NativeResponse(body,{status:metadata.status,statusText:metadata.statusText,headers});
  Object.defineProperties(output,{url:{value:metadata.url.split('#')[0]},type:{value:type},redirected:{value:metadata.redirected}});
  return immutable_response_headers(remember_response(output,{...metadata,type,...(type==='cors'?{internal_response:{...inner,cors_exposed},cors_exposed}:{})}));
}

// Only cache writes and respondWith consume the hidden body. Script-facing
// text/blob/stream methods continue to see the null body of Response.error().
export function consume_filtered_response(response){
  const state=filtered.get(response);if(!state)return;
  if(state.used)throw new TypeError('Response body is already used');
  if(state.inner.has_body)state.used=true;
  return state.snapshot;
}
