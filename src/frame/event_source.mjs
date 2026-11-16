import { define_event_handlers } from './event_handlers.mjs';

export class EventStreamParser {
  #decoder = new TextDecoder();
  #line = '';
  #skipLF = false;
  #data = [];
  #type = '';
  #id = '';
  constructor({event, id = () => {}, retry = () => {}, lastEventId = ''}) {
    this.callbacks = {event, id, retry};
    this.#id = lastEventId;
  }
  #parse(line) {
    if (!line) {
      this.callbacks.id(this.#id);
      const data = this.#data, type = this.#type;
      this.#data = []; this.#type = '';
      if (data.length) this.callbacks.event({type: type || 'message', data: data.join('\n'), lastEventId: this.#id});
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#type = value;
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.callbacks.retry(Math.min(Number(value), Number.MAX_SAFE_INTEGER));
  }
  #text(text) {
    for (const character of text) {
      if (this.#skipLF) { this.#skipLF = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        const line = this.#line; this.#line = '';
        this.#skipLF = character === '\r';
        this.#parse(line);
      } else this.#line += character;
    }
  }
  push(bytes) { this.#text(this.#decoder.decode(bytes, {stream: true})); }
  finish() { this.#text(this.#decoder.decode()); this.#line = ''; this.#data = []; this.#type = ''; }
}

export function create_event_source_class({fetch, base, onUnload, defaultRetry = 3000}) {
  class EventSource extends EventTarget {
    #url;
    #credentials;
    #state = 0;
    #lastID = '';
    #retry = defaultRetry;
    #controller;
    #reader;
    #timer;
    #tasks = new Set();
    #removeUnload;
    constructor(url, options = {}) {
      super();
      if (!arguments.length) throw new TypeError('EventSource requires a URL');
      try { this.#url = new URL(url, base()).href; } catch { throw new DOMException('Invalid event stream URL', 'SyntaxError'); }
      this.#credentials = Boolean(options?.withCredentials);
      this.#removeUnload = onUnload?.(() => this.close());
      this.#connect();
    }
    get url() { return this.#url; }
    get withCredentials() { return this.#credentials; }
    get readyState() { return this.#state; }
    #queue(callback) {
      const task = setTimeout(() => {
        this.#tasks.delete(task);
        if (this.#state !== 2) callback();
      }, 0);
      this.#tasks.add(task);
    }
    async #connect() {
      if (this.#state === 2) return;
      const url = new URL(this.#url); url.hash = '';
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) { this.#fail(); return; }
      const controller = this.#controller = new AbortController();
      try {
        const headers = {Accept: 'text/event-stream'};
        if (this.#lastID) headers['Last-Event-ID'] = this.#lastID;
        const response = await fetch(url.href, {
          method: 'GET', headers, cache: 'no-store', credentials: this.#credentials ? 'include' : 'same-origin', signal: controller.signal
        });
        if (this.#state === 2) { await response.body?.cancel(); return; }
        if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
          await response.body?.cancel(); this.#fail(); return;
        }
        const origin = new URL(response.url || url.href).origin;
        this.#queue(() => { this.#state = 1; this.dispatchEvent(new Event('open')); });
        const parser = new EventStreamParser({
          lastEventId: this.#lastID,
          id: value => { this.#lastID = value; },
          retry: value => { this.#retry = value; },
          event: value => this.#queue(() => this.dispatchEvent(new MessageEvent(value.type, {...value, origin})))
        });
        const reader = this.#reader = response.body?.getReader();
        while (reader && this.#state !== 2) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (this.#state !== 2) parser.push(chunk.value);
        }
        if (this.#state !== 2) parser.finish();
      } catch {
        if (this.#state === 2 || controller.signal.aborted) return;
      } finally { this.#reader = undefined; }
      if (this.#state !== 2) this.#queue(() => {
        this.#state = 0;
        this.dispatchEvent(new Event('error'));
        if (this.#state !== 2) this.#reconnect(performance.now() + this.#retry);
      });
    }
    #reconnect(deadline) {
      const remaining = Math.max(0, deadline - performance.now());
      this.#timer = setTimeout(() => {
        if (this.#state === 2) return;
        if (performance.now() < deadline) this.#reconnect(deadline);
        else this.#connect();
      }, Math.min(remaining, 0x7fffffff));
    }
    #fail() { this.#queue(() => { this.close(); this.dispatchEvent(new Event('error')); }); }
    close() {
      this.#state = 2;
      clearTimeout(this.#timer);
      for (const task of this.#tasks) clearTimeout(task);
      this.#tasks.clear();
      this.#controller?.abort();
      this.#reader?.cancel().catch(() => {});
      this.#removeUnload?.(); this.#removeUnload = undefined;
    }
    get [Symbol.toStringTag]() { return 'EventSource'; }
  }
  define_event_handlers(EventSource.prototype, ['open', 'message', 'error']);
  for (const [key, value] of Object.entries({CONNECTING: 0, OPEN: 1, CLOSED: 2})) {
    for (const target of [EventSource, EventSource.prototype]) Object.defineProperty(target, key, {value, enumerable: true});
  }
  return EventSource;
}
