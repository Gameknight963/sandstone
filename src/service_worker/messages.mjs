const clone=globalThis.structuredClone,portGetter=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage').get;
export function snapshot_message(value,options,encode=value=>value){
  let transfer;
  if(options==null)transfer=[];
  else{
    const iterator=options[Symbol.iterator];
    if(typeof iterator==='function')transfer=Array.from({[Symbol.iterator]:()=>Reflect.apply(iterator,options,[])});
    else{const list=options.transfer;transfer=list===undefined?[]:Array.from(list);}
  }
  const ports=transfer.filter(value=>{try{portGetter.call(value);return true;}catch{return false;}});
  return clone(encode({data:value,ports}),{transfer});
}
