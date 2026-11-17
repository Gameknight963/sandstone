import {readFile} from 'node:fs/promises';

const font = await readFile(new URL('./fonts/fixture.ttf', import.meta.url));

export function font_fixture() {
  const requests = [];
  return {
    handle(request, response, url) {
      if (!url.pathname.startsWith('/fonts/')) return false;
      const client = url.searchParams.get('client');
      const own = 'http://127.0.0.1:' + request.headers.host.split(':').at(-1);
      const cross = own.replace('127.0.0.1', 'localhost');
      const query = '?client=' + encodeURIComponent(client);
      if (url.pathname.endsWith('/page')) {
        response.writeHead(200, {'Content-Type':'text/html', 'Set-Cookie':'font_session=own; SameSite=Lax; Path=/fonts/'});
        response.end('<!doctype html><link rel="stylesheet" href="/fonts/style.css'+query+'"><body>Font fixture');
      } else if (url.pathname.endsWith('.css')) {
        response.writeHead(200, {'Content-Type':'text/css', 'Referrer-Policy':'unsafe-url'});
        response.end('@font-face {font-family:OwnFont;src:url("same.ttf'+query+'") format("truetype")}'+
          '@font-face {font-family:CrossFont;src:url("'+cross+'/fonts/cross.ttf'+query+'") format("truetype")}');
      } else {
        requests.push({client, path:url.pathname, origin:request.headers.origin||null,
          referrer:request.headers.referer||null, cookie:(request.headers.cookie||'').split('; ').filter(value=>value.startsWith('font_')).sort().join('; ')});
        const allowed = !url.pathname.endsWith('/cross.ttf') || request.headers.origin === own && !request.headers.cookie;
        response.writeHead(allowed ? 200 : 403, {'Content-Type':'font/ttf', 'Access-Control-Allow-Origin':own});
        response.end(allowed ? font : 'Font request rejected');
      }
      return true;
    },
    values(client) {
      return requests.filter(value=>value.client===client).map(({client,...value})=>({...value,
        referrer:value.referrer?.replace('client='+encodeURIComponent(client),'client=CLIENT')||null
      })).sort((a,b)=>a.path.localeCompare(b.path));
    }
  };
}

export const font_script = client => `(async()=>{
  const deadline=Date.now()+10000;
  let sheet;
  while(!(sheet=document.querySelector('link').sheet)||sheet.cssRules.length<2){
    if(Date.now()>deadline)throw new Error('Font stylesheet missing');await new Promise(resolve=>setTimeout(resolve,10));
  }
  const results=[];
  const verify=async family=>{
    const faces=await document.fonts.load('20px '+family,'AAA');
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    context.font='20px '+family;
    results.push({family,count:faces.length,status:faces[0]?.status,width:context.measureText('AAA').width});
  };
  await verify('OwnFont');await verify('CrossFont');
  sheet.insertRule('@font-face{font-family:DynamicFont;src:url("/fonts/inserted.ttf?client='+${JSON.stringify(client)}+'")}',sheet.cssRules.length);
  const rule=sheet.cssRules[sheet.cssRules.length-1];
  const ready=async()=>{
    while(rule.style.getPropertyValue('src').includes('sandstone-css-')){
      if(Date.now()>deadline)throw new Error('Font CSSOM hydration timed out');await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  await ready();await verify('DynamicFont');
  rule.style.setProperty('src','url("/fonts/edited.ttf?client='+${JSON.stringify(client)}+'")');
  await ready();await verify('DynamicFont');
  rule.style.src='url("/fonts/property.ttf?client='+${JSON.stringify(client)}+'")';
  await ready();await verify('DynamicFont');
  rule.style.cssText='font-family:DynamicFont;src:url("/fonts/text.ttf?client='+${JSON.stringify(client)}+'")';
  await ready();await verify('DynamicFont');
  return JSON.stringify(results);
})()`;
