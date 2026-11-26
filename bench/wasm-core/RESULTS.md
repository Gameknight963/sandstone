# Expanded C++ / WASM rewriting core

This extends the first CSS experiment with four more ports:

- CSS placeholder restoration, including exact and prefix marker matching,
  fragment suffixes, unfinished tokens, and the returned-edits transform hook.
- The combined `restore_css` → `edit_css_parts` path used by style rewriting.
  This keeps the intermediate edits inside WASM instead of copying them out
  to JavaScript and immediately back in.
- HTML `srcset` tokenization, retaining commas in data URLs and future
  descriptor syntax.
- JavaScript edit assembly, including nested eval argument ranges, stable
  insertion priority, and overlapping-edit skips. Parsing and scope analysis
  still use the existing JavaScript implementation.

The module also contains the original C++ CSS scanner and placeholder preparer.
Its total size is **61,551 bytes**, or **23,336 bytes gzipped**, excluding the JS
bridge and base64 expansion. It can be embedded in HTML and instantiated directly
from bytes under `file://`. Both browsers were tested that way.

The production runtime and its build remain unchanged. These are experimental
ports with measured gains and losses, not a blanket switch to native code.

## Findings

Whole-stylesheet restoration and the combined CSS text-node path are useful
native candidates. Small calls and JS-only edit assembly are generally not.
The complete measurements and all nine samples per operation are in
`results.json`; ratios above 1 mean WASM is faster.

Median milliseconds, including input/output conversion and output consumption:

| Operation | Firefox JS | Firefox WASM | Chromium JS | Chromium WASM |
| --- | ---: | ---: | ---: | ---: |
| Restore jQuery UI CSS | 1.833 | 0.391 | 1.300 | 0.413 |
| Restore Font Awesome CSS | 5.000 | 0.960 | 3.683 | 1.061 |
| Restore jQuery UI into text-node strings | 1.846 | 0.407 | 1.350 | 0.462 |
| Restore Font Awesome into text-node strings | 5.200 | 1.040 | 3.829 | 1.255 |

Those are approximately **2.9–5.2× gains** on the measured real CSS paths.
The combined nodes are twelve source text parts, not twelve DOM mutations;
native DOM access remains outside this benchmark.

The dense case starts with roughly 100 KB of authored CSS and expands to
280,290 UTF-16 units of placeholder CSS, with 4,200 markers:

| Dense case | Current JS | One-pass JS | WASM |
| --- | ---: | ---: | ---: |
| Restore, Firefox | 272.00 ms | 14.00 ms | 5.75 ms |
| Restore, Chromium | 537.60 ms | 11.35 ms | 4.82 ms |
| Restore into nodes, Firefox | 288.00 ms | 16.00 ms | 6.50 ms |
| Restore into nodes, Chromium | 522.50 ms | 10.25 ms | 5.30 ms |

The native gain against the improved JS is therefore about **1.9–2.5×** here.
The 44–112× ratios against current JS must not be attributed solely to WASM.

For `srcset`, 1,000 candidates improve **3.6× in Firefox / 2.9× in Chromium**,
but a typical four-candidate value is **3.9× / 1.6× slower**. A single 53-unit
CSS declaration is about 1.9× slower in Firefox; Chromium improves against the
current JS but slightly loses to the improved JS. Separately sending CSS edits
to WASM is slower with both lazy and materialized output.

Complete Axios/Dexie/Meriyah rewrites are approximately unchanged or slower:
Firefox JS/WASM timings are 62/62, 81/82, and 107/105 ms; Chromium timings are
50.1/50.5, 64.7/67.2, and 88.6/88.6 ms. Tiny scripts suffer proportionally more.
The renderer-only port does not remove the remaining parse/scope work.

The real stylesheet inputs are pinned jQuery UI and Font Awesome CSS, with
their external resource URLs first replaced by Sandstone's actual preparer.
The restoration benchmarks therefore replace real markers rather than
measuring an empty marker map. The combined path receives the same parts and
markers on both sides, including the cost of joining the source parts.
Timed inputs use exact markers; prefix matching is validated separately.

The dense synthetic stylesheet is intentionally allocation-heavy. Its much
larger gain against the existing JS includes an algorithm improvement: the
current `restore_css` concatenates the entire source for each replacement, even
when a transform only requests the edits. A separate **one-pass JS** variant is
measured too. Only that comparison can distinguish native execution gains from
the construction algorithm. Neither the JS optimization nor WASM is enabled in
production by this experiment.

Normal `srcset` values, small CSS declarations, separately marshalled CSS edits,
and JavaScript source-edit assembly show why native code is not automatically
faster. JS can reuse existing strings and construct cheap concatenation trees;
WASM must copy source and replacement strings, marshal metadata, and construct
the returned JS values. The complete JS rewrite benchmarks include parsing and
scope analysis, and show no consistent improvement from moving assembly alone.

Some cases also force UTF-8 materialization on **both** implementations. These
are labelled `*-utf8`, or carry `materializedUtf8: true`, in the raw results.
They prevent JS's deferred concatenation from hiding all output-consumption
costs. Encoding is a comparison control, not simulated script execution or DOM
rendering. The complete JS-pipeline and CSS-restoration comparisons include it.

These are warm local throughput measurements on Windows x64 / Ryzen 9 3900X,
headless Firefox 159.0 and Chromium 159.0.8154.6, with an Emscripten 3.1.72
`-O3 -flto` build. Browser timers, GC, and CPU load cause variation. Startup is
measured separately: embedded-byte decoding and module initialization took
6.0 ms / 12.9 ms in the saved Firefox / Chromium run. These numbers do not measure
complete website loading, relay time, DOM mutations, or stylesheet application.

## Correctness

Node, Firefox, and Chromium each check:

| Input group | Cases |
| --- | ---: |
| `srcset` inputs | 1,506 |
| Source edits and subranges | 1,503 |
| CSS text-node edits | 1,504 |
| CSS restoration inputs | 2,526 |
| Complete representative script rewrites | 6 |
| Existing JS regression-source literals | 8 |

CSS restoration checks returned strings, the exact transform edits, and text-node
results. The cases reuse the existing CSS test literals and deterministic
generated input, and include malformed EOF tokens, Unicode, lone surrogates,
empty text nodes, prefix collisions, exact-marker precedence, and replacements
spanning node boundaries. The benchmark inputs receive additional parity checks.

Axios, Dexie, and Meriyah are taken from the installed locked dependencies.
Small scripts exercise strict scope, private fields, direct eval, `with`, dynamic
imports, and Unicode. Full rewritten output must match byte-for-byte. The fixed
global names and options used for these comparisons are saved in the report;
they do not reproduce every runtime configuration.

`reference.mjs` builds a benchmark-only copy of the production rewriter with
dispatch hooks at its final renderer and nested eval renderer. Both JS renderer
bodies are extracted from the production source. The original files are not
modified. Other JS reference functions are imported directly. Microbenchmarks
clone edit lists to keep repeat inputs stable; complete rewrites create their
own fresh edits normally. Input/source hashes are recorded for reproducibility.

## Reproduce

From the checkout root in an activated Emscripten POSIX shell (including WSL):

```sh
mkdir -p .temp/wasm-core
em++ bench/wasm-core/core.cpp -std=c++20 -O3 -flto --no-entry \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=@bench/wasm-core/exports.json \
  -o .temp/wasm-core/core.wasm
node bench/wasm-core/verify.mjs
node bench/wasm-core/run.mjs
```

Run Node on the OS where the existing Playwright Firefox and Chromium headless
shells are installed; set `PLAYWRIGHT_BROWSERS_PATH` for a custom browser cache.
No new npm dependencies are needed. The two pinned CSS files are downloaded on
first use and cached. Generated reference bundles, standalone benchmark HTML,
WASM, and fresh measurements stay in the ignored `.temp/wasm-core` directory.

The runner warms and calibrates each implementation, targets 25 ms batches, and
collects nine rounds with rotated execution order. Correctness runs before
timing. A failed comparison aborts the run.

The next production integration should favor sufficiently large CSS work and
retain JavaScript for tiny operations and unsupported cases. Startup/fallback
handling, realm ownership, and real page performance still need validation
before enabling this in the application.
