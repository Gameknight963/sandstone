const newline = value => String(value).replace(/\r\n|\r|\n/g, '\r\n');
const quoted = value => String(value).replace(/[\r\n"]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

// Snapshot synchronously: a beacon's caller may immediately change its buffers,
// FormData, or navigate away. Blob composition also gives the exact queued size.
export function beacon_body(value) {
  if (value === undefined || value === null) return new Blob([]);
  if (value instanceof Blob) return value;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)
    throw new TypeError('Keepalive requests cannot use a ReadableStream body');
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value]);
  if (value instanceof URLSearchParams) return new Blob([value.toString()], {type: 'application/x-www-form-urlencoded;charset=UTF-8'});
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    const boundary = '----sandstone-beacon-' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [name, item] of value) {
      let header = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + quoted(newline(name)) + '"';
      if (typeof item === 'string') parts.push(header + '\r\n\r\n' + newline(item) + '\r\n');
      else parts.push(header + '; filename="' + quoted(item.name) + '"\r\nContent-Type: ' + (item.type || 'application/octet-stream') + '\r\n\r\n', item, '\r\n');
    }
    parts.push('--' + boundary + '--\r\n');
    return new Blob(parts, {type: 'multipart/form-data; boundary=' + boundary});
  }
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
  return new Blob([String(value)], {type: 'text/plain;charset=UTF-8'});
}

export function create_beacon_sender({base, dispatch, limit = 65536, budget = {queued:0}}) {
  return function sendBeacon(url, data) {
    if (!arguments.length) throw new TypeError('sendBeacon requires a URL');
    const target = new URL(url, base());
    if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('Beacon URL must use HTTP or HTTPS');
    const body = beacon_body(data);
    if (budget.queued + body.size > limit) return false;
    budget.queued += body.size;
    try {
      Promise.resolve(dispatch(target.href, body)).catch(() => {}).finally(() => { budget.queued -= body.size; });
      return true;
    } catch { budget.queued -= body.size; return false; }
  };
}
