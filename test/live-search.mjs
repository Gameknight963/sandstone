import assert from 'node:assert/strict';
export const search_sites=[{id:'wikipedia-search',url:'https://www.wikipedia.org/',editor:true,timeout:60000}];
export async function interactSearchPortal(page,proxy,{surface,read,wait}){
  await wait(page,proxy,'document.activeElement?.id==="searchInput"');
  await page.keyboard.type('Proxy server');
  assert.equal(await read(page,proxy,'document.getElementById("searchInput").value'),'Proxy server');
  // Let the JSONP autocomplete finish before submission retires its document.
  await wait(page,proxy,'Array.from(document.querySelectorAll(".suggestion-title")).some(title=>title.textContent.trim()==="Proxy server")');
  await page.keyboard.press('Enter');
  await wait(page,proxy,'location.hostname==="en.wikipedia.org"&&!!document.querySelector("h1")&&document.querySelector("h1").textContent.includes("Proxy server")');
  return read(page,proxy,'({autofocus:true,typed:true,suggested:true,heading:document.querySelector("h1").textContent.trim(),path:location.pathname})');
}
