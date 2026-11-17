import { create_event_source_class } from '../event_source.mjs';
import * as network from '../network.mjs';
import { ctx } from '../context.mjs';
import {listen_runtime,unlisten_runtime} from '../runtime_events.mjs';

export const FakeEventSource = create_event_source_class({
  base: () => ctx.document?.baseURI || ctx.location.href,
  fetch(url, options) {
    const headers = {...options.headers};
    const event_source_last_id = headers['Last-Event-ID'];
    delete headers['Last-Event-ID'];
    return network.fetch(url, {...options, mode:'cors', headers, event_source_last_id});
  },
  onUnload(callback) {
    listen_runtime(globalThis,'unload',callback,{once:true});
    return () => unlisten_runtime(globalThis,'unload',callback);
  }
});
