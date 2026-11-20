// Relay and cache responses retain their internal response type and URL even
// when authored code shadows the public properties.
const records=new WeakMap();
const getters=Object.fromEntries(['status','statusText','url','type','redirected','headers'].map(key=>[key,Object.getOwnPropertyDescriptor(Response.prototype,key).get]));
export function response_metadata(response){
  const native=Object.fromEntries(Object.entries(getters).map(([key,get])=>[key,get.call(response)]));
  return {...native,...records.get(response),headers:native.headers};
}
export function remember_response(response,metadata){
  getters.status.call(response);
  records.set(response,Object.fromEntries(['status','statusText','url','type','redirected'].filter(key=>metadata[key]!==undefined).map(key=>[key,metadata[key]])));
  return response;
}
