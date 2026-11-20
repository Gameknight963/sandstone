const entries=globalThis.FormData?.prototype.entries,params=globalThis.URLSearchParams?.prototype.toString;
export function snapshot_sync_body(body){
  if(body==null)return null;
  if(typeof FormData!=='undefined'&&body instanceof FormData)return {kind:'form',entries:[...Reflect.apply(entries,body,[])]};
  if(body instanceof URLSearchParams)return {kind:'params',value:Reflect.apply(params,body,[])};
  if(typeof body==='string'||body instanceof Blob||body instanceof ArrayBuffer||ArrayBuffer.isView(body))return {kind:'body',value:body};
  return {kind:'body',value:`${body}`};
}
export function restore_sync_body(snapshot){
  if(!snapshot)return null;
  if(snapshot.kind==='params')return new URLSearchParams(snapshot.value);
  if(snapshot.kind==='form'){const body=new FormData();for(const [name,value] of snapshot.entries)body.append(name,value);return body;}
  if(snapshot.kind==='body')return snapshot.value;
  throw new TypeError('Invalid synchronous request body');
}
