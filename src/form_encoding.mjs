import {labelToName} from '@exodus/bytes/encoding.js';
import {percentEncodeAfterEncoding} from '@exodus/bytes/whatwg.js';

const printable=Array.from({length:95},(_,index)=>String.fromCharCode(index+32)).join('');
const urlencoded=Array.from(printable).filter(character=>!/[a-z\d*._-]/i.test(character)).join('');
const utf8=new TextEncoder();
const file_name=Object.getOwnPropertyDescriptor(File.prototype,'name').get,blob_type=Object.getOwnPropertyDescriptor(Blob.prototype,'type').get;
export const form_newlines=value=>value.replace(/\r\n|\r|\n/g,'\r\n');
const quote=value=>value.replace(/[\r\n"]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0'));

export function form_encoding(acceptCharset,documentEncoding='UTF-8'){
  const encoding=(acceptCharset||'').split(/[\t\n\f\r ]+/).map(labelToName).find(Boolean)||labelToName(documentEncoding)||'UTF-8';
  return encoding==='replacement'||encoding.startsWith('UTF-16')?'UTF-8':encoding;
}
export function form_pairs(data){
  return Array.from(data,([name,value])=>[form_newlines(name),form_newlines(typeof value==='string'?value:file_name.call(value))]);
}
export function form_urlencoded(pairs,encoding){
  const encode=value=>percentEncodeAfterEncoding(encoding,value,urlencoded,true);
  return pairs.map(([name,value])=>encode(name)+'='+encode(value)).join('&');
}
export function form_bytes(text,encoding){
  if(encoding==='UTF-8')return utf8.encode(text);
  const escaped=percentEncodeAfterEncoding(encoding,text,printable),bytes=[];
  for(let index=0;index<escaped.length;index++){
    if(escaped[index]==='%'){bytes.push(parseInt(escaped.slice(index+1,index+3),16));index+=2;}
    else bytes.push(escaped.charCodeAt(index));
  }
  return Uint8Array.from(bytes);
}
export function form_plaintext(pairs,encoding){
  return form_bytes(pairs.map(([name,value])=>name+'='+value+'\r\n').join(''),encoding);
}
export function form_multipart(data,encoding){
  const boundary='----sandstone-form-'+crypto.randomUUID().replaceAll('-',''),parts=[];
  for(const [name,value] of data){
    let header='--'+boundary+'\r\nContent-Disposition: form-data; name="'+quote(form_newlines(name))+'"';
    if(typeof value==='string')parts.push(form_bytes(header+'\r\n\r\n'+form_newlines(value)+'\r\n',encoding));
    else parts.push(form_bytes(header+'; filename="'+quote(file_name.call(value))+'"\r\nContent-Type: '+(blob_type.call(value)||'application/octet-stream')+'\r\n\r\n',encoding),value,'\r\n');
  }
  parts.push('--'+boundary+'--\r\n');
  return new Blob(parts,{type:'multipart/form-data; boundary='+boundary});
}
