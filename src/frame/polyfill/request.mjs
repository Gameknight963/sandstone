// Normalize with the browser's Request implementation, retaining generated body headers.
export async function serialize_request(resource, init, base) {
  const input = resource instanceof Request ? resource : new URL(resource, base).href;
  const options = {...init};
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
      referrerPolicy: request.referrerPolicy
    }
  };
}
