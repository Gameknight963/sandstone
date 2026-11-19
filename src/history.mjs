export function history_url(value, current, base = current) {
  const before = new URL(current);
  const after = value === undefined || value === null || value === "" ? before : new URL(String(value), base);
  const opaque = before.origin === "null";
  if (before.origin !== after.origin || before.username !== after.username || before.password !== after.password ||
      opaque && before.href.split("#")[0] !== after.href.split("#")[0]) {
    throw new DOMException("History URLs must be same-origin", "SecurityError");
  }
  return after.href;
}

// Authoritative session history survives replacement of the sandboxed document.
export class NavigationHistory {
  constructor() { this.entries = []; this.index = -1; this.sequence = 0; }
  get current() { return this.entries[this.index]; }
  snapshot() {
    const entry = this.current;
    return {length: this.entries.length, index: this.index, url: entry?.url || null,
      state: entry ? structuredClone(entry.state) : null, document_id: entry?.document_id,
      scroll: [...(entry?.scroll || [0, 0])]};
  }
  save_scroll(scroll) {
    if (this.current && Array.isArray(scroll) && scroll.length === 2) this.current.scroll = scroll.map(value => Number.isFinite(value) ? value : 0);
  }
  navigate(url, {mode = "push", document_id, scroll = [0, 0],request_metadata} = {}) {
    document_id ||= "document:" + ++this.sequence;
    const previous = this.current;
    const entry = {url: new URL(url).href, state: previous && (mode === "reload" || mode === "traverse") ? structuredClone(previous.state) : null,
      document_id, scroll: mode === "reload" || mode === "traverse" ? previous?.scroll || scroll : scroll};
    if(request_metadata)entry.request_metadata=Object.freeze({...request_metadata});
    if (previous && (mode === "traverse" || mode === "reload")) {
      const old_document = previous.document_id;
      for (const item of this.entries) if (item.document_id === old_document) item.document_id = document_id;
    }
    if (previous && ["replace", "reload", "traverse"].includes(mode)) this.entries[this.index] = entry;
    else { this.entries.splice(this.index + 1); this.entries.push(entry); this.index = this.entries.length - 1; }
    return this.snapshot();
  }
  mutate(kind, state, url, scroll,origin) {
    if (!this.current) throw new DOMException("Document is not active", "InvalidStateError");
    const copy = structuredClone(state);
    url = history_url(url, this.current.url);
    this.save_scroll(scroll);
    const entry = {...this.current, state: copy, url, scroll: [...this.current.scroll]};
    if(entry.request_metadata){
      origin??=new URL(url).origin;
      entry.request_metadata=Object.freeze({...entry.request_metadata,source:origin==='null'?'about:blank':origin+'/',site:origin==='null'?'cross-site':'same-origin',opaque:origin==='null'});
    }
    if (kind === "replace") this.entries[this.index] = entry;
    else if (kind === "push") { this.entries.splice(this.index + 1); this.entries.push(entry); this.index++; }
    else throw new TypeError("Invalid history operation");
    return this.snapshot();
  }
  go(delta, scroll) {
    delta = Number(delta) >> 0;
    const index = this.index + delta;
    if (index < 0 || index >= this.entries.length || !delta) return null;
    const previous = this.current;
    this.save_scroll(scroll);
    this.index = index;
    return {...this.snapshot(), oldURL: previous.url, sameDocument: previous.document_id === this.current.document_id};
  }
}
