import binary from '../../vendor/native/css.wasm';
import {initialize_native_css} from './css.mjs';

export function start_native_css(){
  // Inline bytes avoid fetch, file:// CORS and an extra asset beside the HTML.
  const value=atob(binary.slice(binary.indexOf(',')+1));
  return initialize_native_css(Uint8Array.from(value,character=>character.charCodeAt(0)));
}
