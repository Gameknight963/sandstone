// Accepted beacons belong to their original document, not the frame's current
// navigation. Keep that context briefly for beacons posted by unload handlers.
export class BeaconQueue {
  constructor({fetch, cookies, grace = 10000, timeout = 30000}) {
    this.fetch = fetch;
    this.cookies = cookies;
    this.grace = grace;
    this.timeout = timeout;
    this.contexts = new Map();
    this.pending = new Set();
  }

  register(frame, context) {
    const id = Math.random() + ':' + Math.random();
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

  async send(id, url, body) {
    const entry = this.contexts.get(id);
    if (!entry || !(body instanceof Blob) || entry.queued + body.size > 65536) return false;
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    entry.queued += body.size;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    timer.unref?.();
    const request = {id, controller};
    this.pending.add(request);
    try {
      const response = await this.fetch(target.href, {
        method: 'POST', body: await body.arrayBuffer(),
        headers: {Origin: new URL(entry.context.url).origin, ...(body.type ? {'Content-Type': body.type} : {})},
        credentials: 'include', redirect: 'follow', signal: controller.signal
      }, entry.context);
      await response.body?.cancel();
    } catch {
      // Beacon deliberately provides no response/error callback to the page.
    } finally {
      clearTimeout(timer);
      this.pending.delete(request);
      entry.queued -= body.size;
    }
    return {cookies: this.cookies(entry.context.url)};
  }
}
