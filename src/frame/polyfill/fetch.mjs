import { ctx } from "../context.mjs";
import * as network from "../network.mjs";
import { prepare_request } from "./request.mjs";
import {reserve_keepalive} from '../keepalive_budget.mjs';
import {create_request_class} from '../request.mjs';

// Location.origin is null for srcdoc and blob URLs even when their environment
// inherits an HTTP origin. Opaque environments must never compare equal by URL.
const source_url=()=>ctx.origin==='null'?'about:blank':ctx.origin+'/';
export const FakeRequest=create_request_class(()=>ctx.document?.baseURI||ctx.location.href,source_url);

export async function fetch(resource, params = {}) {
  let release;
  try {
    // Body reads can finish after document.open() adopts the caller's URL.
    const blank=ctx.document&&/^about:blank(?:#|$)/.test(ctx.location.href);
    const prepared = prepare_request(resource, params, ctx.document?.baseURI || ctx.location.href, source_url(),
      size=>{release=reserve_keepalive(size);},blank?'':undefined);
    // Unload can destroy this realm before another promise job runs. Snapshot
    // bodies must reach the host synchronously, before the handler returns.
    const request = typeof prepared.then === 'function' ? await prepared : prepared;
    request.signal.throwIfAborted();
    return network.public_response(await network.fetch(request.url, {...request.options, signal: request.signal,sandstone_keepalive_release:release}));
  } catch (error) { release?.(); throw error; }
}
