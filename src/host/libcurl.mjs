import {libcurl} from 'libcurl.js';
import {libcurl_binary} from './libcurl_wasm.mjs';
const native_load=libcurl.load_wasm;
libcurl.load_wasm=()=>native_load(libcurl_binary());
export {libcurl};
