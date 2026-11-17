function parameters(value) {
  const parts=[];let start=0,quoted=false,escaped=false;
  for(let index=0;index<value.length;index++){
    const character=value[index];
    if(escaped){escaped=false;continue;}
    if(character==='\\'&&quoted){escaped=true;continue;}
    if(character==='"')quoted=!quoted;
    if(character===';'&&!quoted){parts.push(value.slice(start,index));start=index+1;}
  }
  parts.push(value.slice(start));return parts;
}

export function content_disposition(value) {
  const [first,...parts]=parameters(String(value||''));
  const type=first.trim().toLowerCase(),values=new Map();
  for(const part of parts){
    const index=part.indexOf('=');if(index<0)continue;
    const name=part.slice(0,index).trim().toLowerCase();let value=part.slice(index+1).trim();
    if(values.has(name))continue;
    if(value.startsWith('"')){
      if(!value.endsWith('"')||value.length<2)continue;
      value=value.slice(1,-1).replace(/\\(.)/g,'$1');
    }
    values.set(name,value);
  }
  let filename=values.get('filename')||null;
  // Chromium accepts percent-encoded UTF-8 in the legacy filename parameter.
  // Decode it here, before considering filename*, without decoding author hints.
  if(filename)try{filename=decodeURIComponent(filename);}catch{}
  const extended=values.get('filename*')?.match(/^([^']*)'[^']*'(.*)$/);
  if(extended){
    const charset=extended[1].toLowerCase();
    if(['utf-8','iso-8859-1'].includes(charset))try{
      const bytes=[];
      for(let index=0;index<extended[2].length;index++){
        const character=extended[2][index];
        if(character==='%'){
          const hex=extended[2].slice(index+1,index+3);if(!/^[\da-f]{2}$/i.test(hex))throw new TypeError('Invalid extended filename');
          bytes.push(parseInt(hex,16));index+=2;
        }else{if(character.charCodeAt(0)>127)throw new TypeError('Invalid extended filename');bytes.push(character.charCodeAt(0));}
      }
      filename=new TextDecoder(charset,{fatal:true}).decode(new Uint8Array(bytes))||filename;
    }catch{}
  }
  return {type,filename,attachment:!!type&&type!=='inline'};
}

export function download_filename(url,disposition,hint) {
  let name=content_disposition(disposition).filename||hint;
  if(!name){
    try{const target=new URL(url);if(/^https?:$/.test(target.protocol)){name=target.pathname.split('/').pop();try{name=decodeURIComponent(name);}catch{}}}catch{}
  }
  // Header filenames are advisory. Retain only a final path component; the
  // browser applies platform-specific filename and extension adjustments.
  name=String(name||'download').replace(/[\u0000-\u001f\u007f]/g,'').split(/[\\/]/).pop().trim();
  return !name||name==='.'||name==='..'?'download':name;
}

export function is_download(headers) {
  if(content_disposition(headers.get('content-disposition')).attachment)return true;
  const type=(headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  return /^(application\/(octet-stream|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|x-msdownload|msword)|text\/(csv|tab-separated-values))$/.test(type)||/^application\/vnd\.(ms-|openxmlformats-|oasis\.opendocument)/.test(type);
}
