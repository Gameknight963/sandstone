// Keep native body, header, signal and validation behavior while resolving URLs
// against the virtual document or worker rather than its sandbox blob URL.
export function create_request_class(base,source=base) {
  const NativeRequest=globalThis.Request,referrers=new WeakMap();
  return class Request extends NativeRequest {
    constructor(input,init=undefined) {
      if(!arguments.length){super();return;}
      if(init!=null&&!['object','function'].includes(typeof init))throw new TypeError('Request options must be an object');
      const explicit_referrer=init?.referrer;
      let referrer=explicit_referrer!==undefined?String(explicit_referrer):input instanceof NativeRequest?input.referrer:'about:client';
      if(referrer!==''&&referrer!=='about:client'){
        const url=new URL(referrer,base());
        if(url.origin!==new URL(source()).origin)referrer='about:client';
        else{url.username='';url.password='';url.hash='';referrer=url.href;}
      }
      // The native realm has an opaque origin and would discard a valid
      // virtual referrer. Preserve it alongside the otherwise native request.
      const options=new Proxy(init||{},{get(target,key){return key==='referrer'?undefined:Reflect.get(target,key,target);}});
      super(input instanceof NativeRequest?input:new URL(input,base()).href,options);
      referrers.set(this,referrer);
    }
    get referrer(){return referrers.has(this)?referrers.get(this):super.referrer;}
    clone(){
      const copy=super.clone();
      Object.setPrototypeOf(copy,Request.prototype);
      referrers.set(copy,this.referrer);
      return copy;
    }
  };
}
