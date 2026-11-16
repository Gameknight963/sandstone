import * as network from "../network.mjs";
import { ctx } from "../context.mjs";
import { create_xhr_class } from "../xhr.mjs";

export const FakeXMLHttpRequest = create_xhr_class({
  fetch: network.fetch,
  base: () => ctx.document?.baseURI || ctx.location.href,
  isWorker: typeof importScripts === "function"
});
