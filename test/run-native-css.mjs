import {chromium,firefox} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {runInThisContext} from 'node:vm';
import {verifyNativeCSS} from './native-css.playwright.mjs';

const root=new URL('../',import.meta.url),artifact=new URL('example/bundled.html',root).href;
const bytes=await readFile(new URL('vendor/native/css.wasm',root));
const fixtures=await Promise.all(['browser.playwright.js','css.playwright.js','cssom.playwright.js'].map(async name=>runInThisContext('('+await readFile(new URL(name,import.meta.url),'utf8')+')')));
const engines={firefox,chromium};
if(process.env.NATIVE_CSS_BROWSER&&!engines[process.env.NATIVE_CSS_BROWSER])throw new Error('Unknown NATIVE_CSS_BROWSER');
for(const [name,engine]of Object.entries(engines).filter(([name])=>!process.env.NATIVE_CSS_BROWSER||process.env.NATIVE_CSS_BROWSER===name))for(const denied of [false,true])for(const blocked of [false,true]){
  const browser=await engine.launch({headless:true});
  try{
    const context=await browser.newContext();
    if(denied)await context.addInitScript(()=>{for(const name of ['localStorage','indexedDB','caches'])Object.defineProperty(window,name,{configurable:true,get(){throw new DOMException('Storage denied','SecurityError')}})});
    if(blocked)await context.addInitScript(size=>{
      const instantiate=WebAssembly.instantiate;
      WebAssembly.instantiate=function(source,...args){if(source?.byteLength===size)return Promise.reject(new WebAssembly.CompileError('Native CSS deliberately blocked'));return instantiate.call(this,source,...args);};
    },bytes.length);
    const page=await context.newPage();await page.goto(artifact);
    await page.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const passed=await verifyNativeCSS(page,{blocked});
    // The existing semantic suites also exercise the active backend and fallback.
    if(!blocked&&process.env.NATIVE_CSS_ONLY!=='1'){
      await fixtures[0](page,artifact);passed.push(...await fixtures[1](page));
      // The existing CSSOM fixture asserts Chromium's native exception names.
      if(name==='chromium')passed.push(...await fixtures[2](page));
    }
    console.log(JSON.stringify({browser:name,denied,blocked,passed}));
  }finally{await browser.close();}
}
