// Accepted beacons belong to their original document, not the frame's current
// navigation. Keep that context briefly for beacons posted by unload handlers.
export class BeaconQueue {
  constructor({fetch, cookies, capture_context=context=>({...context}), grace = 10000, timeout = 30000}) {
    this.fetch = fetch;
    this.cookies = cookies;
    this.capture_context = capture_context;
    this.grace = grace;
    this.timeout = timeout;
    this.contexts = new Map();
    this.pending = new Set();
  }

  register(frame, context, id = Math.random() + ':' + Math.random()) {
    if(typeof id!=='string'||!id||this.contexts.has(id))throw new TypeError('Invalid document context');
    this.contexts.set(id, {frame, context: {...context}, queued: 0});
    return id;
  }

  retire(frame) {
    for (const [id, entry] of this.contexts) {
      if (entry.frame !== frame || entry.retired) continue;
      entry.retired = true;
      const timer = setTimeout(() => this.contexts.delete(id), this.grace);
      timer.unref?.();
    }
  }

  reserve(id, size) {
    const entry = this.contexts.get(id);
    if (!entry || !Number.isSafeInteger(size) || size < 0 || entry.queued + size > 65536) return null;
    entry.queued += size;
    let released = false;
    return {entry, release() { if (!released) { released = true; entry.queued -= size; } }};
  }

  async send(id, url, body, options = {}) {
    if (!(body instanceof Blob)) return false;
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    const lease = this.reserve(id,body.size);
    if (!lease) return false;
    const {entry} = lease;
    let context=entry.context;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    timer.unref?.();
    const request = {id, controller};
    this.pending.add(request);
    try {
      context=this.capture_context(context);
      const response = await this.fetch(target.href, {
        method: 'POST', body: await body.arrayBuffer(),
        headers: {Origin: new URL(context.url).origin, ...(body.type ? {'Content-Type': body.type} : {})},
        mode:!body.type || /^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(body.type) ? 'no-cors' : 'cors',
        referrerPolicy:options.referrerPolicy,
        referrer:options.referrer,
        credentials: 'include', redirect: 'follow', signal: controller.signal
      }, context);
      await response.body?.cancel();
    } catch {
      // Beacon deliberately provides no response/error callback to the page.
    } finally {
      clearTimeout(timer);
      this.pending.delete(request);
      lease.release();
    }
    return {cookies: this.cookies(context.url,context)};
  }
}
