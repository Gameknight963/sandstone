import test from "node:test";
import assert from "node:assert/strict";
import { worker_imports, prefetch_worker_scripts } from "../src/frame/worker_scripts.mjs";

test("Classic worker discovery finds literal and constant imports without executing source", () => {
  const source = `
    const root = './lib/';
    importScripts(root + 'one.js', './two.js');
    self.importScripts(\`./three.js\`);
    throw new Error('must never execute');
  `;
  assert.deepEqual(worker_imports(source, "https://example.com/workers/main.js"), {
    urls: ["https://example.com/workers/lib/one.js", "https://example.com/workers/two.js", "https://example.com/workers/three.js"], dynamic: false
  });
  assert.equal(worker_imports("importScripts('./' + choose() + '.js')", "https://example.com/main.js").dynamic, true);
  assert.equal(worker_imports("const name='outer'; function inner(name){importScripts(name)}", "https://example.com/main.js").dynamic, true);
});

test("Nested importScripts resolve against the worker entry URL and failures remain deferred", async () => {
  const seen = [];
  const result = await prefetch_worker_scripts("importScripts('./lib/first.js','./missing.js')", "https://example.com/workers/main.js", async url => {
    seen.push(url);
    if (url.endsWith('/missing.js')) return new Response('', {status: 404});
    return new Response(url.endsWith('/first.js') ? "importScripts('./second.js')" : "self.value=42");
  });
  assert.deepEqual(seen, ["https://example.com/workers/lib/first.js", "https://example.com/workers/missing.js", "https://example.com/workers/second.js"]);
  assert.equal(result.cache.get("https://example.com/workers/missing.js"), false);
  assert.equal(result.cache.get("https://example.com/workers/second.js"), "self.value=42");
});
