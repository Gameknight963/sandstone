# C++ / WebAssembly CSS rewriting experiment

The prototype is faster for this part of Sandstone. Including the JavaScript /
WASM boundary, full CSS placeholder rewriting was about **3.8–5.6× faster on the
five real stylesheet inputs** in the recorded run. This measures CSS processing,
not website loading, JavaScript rewriting, rendering, or relay performance.

The production runtime is unchanged. This directory is an isolated experiment.

## Recorded results

Windows x64, AMD Ryzen 9 3900X; headless Firefox 159.0 and Chromium
159.0.8154.6. C++20 compiled with Emscripten 3.1.72, `-O3 -flto`.
The generated benchmark opens directly from `file://`, with the WASM bytes
embedded in the HTML and no server needed.

Median milliseconds per complete `prepare_css` call, after warm-up:

| Input | URLs rewritten | Firefox JS | Firefox WASM | Chromium JS | Chromium WASM |
| --- | ---: | ---: | ---: | ---: | ---: |
| normalize.css, 6 KB | 0 | 0.161 | 0.036 | 0.104 | 0.024 |
| Bootstrap, 233 KB | 0 | 16.00 | 2.90 | 9.90 | 2.22 |
| Bulma, 677 KB | 0 | 45.00 | 8.00 | 27.30 | 5.88 |
| jQuery UI, 32 KB | 7 | 1.875 | 0.392 | 1.188 | 0.310 |
| Font Awesome, 74 KB | 20 | 5.000 | 0.938 | 3.389 | 0.741 |
| Generated mixed CSS, 389 UTF-16 units | 6 | 0.033 | 0.013 | 0.021 | 0.011 |
| Generated mixed CSS, 100 KB | 1,548 | 73.00 | 3.22 | 89.90 | 2.88 |

Bootstrap's resource references are data URLs and do not need replacing.
The first three rows therefore mostly measure scanning and filtering, including
the required input copy. jQuery UI and Font Awesome exercise actual replacements.
The final two rows are synthetic and deliberately contain imports, font URLs,
image sets, comments, escapes, and non-ASCII text.

The dense-input gain is partly an algorithm improvement. Production JS repeatedly
concatenates the stylesheet for each edit; the prototype builds the output once.
The benchmark includes a JS version of that same one-pass construction:

| 100 KB dense input | Current JS | One-pass JS | C++ / WASM |
| --- | ---: | ---: | ---: |
| Firefox | 73.00 ms | 13.00 ms | 3.22 ms |
| Chromium | 89.90 ms | 6.75 ms | 2.88 ms |

So this case is **4.0× / 2.3× faster than the improved JS**, rather than attributing
the entire 23× / 31× gain to WebAssembly. Dense-input timings varied more between
runs because of the existing implementation's allocation cost. A second run of
the final bridge reproduced the real-stylesheet gains.

The WASM module is **40,931 bytes** (16,032 bytes gzipped), excluding the small JS
bridge and base64 expansion in a standalone HTML. Base64 decoding, compilation,
instantiation, and initialization took **4.0 ms in Firefox / 6.8 ms in Chromium**
in the saved run; this is recorded separately from steady-state timings. For
small inputs, startup can outweigh the time saved for many individual calls.

Full raw timings, nine samples per implementation and operation, source URLs,
input hashes, and the WASM and baseline CSS module hashes are in `results.json`.

## What was compared

- The actual `css_references` and `prepare_css` definitions extracted from
  `src/frame/css.mjs`, not a simplified JS implementation.
- A C++ port of CSS scanning and synchronous placeholder rewriting. UTF-16
  offsets and lone surrogates retain their JS behavior.
- The same `prepare_css` with only output construction changed to a single pass.
- A separate resident-input WASM diagnostic that excludes input copying and
  returned JS objects. **The tables above do not use those kernel-only numbers.**

Every measured full WASM call includes copying its input, executing C++, decoding
the output, and building the returned CSS string, edits array, and markers Map.
Output strings are decoded in bulk. The first bridge converted each string
separately and lost much of the speedup; a naive port would have been misleading.

The harness checks exact scanner and rewriter parity on **2,529 inputs in Node,
Firefox, and Chromium**. These include existing CSS-test literals, deterministic
generated malformed inputs, Unicode and lone surrogates, BOM preservation, and
the seven benchmark inputs. Node also checks a second prefix containing escapes,
Unicode, and a lone surrogate. Every correctness check precedes timing.

Timing batches target 30 ms, with warm-up/calibration and nine rounds whose
implementation order rotates. Headless browser timers and GC affect the numbers;
these are local throughput measurements, not a site-performance guarantee.

This is not a complete production replacement: `prepare_css` is compared without
its optional `supports` callback. The C++ scanner returns import conditions, but
the native `CSS.supports` decision and related edit removal are not ported.
Network fetching, async stylesheet imports, CSSOM integration, HTML, and
JavaScript parsing remain outside the experiment.

## Reproduce

Use an activated Emscripten SDK, Node dependencies, and the existing Playwright
Firefox and Chromium headless-shell installations. From the repository root in
a POSIX shell (including WSL):

```sh
mkdir -p .temp/wasm-css
em++ bench/wasm-css/css.cpp -std=c++20 -O3 -flto --no-entry \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  '-sEXPORTED_FUNCTIONS=["_reserve_input","_scan_css","_prepare_css"]' \
  -o .temp/wasm-css/css.wasm
node bench/wasm-css/verify.mjs
node bench/wasm-css/run.mjs
```

Run Node on the OS where the browser binaries are installed. Set
`PLAYWRIGHT_BROWSERS_PATH` if using a custom cache. The runner downloads pinned
public CSS dependencies on its first run, then caches them under `.temp/wasm-css`.
Generated HTML, downloaded inputs, binaries, and fresh results stay in that
ignored directory. `BENCH_LARGE=1` enables an additional 1 MB URL-dense stress
case; it is disabled by default after the initial Firefox run consumed excessive
time and memory. That interrupted run is not included in the reported results.

Compiler optimization settings follow the [Emscripten optimization guide](https://emscripten.org/docs/optimizing/Optimizing-Code).
The bridge's fatal UTF-16 decoder and BOM handling follow the
[Encoding Standard](https://encoding.spec.whatwg.org/); code-unit fallback retains
strings that contain unpaired surrogates.
