import test from 'node:test';
import assert from 'node:assert/strict';
import {streaming_http_session} from '../src/host/http_session.mjs';

class Session {
  last_request_id=0;request_callbacks={};requests_list=[];active_requests=0;
  static async create_options(params){params.headers=Object.fromEntries(new Headers(params.headers));return null;}
  create_request(url,data,end,headers){this.request_callbacks[this.last_request_id++]={data,end,headers};return 1;}
  remove_request_now(handle){this.requests_list=this.requests_list.filter(value=>value!==handle);}
  end(id,error){this.active_requests--;this.request_callbacks[id].end(error);delete this.request_callbacks[id];}
}
const HTTPSession=streaming_http_session(Session);
const bytes=value=>new TextEncoder().encode(value);

test('HTTP responses open at final headers, before any body arrives',async()=>{
  const session=new HTTPSession();let body;const errors=[];
  const handle=session.stream_response('https://test/',stream=>body=stream,error=>errors.push(error));
  session.requests_list.push(handle);session.active_requests++;
  session.request_callbacks[0].headers(bytes('HTTP/1.1 100 Continue\r\n\r\n'));assert.equal(body,undefined);
  session.request_callbacks[0].headers(bytes('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'));
  assert.ok(body instanceof ReadableStream);
  session.request_callbacks[0].data(bytes('first'));const reader=body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'first');
  session.end(0,0);assert.equal((await reader.read()).done,true);session.remove_request_now(handle);
  assert.equal(session.active_requests,0);assert.equal(session.relay_streams.size,0);assert.deepEqual(errors,[0]);
});

test('HTTP cancellation removes callback state and counts a native request only once',async()=>{
  const session=new HTTPSession(),signal=new AbortController();let body;
  const handle=session.stream_response('https://test/',stream=>body=stream,()=>{},signal.signal);
  session.requests_list.push(handle);session.active_requests++;
  session.request_callbacks[0].headers(bytes('HTTP/1.1 200 OK\r\n\r\n'));
  await body.cancel();signal.abort();session.remove_request_now(handle);
  assert.equal(session.active_requests,0);assert.deepEqual(session.request_callbacks,{});
});

test('HTTP transfer failures reject body reads instead of becoming truncated successes',async()=>{
  const session=new HTTPSession();let body;
  const handle=session.stream_response('https://test/',stream=>body=stream,()=>{});
  session.requests_list.push(handle);session.active_requests++;
  session.request_callbacks[0].headers(bytes('HTTP/1.1 200 OK\r\n\r\n'));
  session.end(0,18);await assert.rejects(body.getReader().read(),/HTTP transfer failed/);
  session.remove_request_now(handle);assert.equal(session.active_requests,0);
});

test('SSE last-event IDs bypass ByteString conversion but reject header injection',async()=>{
  const params={headers:{Accept:'text/event-stream'},event_source_last_id:'漢字-€'};
  await HTTPSession.create_options(params);assert.equal(params.headers['Last-Event-ID'],'漢字-€');
  assert.equal('event_source_last_id' in params,false);
  await assert.rejects(HTTPSession.create_options({event_source_last_id:'bad\r\nHeader: value'}),/Invalid Last-Event-ID/);
});
