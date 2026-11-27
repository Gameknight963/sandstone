# Tests

The test suite uses two runtimes:

- **C# / xUnit v3 / Playwright .NET** for user workflows: controls and settings,
  site-data clearing, file transfers, WebRTC opt-in, live sites, and YouTube.
- **JavaScript / node:test / Playwright** for direct module tests and browser API
  semantics such as scope, object identity, event ordering, and relay protocols.

The standalone HTML still runs entirely in the browser. .NET is a development
dependency. Node also builds the HTML and supplies the existing local Wisp test
server; the small npm launchers do not contain browser assertions.

## Setup

Install Node.js 24 or later and the .NET 10 SDK, then run:

```sh
npm ci
npm ci --prefix example
npm run build:prod
npm run build:prod --prefix example
npm run test:browser:install
```

On Linux, pass `-- --with-deps --only-shell chromium firefox` to the browser
installer if system dependencies are missing. It uses the browser driver from
the locked .NET package. The retained Node suite also needs its own matching
browser: `npx --no-install playwright-core install --only-shell chromium`.

## Deterministic tests

```sh
npm test                       # JavaScript unit tests
dotnet test                    # C# workflows; public-site tests are skipped
npm run test:browser:ui         # C# deterministic workflows only
npm run test:browser:runtime    # JavaScript browser API/semantic tests
npm run test:browser:native-css # Native CSS/fallback matrix and CSS fixtures
npm run test:browser            # Both deterministic browser suites
npm run test:relay              # Real local HTTP/WebSocket relay fixtures
```

Choose Firefox for the C# workflows:

```sh
dotnet test --environment BROWSER=firefox --filter-not-trait Category=Live
```

Use xUnit filters to run an individual class, method, or category:

```sh
dotnet test --filter-class Sandstone.BrowserTests.InterfaceTests
dotnet test --filter-trait Category=WebRTC
npm run test:browser:webrtc      # WebRTC workflows in Firefox and Chromium
```

The framework isolates browser contexts between scenarios. Public network
requests from a proxied page are blocked and recorded; site traffic must use
the relay. WebRTC tests use local peers without external STUN/TURN servers.

Font tests use the C# `FontFixture` class to create a tiny square-glyph TrueType
font in memory. xUnit owns its lifetime through `IClassFixture<FontFixture>`.
The JavaScript font/URL fixtures use the same generator through stdout, cached
once per process. No `.ttf` file or Python/fontTools generator is needed. Run
`dotnet test --filter-class Sandstone.BrowserTests.FontTests` for its native and
proxied rendering checks.

The CSS accelerator is built from C++ and included as checked-in WASM. Ordinary
builds and tests do not require Emscripten. Build-time hashes reject a stale
native binary; see `../native/css/BUILDING.md` when editing its C++ source.
Native CSS tests cover enabled and compilation-blocked paths under `file://`,
in both storage modes. Set `NATIVE_CSS_BROWSER=chromium` for a single browser and
`NATIVE_CSS_ONLY=1` to run just that focused matrix without the existing CSS suites.

## Opt-in public sites

```sh
npm run test:live -- jspaint pdfjs
npm run test:youtube
npm run test:youtube -- --public --watch-only
```

The compatibility launchers preserve `LIVE_BROWSER`, `LIVE_STORAGE_DENIED`,
`LIVE_ISOLATED`, and the YouTube switches and timeout/seek/relay environment
variables. You can also run the C# cases directly:

```sh
dotnet test --environment SANDSTONE_LIVE=1 --environment BROWSER=firefox --environment LIVE_SITES=jspaint,pdfjs --filter-class Sandstone.BrowserTests.LiveSiteTests
```

Live tests compare the same workflow natively and through Sandstone. A missing
native baseline is reported as skipped, never as a successful compatibility
result. Proxied assertions and harness errors remain failures. YouTube sign-in
blocks are also reported separately. External tests are not required CI gates.

Per-site JSON diagnostics are saved under `.temp/browser-results/`, grouped by
browser and storage/hosting mode. xUnit also supports standard test reports,
for example `dotnet test --report-xunit-trx`.

Add or edit live-site URLs in `Sandstone.BrowserTests/live-sites.json` and the
corresponding workflow in `Sandstone.BrowserTests/Workflows/`. Browser-side
JavaScript belongs in fixtures when the behavior itself is JavaScript-specific;
test orchestration and user-workflow assertions belong in C#.
