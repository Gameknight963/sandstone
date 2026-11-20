// Extract only the essence: module decoding is always UTF-8, so charset and
// other MIME parameters do not affect it. Fetch selects the last valid value.
// https://fetch.spec.whatwg.org/#concept-header-extract-mime-type
export function mime_essence(header){
  if(header===null)return null;
  let result=null,start=0,quoted=false;
  for(let index=0;index<=header.length;index++){
    const character=header[index];
    if(quoted&&character==='\\'&&index+1<header.length){index++;continue;}
    if(character==='"'){quoted=!quoted;continue;}
    if(index!==header.length&&(character!==','||quoted))continue;
    const value=header.slice(start,index).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g,'');
    const essence=value.split(';',1)[0].replace(/[\t\n\r ]+$/g,'');
    if(essence!=='*/*'&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(essence))result=essence.toLowerCase();
    start=index+1;
  }
  return result;
}

export function xml_document_type(header){
  const type=mime_essence(header);
  return ['image/svg+xml','application/xhtml+xml','application/xml','text/xml'].includes(type)?type:null;
}
