// Keepalive fetches belong to a document context, including after its frame has
// navigated. Pump responses independently of page reads so byte quota is freed
// on network completion. Once retired, discard response bytes as they arrive.
export class KeepaliveRequests {
  constructor({queue, fetch, cookies, timeout = 30000}) {
    Object.assign(this,{queue,fetch,cookies,timeout});
    this.requests = new Map();
  }
  key(context,id) { return context+':'+id; }
  finish(record) {
    if (record.done) return;
    record.done = true;
    clearTimeout(record.timer);
    record.lease.release();
    record.resolve();
    record.wake?.();
    if (record.detached) this.requests.delete(record.key);
  }
  async open(context,id,url,options) {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new TypeError('Invalid keepalive URL');
    const size = options.body == null ? 0 : new Blob([options.body]).size;
    const lease = this.queue.reserve(context,size);
    if (!lease) throw new TypeError('Keepalive request quota exceeded or document expired');
    const key = this.key(context,id);
    if (this.requests.has(key)) { lease.release(); throw new TypeError('Duplicate keepalive request'); }
    const record = {key,lease,frame:lease.entry.frame,controller:new AbortController(),reader:null,
      chunks:[],done:false,error:null,wake:null,detached:!!lease.entry.retired,resolve:null};
    record.completion = new Promise(resolve=>{record.resolve=resolve;});
    record.timer = setTimeout(()=>this.abort(context,id,new DOMException('Keepalive request timed out','TimeoutError')),this.timeout);
    record.timer.unref?.();
    this.requests.set(key,record);
    try {
      const init = {...options,signal:record.controller.signal};
      delete init.keepalive;
      const response = await this.fetch(target.href,init,lease.entry.context);
      if (record.controller.signal.aborted) {
        await response.body?.cancel();
        throw record.controller.signal.reason;
      }
      record.reader = response.body?.getReader();
      const has_body = !!record.reader && !record.detached;
      if (record.reader) this.pump(record);
      else { this.finish(record); this.requests.delete(key); }
      return {has_body,request_referrer:response.request_referrer,
        headers:[...response.headers].filter(([name])=>!['set-cookie','set-cookie2'].includes(name.toLowerCase())),
        items:Object.fromEntries(['ok','redirected','status','statusText','type','url'].map(name=>[name,response[name]])),
        cookies:this.cookies(lease.entry.context.url,lease.entry.context)};
    } catch (error) {
      record.error = error;
      this.finish(record);
      this.requests.delete(key);
      throw error;
    }
  }
  async pump(record) {
    try {
      while (!record.done) {
        const chunk = await record.reader.read();
        if (chunk.done) break;
        if (!record.detached && !record.done) record.chunks.push(chunk.value);
        record.wake?.();
      }
    } catch (error) { record.error = error; }
    this.finish(record);
  }
  async read(context,id) {
    const key = this.key(context,id), record = this.requests.get(key);
    if (!record) return {done:true};
    while (!record.chunks.length && !record.done && !record.detached) await new Promise(resolve=>{record.wake=resolve;});
    record.wake = null;
    if (record.error) { this.requests.delete(key); throw record.error; }
    if (record.chunks.length) return {done:false,value:record.chunks.shift()};
    if (!record.detached || record.done) this.requests.delete(key);
    return {done:true};
  }
  completed(context,id) { return this.requests.get(this.key(context,id))?.completion; }
  abort(context,id,error = new DOMException('Aborted','AbortError')) {
    const record = this.requests.get(this.key(context,id));
    if (!record) return;
    record.error = error;
    record.chunks.length = 0;
    record.controller.abort(error);
    record.reader?.cancel(error).catch(()=>{});
    this.finish(record);
    this.requests.delete(record.key);
  }
  retire(frame) {
    for (const record of this.requests.values()) {
      if (record.frame !== frame) continue;
      record.detached = true;
      record.chunks.length = 0;
      record.wake?.();
      if (record.done) this.requests.delete(record.key);
    }
  }
}
