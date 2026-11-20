const NativeURL=globalThis.URL,UnsignedShort=globalThis.Uint16Array;
const url_href=Object.getOwnPropertyDescriptor(NativeURL.prototype,'href').get;
// Keep the native Response constructor and static method behavior, but resolve
// relative redirects against the relevant virtual document or worker URL.
export function create_response_redirect(base,redirect=globalThis.Response.redirect){
  return new Proxy(redirect,{apply(target,receiver,args){
    if(!args.length)return Reflect.apply(target,receiver,args);
    const input=`${args[0]}`;
    let status=302;
    if(args[1]!==undefined){const converted=new UnsignedShort(1);converted[0]=args[1];status=converted[0];}
    // Web IDL converts both arguments before parsing the URL or validating the
    // allowed status codes. A status coercion may itself change the base URL.
    const url=new NativeURL(input,base());
    return Reflect.apply(target,receiver,[Reflect.apply(url_href,url,[]),status]);
  }});
}
