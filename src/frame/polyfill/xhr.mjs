import * as network from "../network.mjs";
import { ctx } from "../context.mjs";
import { create_xhr_class } from "../xhr.mjs";

export const FakeXMLHttpRequest = create_xhr_class({
  fetch: network.fetch,
  base: () => ctx.document?.baseURI || ctx.location.href,
  client_referrer: () => ctx.document&&/^about:blank(?:#|$)/.test(ctx.location.href)?'':undefined,
  isWorker: typeof importScripts === "function"
});
