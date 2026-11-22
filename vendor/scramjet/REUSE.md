Scramjet reuse assessment
========================

Inspected commit: 32ffe62c40e25f6c7d329735324fa355d159fb73.
This is an integration assessment, not a claim that its full runtime works in
Sandstone or that its advertised supported sites have been verified here.

Adopted
-------

The declarative refresh parser is independent of the proxy runtime after
removing TypeScript and replacing one native snapshot import. It replaces
Sandstone's regex parser, which could throw on malformed input, rejected valid
separator/whitespace forms, and sent targetless refreshes to the site root.
Navigation still runs through Sandstone's existing loader and URL policy.

Next integration candidates
---------------------------

1. JavaScript rewriter: packages/core/src/shared/rewriters/js.ts and
   packages/core/rewriter. This is the largest potential reuse. It accepts
   configurable helper names and a URL encoder, but generates calls into
   Scramjet's wrap, eval, import, realm and source-map runtime. Compare those
   contracts with Sandstone's globals, direct eval, import maps and function
   source preservation before replacing anything. Run existing semantic tests
   against an adapter first. Bundle its WASM locally; do not add a network fetch
   for it or a native service-worker requirement.
2. DOM/API hook coverage: packages/core/src/client/dom and shared. Port missing
   hooks individually, with native browser comparison. CSSStyleValue.parse is
   one uncovered surface in Sandstone; it needs resource hydration that the
   synchronous URL rewriting in Scramjet does not provide by itself.
3. Compatibility regression cases: tests/ci. Reuse suitable fixtures alongside
   adapted hooks, retaining their provenance and license. Existing overlapping
   functionality is not a reason to replace code with different semantics.

Architecture boundaries
-----------------------

The worker hook rewrites a URL and invokes the native constructor. That assumes
the rewritten URL can be served; it does not replace Sandstone's opaque actor
bootstrap, native ownership, source capture or retained service contexts.

Scramjet's current CSS rewriter is regex-based. Sandstone already tokenizes CSS
and asynchronously fetches resources into local URLs. Replacing that pipeline
would require proving imports, redirects, escapes, races and file:// still work.

The HTML rewriter imports Scramjet's URL, CSS, JS, history and injection machinery.
It is not an independent HTML parser dependency. Sandstone already uses parse5.

Use pinned dependencies for reusable published APIs. Vendor independent source
when adapting it is necessary, record modifications and upstream revisions in
NOTICE.md, and preserve notices in standalone output. Avoid importing a second
complete proxy runtime merely to obtain a small helper.
