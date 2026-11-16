import { serialize_request } from './polyfill/request.mjs';
import { define_event_handlers as handlers } from './event_handlers.mjs';

const progress_types = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
const forbidden_headers = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
const cookie_header = name => /^set-cookie2?$/i.test(name);
const invalid_state = () => new DOMException('The request is not in a valid state', 'InvalidStateError');

function progress(type, loaded = 0, total = 0) {
  const properties = {loaded, total, lengthComputable: total > 0};
  if (typeof ProgressEvent !== 'undefined') return new ProgressEvent(type, properties);
  const event = new Event(type);
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, {value});
  return event;
}

function charset(mime) {
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(mime || '');
  return match?.[1] || match?.[2];
}

// The transport is injected so lifecycle and streaming behavior can be tested
// independently of the iframe runtime. Remote requests always use the relay.
export function create_xhr_class({fetch, base, isWorker = false}) {
  class XMLHttpRequestEventTarget extends EventTarget {}
  handlers(XMLHttpRequestEventTarget.prototype, progress_types);
  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {
    get [Symbol.toStringTag]() { return 'XMLHttpRequestUpload'; }
  }
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    #state = 0;
    #sending = false;
    #generation = 0;
    #controller;
    #timer;
    #started = 0;
    #timeout = 0;
    #credentials = false;
    #type = '';
    #mime = null;
    #url;
    #method;
    #headers = new Headers();
    #response = null;
    #chunks = [];
    #received = 0;
    #bytes;
    #object;
    #upload = new XMLHttpRequestUpload();
    #uploadComplete = true;

    get readyState() { return this.#state; }
    get upload() { return this.#upload; }
    get timeout() { return this.#timeout; }
    set timeout(value) { this.#timeout = Number(value) >>> 0; this.#schedule_timeout(); }
    get withCredentials() { return this.#credentials; }
    set withCredentials(value) {
      if (this.#state > 1 || this.#sending) throw invalid_state();
      this.#credentials = Boolean(value);
    }
    get responseType() { return this.#type; }
    set responseType(value) {
      value = String(value);
      if (!['', 'text', 'json', 'arraybuffer', 'blob', 'document'].includes(value)) return;
      if (isWorker && value === 'document') return;
      if (this.#state >= 3) throw invalid_state();
      this.#type = value;
    }

    #clear_response() {
      this.#response = null;
      this.#chunks = [];
      this.#received = 0;
      this.#bytes = this.#object = undefined;
    }
    #alive(generation) { return generation === this.#generation && this.#sending; }
    #state_event(state) {
      this.#state = state;
      this.dispatchEvent(new Event('readystatechange'));
    }
    #schedule_timeout() {
      clearTimeout(this.#timer);
      if (!this.#sending || !this.#timeout) return;
      const generation = this.#generation;
      const remaining = Math.max(0, this.#timeout - (performance.now() - this.#started));
      this.#timer = setTimeout(() => {
        if (!this.#alive(generation)) return;
        if (performance.now() - this.#started < this.#timeout) this.#schedule_timeout();
        else this.#fail('timeout', generation);
      }, Math.min(remaining, 0x7fffffff));
    }
    #fail(type, generation) {
      if (!this.#alive(generation)) return;
      this.#sending = false;
      clearTimeout(this.#timer);
      this.#controller?.abort();
      this.#clear_response();
      this.#state_event(4);
      if (generation !== this.#generation) return;
      if (!this.#uploadComplete) {
        this.#uploadComplete = true;
        this.#upload.dispatchEvent(progress(type));
        if (generation !== this.#generation) return;
        this.#upload.dispatchEvent(progress('loadend'));
      }
      if (generation !== this.#generation) return;
      this.dispatchEvent(progress(type));
      if (generation === this.#generation) this.dispatchEvent(progress('loadend'));
    }

    open(method, url, async = true, user, password) {
      if (arguments.length < 2) throw new TypeError('open requires a method and URL');
      method = String(method);
      if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(method)) throw new DOMException('Invalid HTTP method', 'SyntaxError');
      if (/^(CONNECT|TRACE|TRACK)$/i.test(method)) throw new DOMException('Forbidden HTTP method', 'SecurityError');
      if (/^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(method)) method = method.toUpperCase();
      let target;
      try { target = new URL(url, base()); } catch { throw new DOMException('Invalid request URL', 'SyntaxError'); }
      if (!async) throw new DOMException('Synchronous remote requests are unavailable through the relay', 'InvalidAccessError');
      if (user !== undefined && user !== null) target.username = String(user);
      if (password !== undefined && password !== null) target.password = String(password);
      const headers = new Headers();
      if (target.username || target.password) {
        const bytes = new TextEncoder().encode(decodeURIComponent(target.username) + ':' + decodeURIComponent(target.password));
        headers.set('Authorization', 'Basic ' + btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')));
        target.username = target.password = '';
      }
      this.#generation++;
      this.#controller?.abort();
      clearTimeout(this.#timer);
      this.#sending = false;
      this.#clear_response();
      this.#mime = null;
      this.#uploadComplete = true;
      this.#url = target.href;
      this.#method = method;
      this.#headers = headers;
      if (this.#state !== 1) this.#state_event(1);
    }
    setRequestHeader(name, value) {
      if (this.#state !== 1 || this.#sending) throw invalid_state();
      if (arguments.length < 2) throw new TypeError('setRequestHeader requires a name and value');
      const checked = new Headers();
      try { checked.append(name, value); } catch { throw new DOMException('Invalid request header', 'SyntaxError'); }
      name = String(name);
      if (forbidden_headers.test(name)) return;
      this.#headers.append(name, checked.get(name));
    }
    overrideMimeType(value) {
      if (this.#state >= 3) throw invalid_state();
      if (!arguments.length) throw new TypeError('overrideMimeType requires a MIME type');
      value = String(value).trim();
      this.#mime = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;|$)/.test(value) ? value : 'application/octet-stream';
    }
    send(body = null) {
      if (this.#state !== 1 || this.#sending) throw invalid_state();
      if (/^(GET|HEAD)$/.test(this.#method)) body = null;
      const headers = new Headers(this.#headers);
      if (typeof Document !== 'undefined' && body instanceof Document) {
        if (!headers.has('content-type')) headers.set('content-type', body.contentType === 'text/html' ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8');
        body = new XMLSerializer().serializeToString(body);
      }
      if (typeof body === 'string' && headers.has('content-type')) {
        headers.set('content-type', headers.get('content-type').replace(/(;\s*charset\s*=\s*)(?:"[^"]*"|[^;\s]+)/i, '$1UTF-8'));
      }
      this.#sending = true;
      this.#clear_response();
      this.#controller = new AbortController();
      this.#started = performance.now();
      this.#uploadComplete = body === null;
      const generation = ++this.#generation;
      this.#schedule_timeout();
      this.dispatchEvent(progress('loadstart'));
      if (!this.#alive(generation)) return;
      if (!this.#uploadComplete) this.#upload.dispatchEvent(progress('loadstart'));
      if (!this.#alive(generation)) return;
      this.#run(body, headers, generation);
    }
    async #run(body, headers, generation) {
      try {
        const signal = this.#controller.signal;
        const request = await serialize_request(this.#url, {
          method: this.#method, headers, body: body === null ? undefined : body,
          credentials: this.#credentials ? 'include' : 'same-origin', signal
        }, base());
        if (!this.#alive(generation)) return;
        const response = await fetch(request.url, {...request.options, signal});
        if (!this.#alive(generation)) { await response.body?.cancel(); return; }
        if (!this.#uploadComplete) {
          this.#uploadComplete = true;
          const size = request.options.body?.byteLength || 0;
          for (const type of ['progress', 'load', 'loadend']) {
            this.#upload.dispatchEvent(progress(type, size, size));
            if (!this.#alive(generation)) { await response.body?.cancel(); return; }
          }
        }
        this.#response = response;
        this.#state_event(2);
        if (!this.#alive(generation)) { await response.body?.cancel(); return; }
        const length = response.headers.get('content-length');
        const total = /^\d+$/.test(length || '') ? Number(length) : 0;
        const reader = response.body?.getReader();
        let lastProgress = this.#started;
        while (reader) {
          const chunk = await reader.read();
          if (!this.#alive(generation)) { await reader.cancel(); return; }
          if (chunk.done) break;
          this.#chunks.push(chunk.value);
          this.#received += chunk.value.byteLength;
          this.#bytes = undefined;
          this.#state_event(3);
          if (!this.#alive(generation)) { await reader.cancel(); return; }
          if (performance.now() - lastProgress >= 50) {
            lastProgress = performance.now();
            this.dispatchEvent(progress('progress', this.#received, total));
            if (!this.#alive(generation)) { await reader.cancel(); return; }
          }
        }
        this.dispatchEvent(progress('progress', this.#received, total));
        if (!this.#alive(generation)) return;
        this.#sending = false;
        clearTimeout(this.#timer);
        this.#state_event(4);
        if (generation !== this.#generation) return;
        this.dispatchEvent(progress('load', this.#received, total));
        if (generation === this.#generation) this.dispatchEvent(progress('loadend', this.#received, total));
      } catch { this.#fail('error', generation); }
    }
    abort() {
      const generation = this.#generation;
      this.#controller?.abort();
      this.#fail('abort', generation);
      if (generation === this.#generation && this.#state === 4) {
        this.#generation++;
        this.#state = 0;
        this.#clear_response();
      }
    }
    get status() { return this.#response?.status || 0; }
    get statusText() { return this.#response?.statusText || ''; }
    get responseURL() { return (this.#response?.url || (this.#response ? this.#url : '')).split('#')[0]; }
    getResponseHeader(name) {
      if (!arguments.length) throw new TypeError('getResponseHeader requires a name');
      return !this.#response || cookie_header(String(name)) ? null : this.#response.headers.get(name);
    }
    getAllResponseHeaders() {
      if (!this.#response) return '';
      return [...this.#response.headers].filter(([key]) => !cookie_header(key)).map(([key, value]) => `${key.toLowerCase()}: ${value}\r\n`).join('');
    }
    #all_bytes() {
      if (!this.#bytes) {
        this.#bytes = new Uint8Array(this.#received);
        let offset = 0;
        for (const chunk of this.#chunks) { this.#bytes.set(chunk, offset); offset += chunk.byteLength; }
      }
      return this.#bytes;
    }
    #final_mime() { return this.#mime || this.#response?.headers.get('content-type') || 'text/xml'; }
    #text(json = false) {
      const bytes = this.#all_bytes();
      let encoding = json ? 'utf-8' : charset(this.#mime) || charset(this.#response?.headers.get('content-type'));
      if (!json && !encoding && /(?:\/xml|\+xml)(?:;|$)/i.test(this.#final_mime())) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
        else encoding = /^<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)['"]/i.exec(new TextDecoder().decode(bytes.subarray(0, 512)))?.[1];
      }
      let decoder;
      try { decoder = new TextDecoder(encoding || 'utf-8'); } catch { decoder = new TextDecoder(); }
      return decoder.decode(bytes);
    }
    get responseText() {
      if (this.#type !== '' && this.#type !== 'text') throw invalid_state();
      return this.#state >= 3 && this.#response ? this.#text() : '';
    }
    get response() {
      if (this.#type === '' || this.#type === 'text') return this.responseText;
      if (this.#state !== 4 || !this.#response) return null;
      if (this.#object !== undefined) return this.#object;
      if (this.#type === 'arraybuffer') this.#object = this.#all_bytes().buffer;
      if (this.#type === 'blob') this.#object = new Blob([this.#all_bytes()], {type: this.#final_mime()});
      if (this.#type === 'json') {
        try { this.#object = JSON.parse(this.#text(true)); } catch { this.#object = null; }
      }
      if (this.#type === 'document') this.#object = this.#document();
      return this.#object;
    }
    #document() {
      if (isWorker || typeof DOMParser === 'undefined') return null;
      const mime = this.#final_mime().split(';')[0].trim().toLowerCase();
      const html = mime === 'text/html';
      if (html && this.#type !== 'document' || !html && !/(?:\/xml|\+xml)$/.test(mime)) return null;
      const document = new DOMParser().parseFromString(this.#text(), html ? 'text/html' : 'application/xml');
      if (!html && ['http://www.mozilla.org/newlayout/xml/parsererror.xml', 'http://www.w3.org/1999/xhtml'].some(namespace =>
        document.getElementsByTagNameNS(namespace, 'parsererror').length)) return null;
      for (const key of ['URL', 'documentURI', 'baseURI']) Object.defineProperty(document, key, {value: this.responseURL, configurable: true});
      return document;
    }
    get responseXML() {
      if (this.#type !== '' && this.#type !== 'document') throw invalid_state();
      if (this.#state !== 4 || !this.#response) return null;
      if (this.#object === undefined) this.#object = this.#document();
      return this.#object;
    }
    get [Symbol.toStringTag]() { return 'XMLHttpRequest'; }
  }
  handlers(XMLHttpRequest.prototype, ['readystatechange']);
  for (const [key, value] of Object.entries({UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4})) {
    for (const target of [XMLHttpRequest, XMLHttpRequest.prototype]) Object.defineProperty(target, key, {value, enumerable: true});
  }
  Object.defineProperties(XMLHttpRequest, {Upload: {value: XMLHttpRequestUpload}, EventTarget: {value: XMLHttpRequestEventTarget}});
  return XMLHttpRequest;
}
