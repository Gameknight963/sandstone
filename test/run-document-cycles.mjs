import {chromium,firefox} from 'playwright-core';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyDocumentCycles} from './document-cycles.playwright.mjs';
const artifact=pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href;
for(const engine of [chromium,firefox]){
  const browser=await engine.launch({headless:true});
  try{for(const denied of [false,true]){
    const context=await browser.newContext();
    try{
      if(denied)await context.addInitScript(()=>{for(const name of ['localStorage','indexedDB','caches'])Object.defineProperty(window,name,{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});});
      const page=await context.newPage();await page.goto(artifact);
      let timer;try{
        const passed=await Promise.race([verifyDocumentCycles(page),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Document cycle regression timed out')),60000);})]);
        console.log(JSON.stringify({engine:engine.name(),storageDenied:denied,passed}));
      }finally{clearTimeout(timer);}
    }finally{await context.close();}
  }}finally{await browser.close();}
}
