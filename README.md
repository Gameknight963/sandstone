# Sandstone

[<img src="https://upload.wikimedia.org/wikipedia/commons/a/af/USDA_Mineral_Sandstone_93c3955.jpg?20050520171627" height="128px">](https://commons.wikimedia.org/wiki/File:USDA_Mineral_Sandstone_93c3955.jpg)

Sandstone is an experimental web proxy utilizing sandboxed iframes and no service worker. 

Traditional web proxies like [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) require you to visit a domain that is unblocked, leading to a whack-a-mole situation of having these domains be blocked and trying to find new ones. Sandstone on the other hand is able to run from within a local HTML file.

Additionally, traditional web proxies do not sandbox the proxied pages, so any site can take control of the proxy as a whole and steal credentials. Sandstone avoids this by putting the proxied pages inside a [sandboxed iframe](https://www.w3schools.com/tags/att_iframe_sandbox.asp), so they absolutely cannot access the parent page.

To try: [download the latest build](https://nightly.link/Gameknight963/sandstone/workflows/build.yaml/main/sandstone.zip), extract it, and open _sandstone.html_ in your browser.

## Features
- Every proxied page runs in a sandboxed iframe
- Can be used from an HTML file or as a data URL
- Does not use service workers
- Uses [libcurl.js](https://www.npmjs.com/package/libcurl.js) and [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) for end-to-end encryption

## Site Support

Many sites are supported, for example:

- [YouTube](https://www.youtube.com/)
- [JS Paint](https://jspaint.app/)
- [Photopea](https://www.photopea.com/)
- [diagrams.net](https://app.diagrams.net/)
- [Scratch editor](https://scratchfoundation.github.io/scratch-gui/)
- [Flems](https://flems.io/)
- [PDF.js](https://mozilla.github.io/pdf.js/web/viewer.html)
- [SQLime](https://sqlime.org/)
- [Discord](https://discord.com/login)
- Most static sites

## Status

### Working Features
- JavaScript rewriting, dynamic scripts, and `eval`
- ES modules, import maps, dynamic imports, and top-level await
- Fetch API and XMLHttpRequest, including streaming responses
- WebSockets, EventSource, and `sendBeacon`
- Cookies and isolated per-site storage
- localStorage, sessionStorage, IndexedDB, and CacheStorage
- HTTP request caching and conditional revalidation
- Classic and module web workers
- Web Crypto
- Images, audio, video, and MediaSource playback
- CSS rewriting, dynamic stylesheets, and CSSOM updates
- Links, redirects, HTML forms, and downloads
- History API, iframe navigation, and cross-frame messaging
- WebRTC (must be enabled in settings)

### Notable Limitations
- Cloudflare verification fails (and probably will, forever).
- WebTransport and WebSocketStream are not supported.