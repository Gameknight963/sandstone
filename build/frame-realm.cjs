// The frame bundle runs as a classic script in both documents and workers.
// Keep its native dependencies in a private lexical scope. Authored scripts
// execute separately, so their global declarations remain visible to the page.
const names=`
  Object Function Array Number BigInt Boolean String Symbol Date Math RegExp JSON Reflect Proxy
  Map Set WeakMap WeakSet WeakRef FinalizationRegistry Promise Error EvalError RangeError
  ReferenceError SyntaxError TypeError URIError AggregateError
  ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array
  Uint16Array Int32Array Uint32Array Float16Array Float32Array Float64Array BigInt64Array BigUint64Array Atomics
  URL URLSearchParams Request Response Headers Blob File FileList FormData AbortController AbortSignal
  ReadableStream WritableStream TransformStream ByteLengthQueuingStrategy CountQueuingStrategy
  CompressionStream DecompressionStream TextEncoder TextDecoder TextEncoderStream TextDecoderStream
  XMLHttpRequest WebSocket Worker MessageChannel MessagePort EventSource FileReader FileReaderSync
  EventTarget Event CustomEvent MessageEvent ErrorEvent ProgressEvent SubmitEvent HashChangeEvent
  PopStateEvent PageTransitionEvent CloseEvent DOMException Node NodeFilter Element Document
  DocumentFragment ShadowRoot DOMParser XMLSerializer MutationObserver MutationRecord
  IntersectionObserver IntersectionObserverEntry ResizeObserver ResizeObserverEntry PerformanceObserver
  Range StaticRange Text Comment CharacterData Attr NamedNodeMap TreeWalker NodeIterator HTMLCollection
  NodeList DOMTokenList DOMStringMap DOMRect DOMRectReadOnly CSSStyleSheet CSSRule CSSRuleList
  CSSStyleDeclaration CSSFontFaceRule CSSGroupingRule CSSImportRule CSSKeyframesRule StyleSheet
  MediaList MediaQueryList DocumentType Window WorkerGlobalScope
  DedicatedWorkerGlobalScope Navigator WorkerNavigator Screen History Location WorkerLocation Storage
  HTMLElement HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBaseElement HTMLBodyElement
  HTMLButtonElement HTMLCanvasElement HTMLDialogElement HTMLEmbedElement HTMLFormElement HTMLFrameSetElement HTMLHeadElement HTMLHtmlElement
  HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLLinkElement HTMLMediaElement HTMLObjectElement
  HTMLMetaElement HTMLOptionElement HTMLPictureElement HTMLScriptElement HTMLSelectElement HTMLSourceElement HTMLStyleElement
  HTMLTemplateElement HTMLTextAreaElement HTMLTrackElement HTMLVideoElement SVGElement SVGSVGElement
  SVGAElement SVGAnimatedString SVGFEImageElement SVGImageElement SVGScriptElement SVGStyleElement SVGUseElement
  WebAssembly Intl crypto performance document window self parent top frames location navigator customElements
  parseInt parseFloat isNaN isFinite encodeURI decodeURI encodeURIComponent decodeURIComponent escape unescape
  atob btoa setTimeout clearTimeout setInterval clearInterval queueMicrotask requestAnimationFrame
  cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia getSelection
  addEventListener removeEventListener dispatchEvent postMessage fetch importScripts close eval
`.trim().split(/\s+/);

const refreshed=['Image','Audio','FontFace','StorageEvent'];
exports.header='(function(globalThis){\nconst {'+names.join(',')+'}=globalThis;\nlet {'+refreshed.join(',')+'}=globalThis;\n';
// These constructors are intentionally adapted during bundle initialization.
exports.footer='\n({'+refreshed.join(',')+'}=globalThis);\nglobalThis.sandstone_frame=sandstone_frame;\n})(globalThis);';
