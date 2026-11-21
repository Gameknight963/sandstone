import {define_event_handlers} from './event_handlers.mjs';

// Admit sends and closes synchronously to the host. Its queue can drain native
// Blob bytes even after this document is retired.
export function create_websocket_class({base, connect, events, send, close}) {
  class WebSocket extends EventTarget {
    #id;
    #state = 0;
    #url;
    #protocol = '';
    #binaryType = 'blob';
    #buffered = 0;
    #closedDuringConnect = false;

    constructor(url, protocols = []) {
      super();
      if (!arguments.length) throw new TypeError('WebSocket requires a URL');
      let parsed;
      try { parsed = new URL(url, base()); }
      catch { throw new DOMException('Invalid WebSocket URL', 'SyntaxError'); }
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.hash || parsed.href.includes('#'))
        throw new DOMException('Invalid WebSocket URL', 'SyntaxError');
      protocols = typeof protocols === 'string' ? [protocols] : Array.from(protocols, String);
      if (new Set(protocols).size !== protocols.length || protocols.some(value => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)))
        throw new DOMException('Invalid WebSocket protocols', 'SyntaxError');
      this.#url = parsed.href;
      this.#connect(protocols);
    }

    get url() { return this.#url; }
    get readyState() { return this.#state; }
    get protocol() { return this.#protocol; }
    get extensions() { return ''; }
    get bufferedAmount() { return this.#buffered; }
    get binaryType() { return this.#binaryType; }
    set binaryType(value) { if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value; }

    async #connect(protocols) {
      try {
        this.#id = await connect(this.#url, protocols);
        if (this.#state === 2) { await close(this.#id,undefined,'',true); this.#finish(true); return; }
        while (this.#state !== 3) {
          const batch = await events(this.#id);
          if (!batch) { this.#finish(true); break; }
          for (const [type, data] of batch) {
            if (this.#state === 3) break;
            if (type === 'open' && this.#state === 0) {
              this.#protocol = data?.protocol || '';
              this.#state = 1;
              this.dispatchEvent(new Event('open'));
            } else if (type === 'message' && this.#state === 1) {
              const bytes = typeof data === 'string' ? null : new Uint8Array(data);
              const value = bytes ? this.#binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer : data;
              this.dispatchEvent(new MessageEvent('message', {data: value, origin: new URL(this.#url).origin}));
            } else if (type === 'error') {
              this.#finish(true);
            } else if (type === 'close') {
              this.#finish(false,data);
            }
          }
        }
      } catch { this.#fail(); }
    }

    #fail() {
      if (this.#id !== undefined) Promise.resolve().then(() => close(this.#id,undefined,'',true)).catch(() => {});
      this.#finish(true);
    }

    #finish(error,info) {
      if (this.#state === 3) return;
      this.#state = 3;
      if (error || this.#closedDuringConnect) this.dispatchEvent(new Event('error'));
      const details=!error&&info?{code:info.code,reason:info.reason,wasClean:info.wasClean}:{code:1006,reason:'',wasClean:false};
      this.dispatchEvent(new CloseEvent('close', details));
    }

    send(data) {
      if (!arguments.length) throw new TypeError('send requires data');
      if (this.#state === 0) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      let bytes;
      if (data instanceof Blob) bytes = data.size;
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        data = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0, data.byteLength).slice();
        bytes = data.byteLength;
      } else { data = String(data); bytes = new TextEncoder().encode(data).length; }
      this.#buffered += bytes;
      if (this.#state !== 1) return;
      try{Promise.resolve(send(this.#id,data)).then(()=>{this.#buffered-=bytes;},()=>this.#fail());}
      catch{queueMicrotask(()=>this.#fail());}
    }

    close(code=undefined, reason = '') {
      const provided=code!==undefined;
      if (provided) {
        code = (+code) >>> 0;
        code &= 65535;
      }
      if(typeof reason==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
      reason=String(reason);
      const reasonBytes=new TextEncoder().encode(reason);
      if(provided||reason!==''){
        if (code !== 1000 && !(code >= 3000 && code <= 4999))
          throw new DOMException('Invalid close code', 'InvalidAccessError');
      }
      if (reasonBytes.length > 123)
        throw new DOMException('Close reason exceeds 123 UTF-8 bytes', 'SyntaxError');
      if (this.#state >= 2) return;
      const connecting = this.#state === 0;
      this.#closedDuringConnect = connecting;
      this.#state = 2;
      if (this.#id !== undefined) {
        try{Promise.resolve(close(this.#id,code,reason,connecting)).then(()=>{if(connecting)this.#finish(true);},()=>this.#finish(true));}
        catch{queueMicrotask(()=>this.#finish(true));}
      }
    }
  }
  define_event_handlers(WebSocket.prototype, ['open', 'message', 'error', 'close']);
  for (const [name, value] of Object.entries({CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3})) {
    Object.defineProperty(WebSocket, name, {value, enumerable: true});
    Object.defineProperty(WebSocket.prototype, name, {value, enumerable: true});
  }
  return WebSocket;
}
