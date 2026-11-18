export const bootstrap_attribute='data-sandstone-bootstrap';
export const bootstrap_global='__sandstone_bootstrap__';
export function create_bootstrap_nonce(crypto=globalThis.crypto){
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
}
export function bootstrap_html(html,nonce,channels=1){
  const value=encodeURIComponent(JSON.stringify({nonce,channels}));
  return html.replace(/<script\b([^>]*)>/i,(_,attributes)=>'<script'+attributes.replace(/\sdata-sandstone-bootstrap\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')+' '+bootstrap_attribute+'="'+value+'">');
}
export function bootstrap_worker(source,nonce){return 'globalThis.'+bootstrap_global+'='+JSON.stringify({nonce,channels:1})+';\n'+source;}
