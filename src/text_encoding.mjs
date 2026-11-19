import sniff_encoding from 'html-encoding-sniffer';
import {MIMEType} from 'whatwg-mimetype';
import {legacyHookDecode,labelToName,getBOMEncoding} from '@exodus/bytes/encoding.js';
import {mime_essence} from './mime.mjs';

export function response_charset(contentType){
  const mime=MIMEType.parse(contentType||'');
  return labelToName(mime?.parameters.get('charset'));
}

export function decode_document(bytes,contentType,{fallbackEncoding}={}){
  const mime=mime_essence(contentType),xml=mime==='text/xml'||mime==='application/xml'||mime?.endsWith('+xml');
  const inherited=fallbackEncoding&&labelToName(fallbackEncoding);
  const encoding=sniff_encoding(bytes,{xml,transportLayerEncodingLabel:response_charset(contentType)||undefined,
    defaultEncoding:!xml&&inherited&&!/^UTF-16/.test(inherited)?inherited:undefined});
  return {text:legacyHookDecode(bytes,encoding),encoding};
}

export async function decode_document_response(response,options){
  return decode_document(new Uint8Array(await response.arrayBuffer()),response.headers.get('content-type'),options);
}

export async function decode_classic_response(response,fallbackEncoding='UTF-8'){
  const bytes=new Uint8Array(await response.arrayBuffer());
  return legacyHookDecode(bytes,response_charset(response.headers.get('content-type'))||labelToName(fallbackEncoding)||'UTF-8');
}

export async function decode_stylesheet_response(response,fallbackEncoding='UTF-8'){
  const bytes=new Uint8Array(await response.arrayBuffer());
  const prefix=String.fromCharCode(...bytes.subarray(0,1024));
  let declared=labelToName(/^@charset "([^"]*)";/.exec(prefix)?.[1]);
  if(declared?.startsWith('UTF-16'))declared='UTF-8';
  const encoding=labelToName(getBOMEncoding(bytes))||response_charset(response.headers.get('content-type'))||declared||labelToName(fallbackEncoding)||'UTF-8';
  return {text:legacyHookDecode(bytes,encoding),encoding};
}
