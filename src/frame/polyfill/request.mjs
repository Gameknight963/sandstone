// Normalize with the browser's Request implementation, retaining generated body headers.
import {beacon_body} from '../beacon.mjs';

export function prepare_request(resource, init, base, source_url = base, reserve) {
  const input = resource instanceof Request ? resource : new URL(resource, base).href;
  const options = {...init};
  const keepalive = options.keepalive ?? (resource instanceof Request && resource.keepalive);
  const no_body = options.body == null && !(resource instanceof Request);
  // A Blob snapshot can cross RPC during unload without waiting for body-stream
  // reads in the departing realm. Use its own multipart boundary consistently.
  const snapshot = keepalive && options.body != null ? beacon_body(options.body) : null;
  if (snapshot) {
    const source_body = options.body;
    options.body = snapshot;
    if (!(source_body instanceof Blob || source_body instanceof ArrayBuffer || ArrayBuffer.isView(source_body) || typeof FormData !== 'undefined' && source_body instanceof FormData)) {
      const headers = new Headers(options.headers === undefined && resource instanceof Request ? resource.headers : options.headers);
      if (!headers.has('content-type')) headers.set('content-type',source_body instanceof URLSearchParams ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'text/plain;charset=UTF-8');
      options.headers = headers;
    }
  }
  const initial_referrer = options.referrer !== undefined ? options.referrer : resource instanceof Request ? resource.referrer : 'about:client';
  delete options.referrer;
  let referrer = initial_referrer;
  if (referrer !== '' && referrer !== 'about:client') {
    const source = new URL(source_url || input.url || input), requested = new URL(referrer,base || source);
    referrer = source.origin !== 'null' && requested.origin === source.origin ? requested.href : 'about:client';
  }
  if (options.body instanceof ReadableStream) options.duplex = "half";
  const request = new Request(input, options);
  request.signal.throwIfAborted();
  const reserved = request.keepalive && (snapshot !== null || no_body);
  if (reserved) reserve?.(snapshot?.size || 0);
  const finish=body=>{
  if (request.keepalive && !reserved) reserve?.(body?.byteLength || 0);
  return {
    url: request.url,
    signal: request.signal,
    options: {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
      credentials: request.credentials,
      redirect: request.redirect,
      cache: request.cache,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer,
      referrerPolicy: request.referrerPolicy
    }
  };
  };
  if(/^(GET|HEAD)$/.test(request.method))return finish(undefined);
  if(snapshot)return finish(snapshot);
  if(request.keepalive&&no_body)return finish(new ArrayBuffer(0));
  // Firefox may expose a null .body for FormData while arrayBuffer() still contains it.
  return request.arrayBuffer().then(finish);
}
export async function serialize_request(...args){return prepare_request(...args);}
