import {same_site} from './request.mjs';
import {cookie_header} from './cookie_policy.mjs';

// libcurl.js 0.7 only cleans up sockets after they become connected. Its base
// session close also needs the polling loop stopped before freeing the session.
export function relay_websocket_class(CurlWebSocket) {
  const closeSession = Object.getPrototypeOf(CurlWebSocket.prototype).close;
  return class RelayWebSocket extends CurlWebSocket {
    create_request(url, data, end, headers) {
      let pending = '';
      return super.create_request(url, data, end, chunk => {
        // HTTP field values are bytes, not UTF-8 text. Avoid replacing bytes
        // above 0x7f when forwarding Set-Cookie to the same jar used by fetch.
        for (const byte of chunk) pending += String.fromCharCode(byte);
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (/^HTTP\//i.test(line)) this.protocol = '';
          const match = /^sec-websocket-protocol:\s*(.*)$/i.exec(line);
          if (match) this.protocol = match[1];
          const field = /^([^:]+):\s*(.*)$/.exec(line);
          if (field) this.options?.onHeader?.(field[1].toLowerCase(), field[2]);
        }
        headers(chunk);
      });
    }

    cleanup(error = 0) {
      if (this.relay_closed) return;
      this.relay_closed = true;
      clearInterval(this.recv_loop);
      clearInterval(this.event_loop);
      clearTimeout(this.close_timeout);
      this.recv_loop = this.event_loop = null;
      this.connected = false;
      if (this.session_ptr) closeSession.call(this);
      if (error) this.onerror(error);
      else this.onclose(this.close_info);
    }
    abort(){this.cleanup();}
  };
}
// WebSocket handshakes use HTTP cookie rules, including HttpOnly cookies. The
// source is the virtual page/worker origin, never the local HTML file's origin.
export function websocket_options(store, input, {url, top_url = url, userAgent, cross_site=false,broadcast_origin}) {
  const cookieGeneration=store.cookieGeneration;
  const target = new URL(input);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new TypeError('Invalid WebSocket URL');
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const source = new URL(url), top = new URL(top_url);
  const opaque=broadcast_origin?.startsWith('opaque:');
  const sameSiteContext = !opaque && !cross_site && same_site(top, source) && same_site(top, target) ? 'strict' : 'none';
  const headers = {Origin: opaque?'null':source.origin, 'User-Agent': userAgent};
  const cookie = cookie_header(store.cookies,target.href,{sameSiteContext});
  if (cookie) headers.Cookie = cookie;
  return {
    headers,
    onHeader(name, value) {
      if (name === 'set-cookie') store.setCookie(target.href, value,true,{crossSite:sameSiteContext==='none',...(cookieGeneration===undefined?{}:{cookieGeneration})});
    }
  };
}
