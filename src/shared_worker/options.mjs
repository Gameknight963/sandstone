const text=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);};

export function shared_worker_options(input){
  if(input!==null&&input!==undefined&&typeof input!=='object'&&typeof input!=='function')return {credentials:'same-origin',name:text(input),type:'classic',extendedLifetime:false};
  input??={};
  const credentialValue=input.credentials,credentials=credentialValue===undefined?'same-origin':text(credentialValue);
  if(!['omit','same-origin','include'].includes(credentials))throw new TypeError('Invalid shared worker credentials');
  const nameValue=input.name,name=nameValue===undefined?'':text(nameValue);
  const typeValue=input.type,type=typeValue===undefined?'classic':text(typeValue);
  if(!['classic','module'].includes(type))throw new TypeError('Invalid shared worker type');
  // Web IDL converts inherited dictionary members before derived members.
  const extendedLifetime=!!input.extendedLifetime;
  return {credentials,name,type,extendedLifetime};
}
