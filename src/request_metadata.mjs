const records=new WeakMap();
export const request_metadata=request=>records.get(request);
export function remember_request(request,metadata){records.set(request,{...metadata});return request;}
