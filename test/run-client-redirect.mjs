// Focused cross-engine regression: the inactive-document bug only reproduced
// in Firefox. Install the engines with Playwright's install chromium firefox.
import {chromium,firefox} from 'playwright-core';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyClientRedirects} from './client-redirect.playwright.mjs';

const artifact=pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href;
for(const engine of [chromium,firefox]){
  const browser=await engine.launch({headless:true});
  try{
    for(const denied of [false,true]){
      const context=await browser.newContext();
      try{
        if(denied)await context.addInitScript(()=>{
          for(const name of ['localStorage','indexedDB','caches'])Object.defineProperty(window,name,{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});
        });
        const page=await context.newPage();await page.goto(artifact);
        await page.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
        console.log(JSON.stringify({engine:engine.name(),storageDenied:denied,passed:await verifyClientRedirects(page)}));
      }finally{await context.close();}
    }
  }finally{await browser.close();}
}
