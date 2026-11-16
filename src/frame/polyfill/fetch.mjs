import { ctx } from "../context.mjs";
import * as network from "../network.mjs";
import { serialize_request } from "./request.mjs";

export async function fetch(resource, params = {}) {
  const request = await serialize_request(resource, params, ctx.location.href);
  request.signal.throwIfAborted();
  return network.fetch(request.url, {...request.options, signal: request.signal});
}
