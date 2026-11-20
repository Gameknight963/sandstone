// Keep native body, header, signal and validation behavior while resolving URLs
// against the virtual document or worker rather than its sandbox blob URL.
import {request_metadata,remember_request} from '../request_metadata.mjs';
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
        const origin=new URL(source()).origin;
        if(origin==='null'||url.origin!==origin)referrer='about:client';
        else referrer=url.href;
      }
      // The native realm has an opaque origin and would discard a valid
      // virtual referrer. Preserve it alongside the otherwise native request.
      let explicit_mode;
      const options=new Proxy(init||{},{get(target,key){if(key==='referrer')return undefined;const value=Reflect.get(target,key,target);if(key==='mode')explicit_mode=value;return value;}});
      super(input instanceof NativeRequest?input:new URL(input,base()).href,options);
      referrers.set(this,referrer);
      if(input instanceof NativeRequest&&request_metadata(input)){
        const metadata={...request_metadata(input)};
        delete metadata.destination;
        if(explicit_referrer!==undefined)delete metadata.referrer;
        if(explicit_mode!==undefined)delete metadata.mode;
        remember_request(this,metadata);
      }
    }
    get referrer(){return request_metadata(this)?.referrer??(referrers.has(this)?referrers.get(this):super.referrer);}
    get destination(){return request_metadata(this)?.destination??super.destination;}
    get mode(){return request_metadata(this)?.mode??super.mode;}
    clone(){
      const copy=super.clone();
      Object.setPrototypeOf(copy,Request.prototype);
      referrers.set(copy,this.referrer);
      if(request_metadata(this))remember_request(copy,request_metadata(this));
      return copy;
    }
  };
}
