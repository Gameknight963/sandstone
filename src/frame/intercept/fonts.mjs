import {ctx} from '../context.mjs';
import {css_resource_references} from '../css.mjs';
import {parse_css} from '../rewrite/css.mjs';
import {document_referrer_policy} from './document.mjs';

const NativeFontFace = globalThis.FontFace;
const NativeFontFaceSet = globalThis.FontFaceSet;

if (NativeFontFace && NativeFontFaceSet) {
  const facePrototype = NativeFontFace.prototype;
  const setPrototype = NativeFontFaceSet.prototype;
  const faceDescriptors = Object.getOwnPropertyDescriptors(facePrototype);
  const setDescriptors = Object.getOwnPropertyDescriptors(setPrototype);
  const nativeLoad = facePrototype.load;
  const nativeSet = Object.fromEntries(['add','delete','clear','has','values','load'].map(key=>[key,setPrototype[key]]));
  const states = new WeakMap(), originals = new WeakMap(), sets = new WeakMap();
  const status = face => faceDescriptors.status.get.call(face);
  const virtual = face => originals.get(face) || face;
  const actual = face => {
    const state = states.get(face);
    return state?.real && ['loaded','error'].includes(state.phase) ? state.real : face;
  };
  const metadata = face => Object.fromEntries(Object.entries(faceDescriptors)
    .filter(([,descriptor])=>descriptor.get && descriptor.set)
    .map(([key,descriptor])=>[key,descriptor.get.call(face)]));
  const emit = (set, type, faces = []) => {
    const event = typeof FontFaceSetLoadEvent === 'function' ? new FontFaceSetLoadEvent(type,{fontfaces:faces}) : new Event(type);
    if (!('fontfaces' in event)) Object.defineProperty(event,'fontfaces',{value:faces});
    synthetic.add(event);
    set.dispatchEvent(event);
  };
  const synthetic = new WeakSet();

  function record(set) {
    if (sets.has(set)) return sets.get(set);
    const value = {order:new Map(), pending:new Set(), loaded:[], failed:[], batch:false, nativeCycle:false, ready:null, resolve:null, completing:false};
    sets.set(set,value);
    // The placeholder's native failure initiates the relay; it is not a font
    // failure visible to the page. Publish the eventual real result instead.
    for (const type of ['loading','loadingdone','loadingerror']) {
      EventTarget.prototype.addEventListener.call(set,type,event=>{
        if (synthetic.has(event)) return;
        const managed = Array.from(nativeSet.values.call(set)).some(face=>states.has(face) && states.get(face).phase !== 'loaded' && status(face) !== 'unloaded');
        if (type === 'loading') value.nativeCycle = value.batch || managed;
        if (type === 'loading' ? value.nativeCycle : value.batch || value.nativeCycle || event.fontfaces?.some(face=>states.has(face) || originals.has(face))) {
          event.stopImmediatePropagation();
          for (const face of event.fontfaces || []) {
            if (states.has(face) || originals.has(face)) continue;
            (type === 'loadingerror' ? value.failed : value.loaded).push(face);
          }
        }
      },true);
    }
    return value;
  }

  function begin(set, state) {
    const value = record(set);
    value.pending.add(state);
    if (value.batch) return;
    value.batch = true;
    value.ready = new Promise(resolve=>{value.resolve=resolve;});
    setTimeout(()=>emit(set,'loading'),0);
  }

  async function complete(set) {
    const value = sets.get(set);
    if (!value?.batch || value.pending.size || value.completing) return;
    value.completing = true;
    await setDescriptors.ready.get.call(set);
    // Native loadingdone/loadingerror delivery can follow resolution of ready.
    // Collect the CSS-connected faces from that batch before publishing ours.
    await new Promise(resolve=>setTimeout(resolve,0));
    value.completing = false;
    if (value.pending.size) return;
    const loaded = [...new Set(value.loaded)], failed = [...new Set(value.failed)];
    value.loaded.length = value.failed.length = 0;
    const resolve = value.resolve;
    value.batch = false;
    value.resolve = null;
    resolve(set);
    setTimeout(()=>{
      emit(set,'loadingdone',loaded);
      if (failed.length) emit(set,'loadingerror',failed);
    },0);
  }

  function start(state) {
    if (state.phase !== 'unloaded') return state.promise;
    state.phase = 'loading';
    for (const set of state.sets) begin(set,state);
    (async()=>{
      try {
        const source = await parse_css(state.source,state.base,undefined,state.request);
        const real = new NativeFontFace(faceDescriptors.family.get.call(state.face),source,metadata(state.face));
        state.real = real;
        originals.set(real,state.face);
        await nativeLoad.call(real);
        state.phase = 'loaded';
        // Loaded faces can be installed without causing another native load.
        for (const set of state.sets) {
          nativeSet.delete.call(set,state.face);
          nativeSet.add.call(set,real);
        }
        state.resolve(state.face);
      } catch (error) {
        state.phase = 'error';
        if (state.real) for (const set of state.sets) {
          nativeSet.delete.call(set,state.face);
          nativeSet.add.call(set,state.real);
        }
        state.reject(error);
      }
      for (const set of state.sets) {
        const value = record(set);
        value.pending.delete(state);
        (state.phase === 'loaded' ? value.loaded : value.failed).push(state.face);
        complete(set);
      }
    })();
    return state.promise;
  }

  const FontFace = new Proxy(NativeFontFace,{
    construct(target,args,newTarget) {
      if (args.length < 2) return Reflect.construct(target,args,newTarget);
      const input = args[1];
      if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return Reflect.construct(target,args,newTarget);
      if (typeof input === 'symbol' || typeof args[0] === 'symbol') return Reflect.construct(target,args,newTarget);
      const family = String(args[0]);
      const source = String(input);
      const validated = Reflect.construct(target,[family,source,...args.slice(2)],newTarget);
      if (status(validated) === 'error' || !css_resource_references(source).length) return validated;
      // An unavailable local font is a lazy, network-free sentinel. Native font
      // matching loads it only when this face is actually requested or rendered.
      const sentinel = '__sandstone_font_' + Array.from(crypto.getRandomValues(new Uint32Array(4))).join('_');
      const face = Reflect.construct(target,[faceDescriptors.family.get.call(validated),`local("${sentinel}")`,metadata(validated)],newTarget);
      const state = {face,source,base:ctx.document?.baseURI || ctx.location.href,
        request:{fontFace:true,referrer:ctx.location.href,referrerPolicy:document_referrer_policy()},
        phase:'unloaded',real:null,sets:new Set(),resolve:null,reject:null,promise:null};
      state.promise = new Promise((resolve,reject)=>{state.resolve=resolve;state.reject=reject;});
      // The native FontStatusPromise is internally handled even if the page
      // never reads .loaded. Keep the same unhandled-rejection behavior here.
      state.promise.catch(()=>{});
      states.set(face,state);
      const trigger = () => { start(state); };
      faceDescriptors.loaded.get.call(face).then(trigger,trigger);
      return face;
    }
  });
  globalThis.FontFace = FontFace;
  Object.defineProperty(facePrototype,'constructor',{...faceDescriptors.constructor,value:FontFace});
  facePrototype.load = function() {
    const state = states.get(this);
    return state ? start(state) : nativeLoad.call(this);
  };
  for (const [key,descriptor] of Object.entries(faceDescriptors)) {
    if (key === 'status' || key === 'loaded') {
      Object.defineProperty(facePrototype,key,{...descriptor,get() {
        const state = states.get(this);
        return state ? key === 'loaded' ? state.promise : state.phase === 'unloaded' && status(this) === 'loading' ? 'loading' : state.phase : descriptor.get.call(this);
      }});
    } else if (descriptor.set) {
      Object.defineProperty(facePrototype,key,{...descriptor,set(value) {
        descriptor.set.call(this,value);
        const real = states.get(this)?.real;
        if (real) descriptor.set.call(real,descriptor.get.call(this));
      }});
    }
  }

  setPrototype.add = function(face) {
    nativeSet.add.call(this,actual(face));
    const value = record(this);
    value.order.set(face,true);
    const state = states.get(face);
    if (state) {
      state.sets.add(this);
      if (state.phase === 'loading') begin(this,state);
    }
    return this;
  };
  setPrototype.has = function(face) { return nativeSet.has.call(this,actual(face)); };
  setPrototype.delete = function(face) {
    const result = nativeSet.delete.call(this,actual(face));
    if (result) {
      const value = sets.get(this), state = states.get(face);
      value?.order.delete(face);
      state?.sets.delete(this);
      value?.pending.delete(state);
      complete(this);
    }
    return result;
  };
  setPrototype.clear = function() {
    nativeSet.clear.call(this);
    const value = sets.get(this);
    for (const face of value?.order.keys() || []) states.get(face)?.sets.delete(this);
    value?.order.clear();
    value?.pending.clear();
    complete(this);
  };
  function values(set) {
    const faces = Array.from(nativeSet.values.call(set),virtual);
    const order = sets.get(set)?.order;
    // Chromium snapshots FontFaceSet iterators. Preserve that snapshot and the
    // original insertion order even when a sentinel is replaced internally.
    return (order ? [...faces.filter(face=>!order.has(face)),...Array.from(order.keys()).filter(face=>faces.includes(face))] : faces).values();
  }
  setPrototype.values = setPrototype.keys = setPrototype[Symbol.iterator] = function() { return values(this); };
  setPrototype.entries = function() {
    const iterator = values(this);
    return (function*() { for (const face of iterator) yield [face,face]; })();
  };
  setPrototype.forEach = function(callback,thisArg) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    for (const face of values(this)) callback.call(thisArg,face,face,this);
  };
  setPrototype.load = async function(...args) {
    if (!sets.has(this)) return nativeSet.load.apply(this,args);
    try { return (await nativeSet.load.apply(this,args)).map(virtual); } catch (error) {
      if (!Array.from(sets.get(this).order.keys()).some(face=>states.has(face) && status(face) === 'error')) throw error;
    }
    const loading = Array.from(sets.get(this).order.keys(),face=>states.get(face))
      .filter(state=>state && ['unloaded','loading'].includes(state.phase) && status(state.face) !== 'unloaded');
    await Promise.allSettled(loading.map(start));
    return (await nativeSet.load.apply(this,args)).map(virtual);
  };
  Object.defineProperty(setPrototype,'status',{...setDescriptors.status,get() {
    return sets.get(this)?.batch ? 'loading' : setDescriptors.status.get.call(this);
  }});
  const readyPromises = new WeakMap();
  Object.defineProperty(setPrototype,'ready',{...setDescriptors.ready,get() {
    const value = sets.get(this);
    if (value?.batch) return value.ready;
    const native = setDescriptors.ready.get.call(this);
    if (!readyPromises.has(native)) readyPromises.set(native,native.then(async()=>{
      const current = sets.get(this);
      if (current?.batch) await current.ready;
      return this;
    }));
    return readyPromises.get(native);
  }});
  if (globalThis.document) record(globalThis.document.fonts);
  else if (globalThis.fonts) record(globalThis.fonts);
}
