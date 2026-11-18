// JavaScript MIME essences from the MIME Sniffing standard. Attribute values
// are matched as essences, so MIME parameters do not enable a script.
const javascript=new Set([
  'application/ecmascript','application/javascript','application/x-ecmascript','application/x-javascript',
  'text/ecmascript','text/javascript','text/javascript1.0','text/javascript1.1','text/javascript1.2',
  'text/javascript1.3','text/javascript1.4','text/javascript1.5','text/jscript','text/livescript',
  'text/x-ecmascript','text/x-javascript'
]);
const lower=value=>value.replace(/[A-Z]/g,letter=>letter.toLowerCase());
export function script_kind(type,language=null){
  if(type===null){
    if(language===null||language==='')return 'classic';
    return javascript.has(lower('text/'+language))?'classic':null;
  }
  if(type==='')return 'classic';
  const keyword=lower(type);
  if(keyword==='module'||keyword==='importmap')return keyword;
  // Native engines also accept vertical tab around classic MIME types. Do
  // not use String.trim(): NBSP and BOM must remain non-JavaScript data types.
  const essence=lower(type.replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g,''));
  return javascript.has(essence)?'classic':null;
}
export function svg_script_kind(type){const kind=script_kind(type);return kind==='classic'||kind==='module'?kind:null;}
