// Adapt libcurl.js's exposed request callbacks to a stream that opens at final
// response headers, propagates transfer errors, and cancels native requests.
export function streaming_http_session(HTTPSession) {
  return class StreamingHTTPSession extends HTTPSession {
    relay_streams = new Map();
    static async create_options(params) {
      const lastID = params.event_source_last_id;
      delete params.event_source_last_id;
      if (lastID !== undefined && (typeof lastID !== 'string' || /[\0\r\n]/.test(lastID))) throw new TypeError('Invalid Last-Event-ID');
      const body = await super.create_options(params);
      // Headers/Request use ByteString, while SSE IDs are UTF-8. Add this header
      // after libcurl's Request normalization so its UTF-8 encoder handles it.
      if (lastID) params.headers['Last-Event-ID'] = lastID;
      return body;
    }
    stream_response(url, onHeaders, onEnd, signal) {
      const record = {id: this.last_request_id, nativeEnded: false};
      let controller, handle, ended = false, announced = false, headerText = '', status = 0;
      const announce = () => { if (!announced && !ended) { announced = true; onHeaders(stream); } };
      const finish = (error, cancelled = false) => {
        if (ended) return;
        if (!error) announce();
        ended = true;
        signal?.removeEventListener('abort', abort);
        if (!cancelled) {
          if (error) controller.error(error === -1 ? new DOMException('Aborted', 'AbortError') : new TypeError(`HTTP transfer failed: ${error}`));
          else controller.close();
        }
        onEnd(error);
      };
      const abort = () => finish(-1);
      const stream = new ReadableStream({
        start(value) { controller = value; },
        cancel() { finish(-1, true); }
      });
      handle = this.create_request(url, chunk => {
        if (ended) return;
        announce();
        if (!ended) controller.enqueue(chunk);
      }, error => {
        record.nativeEnded = true;
        finish(error);
      }, chunk => {
        if (ended || announced) return;
        headerText += new TextDecoder().decode(chunk);
        let newline;
        while ((newline = headerText.indexOf('\n')) >= 0) {
          const line = headerText.slice(0, newline).replace(/\r$/, '');
          headerText = headerText.slice(newline + 1);
          const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(line);
          if (match) status = Number(match[1]);
          if (!line && status >= 200) announce();
        }
      });
      this.relay_streams.set(handle, record);
      if (signal) {
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) queueMicrotask(abort);
      }
      return handle;
    }
    remove_request_now(handle) {
      const record = this.relay_streams.get(handle);
      const started = this.requests_list.includes(handle);
      super.remove_request_now(handle);
      if (record && !record.nativeEnded) {
        if (started) this.active_requests--;
        delete this.request_callbacks[record.id];
      }
      this.relay_streams.delete(handle);
    }
  };
}
