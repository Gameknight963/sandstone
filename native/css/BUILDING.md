# Native CSS runtime

The application enables C++ / WASM CSS processing for strings of at least 4,096
UTF-16 units. Short operations keep the existing JS implementation. Final
resolved-resource assembly additionally requires at least 64 resource references.

The native paths scan CSS references, prepare synchronous placeholders (including
conditional imports), restore placeholders, preserve CSS text-node boundaries,
and assemble fetched stylesheet resources in one pass. Async requests, redirects,
encodings, cookies, referrer policies, DOM operations, and CSS.supports decisions
remain with the existing browser/JS code.
Large responsive-image `srcset` lists use the same scanner/assembly instance,
with the same size and resource-count thresholds. The C++ tokenizer preserves
data-URL commas and descriptors; URL resolution and fetching remain in JS.

The frame initializes the embedded bytes alongside document preparation. There
is no additional request or file beside `example/bundled.html`, including when
opened with `file://`. Workers do not initialize the CSS module. If compilation
fails or WASM is unavailable, the JS implementation remains active. A native
runtime failure retires that instance and falls back to JS. Reentrant CSS work
from a supports callback uses JS; callback exceptions propagate once without
being retried. Tiny CSS declarations and normal short `srcset` values remain JS;
the experimental JavaScript source-edit ports are not enabled.

Each document owns its instance. Initial linear memory is 2 MiB with a 256 KiB
stack; it grows on demand for large sheets. Growth is tested while retaining
previously returned JS values and processing split text nodes.
Linked-runtime notices are retained in `vendor/native/LICENSES.txt` and embedded
in the frame bundle, so the downloadable single HTML carries them too.

## Rebuild

The normal npm build uses `vendor/native/css.wasm`; no native compiler is needed.
Editing C++ requires an activated Emscripten SDK (the recorded build uses 3.1.72),
Node, and a POSIX shell such as WSL:

```sh
bash native/css/build.sh
npm run build:prod
npm run build:prod --prefix example
```

`EMXX` can point to an alternate `em++` executable; `NATIVE_CSS_NODE` can select
Node when it is not on the shell's PATH. The script writes both the
binary and `vendor/native/css.manifest.json`. The normal webpack build verifies
source and binary hashes, with normalized source line endings, so a changed C++
file cannot silently ship an old binary. Commit the binary and manifest with
their source changes. Source and build helpers are included in the package.

## Verify

```sh
npm test
npm run test:browser:native-css
node bench/native-css-runtime.mjs
```

The unit tests compare the native scanner, supported/unsupported imports,
placeholder maps, returned edits, resolved-resource assembly, and split text
nodes with the JS implementation on the existing corpus and generated malformed
inputs. They also check callback reentrancy, callback exceptions, small-input
routing, invalid binaries, and real runtime dispatch.
They also compare native `srcset` tokenization and assembly with the JS path,
including commas, future descriptor syntax, malformed inputs, and UTF-16.

The browser runner opens the actual standalone artifact in Firefox and Chromium,
with normal and denied storage, and both native-enabled and compilation-blocked
contexts. It verifies imports, relayed SVGs, live text mutations, cloning, native
dispatch counters, and absence of direct HTTP requests. The existing CSS suites
also run against the enabled runtime. Their CSSOM fixture is Chromium-specific
because it asserts native exception names. CI runs the focused Chromium matrix
before the broader browser suite.
Large responsive-image lists are exercised as real image elements as well.

The runtime benchmark compares independent copies of the actual CSS API: JS,
native scanning/preparation/restoration with JS final assembly, and the full
native implementation. This isolates the new C++ resource assembly gain from
the earlier scanner gain. Correctness precedes timing. The benchmark includes
async response handling, native routing, conversion costs, and UTF-8 consumption
of the final output; it does not measure complete page-load or rendering time.
Seven timing samples, input hashes, browser versions, CPU model, binary hash,
and actual dispatch counters are recorded in `PERFORMANCE.json`. Inputs and
fresh results are cached under `.temp/native-css-runtime/`.

The large synthetic gains include replacing repeated JS string concatenation
with one-pass construction. They are not solely a language comparison. Earlier
experiments in `bench/wasm-core/RESULTS.md` also compare improved JS algorithms
and document the ports that did not produce a useful gain.
Keep C++ semantics aligned with the JavaScript fallbacks and extend the parity
corpus when changing either grammar.
