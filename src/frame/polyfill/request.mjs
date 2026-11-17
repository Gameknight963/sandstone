// Normalize with the browser's Request implementation, retaining generated body headers.
export async function serialize_request(resource, init, base, source_url = base) {
  const input = resource instanceof Request ? resource : new URL(resource, base).href;
  const options = {...init};
  const initial_referrer = options.referrer !== undefined ? options.referrer : resource instanceof Request ? resource.referrer : 'about:client';
  delete options.referrer;
  let referrer = initial_referrer;
  if (referrer !== '' && referrer !== 'about:client') {
    const source = new URL(source_url || input.url || input), requested = new URL(referrer,base || source);
    referrer = requested.origin === source.origin ? requested.href : 'about:client';
  }
  if (options.body instanceof ReadableStream) options.duplex = "half";
  const request = new Request(input, options);
  request.signal.throwIfAborted();
  // Firefox may expose a null .body for FormData while arrayBuffer() still contains it.
  const body = /^(GET|HEAD)$/.test(request.method) ? undefined : await request.arrayBuffer();
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
      mode: request.mode,
      referrer,
      referrerPolicy: request.referrerPolicy
    }
  };
}
