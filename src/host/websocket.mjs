import {same_site} from './request.mjs';
import {cookie_header} from './cookie_policy.mjs';

const blob_buffer=globalThis.Blob?.prototype.arrayBuffer;
// RPC already cloned these payloads. Keep their ordering and Blob reads on
// the host so retiring a document cannot discard accepted sends or its close.
export class WebSocketOutbound {
  constructor(socket,{readBlob=blob=>Reflect.apply(blob_buffer,blob,[]),timeout=30000}={}){
    this.socket=socket;this.readBlob=readBlob;this.timeout=timeout;this.queue=Promise.resolve();this.closing=false;this.aborted=false;
    this.cancelled=new Promise((_,reject)=>{this.cancel=reject;});this.cancelled.catch(()=>{});
  }
  append(operation){
    const result=this.queue.then(()=>this.aborted?undefined:operation());
    this.queue=result.catch(()=>this.fail(1));
    return result;
  }
  send(data){
    if(this.closing||this.aborted)return Promise.resolve();
    return this.append(async()=>{
      if(data instanceof Blob)data=new Uint8Array(await Promise.race([this.readBlob(data),this.cancelled]));
      if(!this.aborted)this.socket.send(data);
    });
  }
  finish(operation){
    if(this.closing||this.aborted)return this.queue;
    this.closing=true;
    // Bound the drain as well as the transport's subsequent close handshake.
    this.timer=setTimeout(()=>this.fail(28),this.timeout);
    return this.append(()=>{clearTimeout(this.timer);operation();});
  }
  close(code,reason){return this.finish(()=>this.socket.close(code,reason));}
  retire(){
    if(!this.socket.connected){this.abort();return this.queue;}
    return this.finish(()=>retire_websocket(this.socket));
  }
  stop(){this.aborted=true;clearTimeout(this.timer);this.cancel(new DOMException('WebSocket queue stopped','AbortError'));}
  fail(code){if(this.aborted)return;this.stop();this.socket.cleanup(code);}
  abort(){if(this.aborted)return;this.stop();this.socket.abort();}
}

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
export function retire_websocket(socket){
  // Stop exposing the socket immediately, but let an established connection
  // finish its bounded close handshake. Pending handshakes still abort.
  if(socket.connected)socket.close(1001,'');
  else socket.abort();
}
// WebSocket handshakes use HTTP cookie rules, including HttpOnly cookies. The
// source is the virtual page/worker origin, never the local HTML file's origin.
function websocket_context(input,{url,top_url=url,userAgent,cross_site=false,broadcast_origin}){
  const target = new URL(input);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new TypeError('Invalid WebSocket URL');
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const source = new URL(url), top = new URL(top_url);
  const opaque=broadcast_origin?.startsWith('opaque:');
  const sameSiteContext = !opaque && !cross_site && same_site(top, source) && same_site(top, target) ? 'strict' : 'none';
  const headers = {Origin: opaque?'null':source.origin, 'User-Agent': userAgent};
  return {target,sameSiteContext,headers};
}
export function websocket_options(store, input, context) {
  store.refresh?.();
  const cookieGeneration=store.cookieGeneration;
  const cookieEpochs=store.cookieEpochSnapshot?.();
  const {target,sameSiteContext,headers}=websocket_context(input,context);
  const cookie = cookie_header(store.cookies,target.href,{sameSiteContext});
  if (cookie) headers.Cookie = cookie;
  return {
    headers,
    onHeader(name, value) {
      if (name === 'set-cookie') store.setCookie(target.href, value,true,{crossSite:sameSiteContext==='none',...(cookieGeneration===undefined?{}:{cookieGeneration}),...(cookieEpochs===undefined?{}:{cookieEpochs})});
    }
  };
}

// Keep the actual socket on the retained host. Only cookie decisions travel
// over the trusted UI channel, including writes from failed HTTP handshakes.
export async function websocket_policy_options(store,input,context,signal){
  const {target,sameSiteContext,headers}=websocket_context(input,context);
  const {cookieGeneration,cookieEpochs}=await store.captureCookieContext(context,signal);
  const cookie=await store.cookieHeader(target.href,{sameSiteContext},signal);
  if(cookie)headers.Cookie=cookie;
  let writes=Promise.resolve();
  return {headers,
    onHeader(name,value){
      if(name!=='set-cookie')return;
      // Headers already accepted from the transport still commit if its client
      // closes while policy work is pending. The captured clear barrier remains.
      writes=writes.then(()=>store.setCookie(target.href,value,true,{crossSite:sameSiteContext==='none',cookieGeneration,cookieEpochs}));
      writes.catch(()=>{});
    },
    cookiesReady:()=>writes
  };
}

// Present the transport interface while policy lookup is pending, so close()
// and document retirement can cancel a stalled provider before a socket exists.
export class CookieWebSocket {
  constructor(Transport,store,url,protocols,context){
    this.controller=new AbortController();this.events=Promise.resolve();
    this.start(Transport,store,url,protocols,context).catch(()=>this.cleanup(1));
  }
  async start(Transport,store,url,protocols,context){
    const options=await websocket_policy_options(store,url,context,this.controller.signal);
    this.controller.signal.throwIfAborted();
    const socket=this.socket=new Transport(url,protocols,options);
    for(const type of ['open','message','close','error'])socket['on'+type]=data=>{
      const committed=options.cookiesReady();
      this.events=this.events.then(async()=>{
        await committed;
        if(!this.stopped)this['on'+type]?.(data);
      }).catch(()=>this.cleanup(1));
    };
  }
  get connected(){return !!this.socket?.connected;}
  get protocol(){return this.socket?.protocol||'';}
  send(data){this.socket?.send(data);}
  close(code,reason){if(this.socket)this.socket.close(code,reason);else this.abort();}
  abort(){
    if(this.stopped)return;this.stopped=true;this.controller.abort();this.socket?.abort();
  }
  cleanup(code){
    if(this.stopped)return;this.abort();this.onerror?.(code);
  }
}
