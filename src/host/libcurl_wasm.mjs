import binary from 'libcurl.js/libcurl.wasm';
// Both host realms use the same embedded bytes; the backend receives them on
// its private initialization port instead of adding a second copy to the HTML.
export function libcurl_binary(){return binary;}
