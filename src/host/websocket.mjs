// libcurl.js 0.7 only cleans up sockets after they become connected. Its base
// session close also needs the polling loop stopped before freeing the session.
export function relay_websocket_class(CurlWebSocket) {
  const closeSession = Object.getPrototypeOf(CurlWebSocket.prototype).close;
  return class RelayWebSocket extends CurlWebSocket {
    create_request(url, data, end, headers) {
      let pending = '';
      return super.create_request(url, data, end, chunk => {
        pending += new TextDecoder().decode(chunk);
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (/^HTTP\//i.test(line)) this.protocol = '';
          const match = /^sec-websocket-protocol:\s*(.*)$/i.exec(line);
          if (match) this.protocol = match[1];
        }
        headers(chunk);
      });
    }

    cleanup(error = 0) {
      if (this.relay_closed) return;
      this.relay_closed = true;
      clearInterval(this.recv_loop);
      clearInterval(this.event_loop);
      this.recv_loop = this.event_loop = null;
      this.connected = false;
      if (this.session_ptr) closeSession.call(this);
      if (error) this.onerror(error);
      else this.onclose();
    }
  };
}
