import {chromium,firefox} from 'playwright-core';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyWebRTC} from './webrtc.playwright.mjs';
const artifact=pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href;
for(const engine of [firefox,chromium]){
  const browser=await engine.launch({headless:true});
  try{for(const storageDenied of [false,true]){
    const context=await browser.newContext();
    try{const page=await context.newPage();await page.goto(artifact);console.log(JSON.stringify({engine:engine.name(),storageDenied,passed:await verifyWebRTC(page,{storageDenied})}));}
    finally{await context.close();}
  }}finally{await browser.close();}
}
