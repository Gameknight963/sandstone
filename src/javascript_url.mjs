const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const encode=encoder.encode.bind(encoder),decode=decoder.decode.bind(decoder),Bytes=Uint8Array,subarray=Uint8Array.prototype.subarray;
const Characters=Array,join=Array.prototype.join,from_char=String.fromCharCode;
const hex=value=>value>=48&&value<=57?value-48:value>=65&&value<=70?value-55:value>=97&&value<=102?value-87:-1;

// HTML evaluates the serialized URL after its scheme, percent-decoded as
// bytes and then decoded as UTF-8. Invalid escapes stay literal. Chromium's
// legacy fallback maps every byte in the source to a character if any UTF-8
// sequence is invalid, including otherwise valid sequences elsewhere.
export function javascript_url_source(url){
  const bytes=encode(url.slice(url.indexOf(':')+1)),result=new Bytes(bytes.length);let length=0;
  for(let index=0;index<bytes.length;index++){
    const high=hex(bytes[index+1]),low=hex(bytes[index+2]);
    if(bytes[index]===37&&high>=0&&low>=0){result[length++]=high*16+low;index+=2;}
    else result[length++]=bytes[index];
  }
  try{return decode(subarray.call(result,0,length));}
  catch{
    const characters=new Characters(length);
    for(let index=0;index<length;index++)characters[index]=from_char(result[index]);
    return join.call(characters,'');
  }
}
