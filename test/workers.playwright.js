async page => {
  await page.evaluate(() => {
    const previous = sandstone.network.session.fetch;
    const sources = {
      '/workers/classic.js': `
        importScripts('./lib/first.js');
        self.runCount = (self.runCount || 0) + 1;
        const effect = fetch('./side-effect').then(response => response.text());
        self.onmessage = async event => {
          await effect;
          postMessage({bytes: Array.from(event.data.bytes), order: self.importOrder,
            imported: importedValue, count: self.runCount, href: location.href, origin: location.origin,
            windowType: typeof window, documentType: typeof document, storageType: typeof localStorage,
            historyType: typeof history,uuid:crypto.randomUUID()}, [event.data.bytes.buffer]);
        };
      `,
      '/workers/lib/first.js': "self.importOrder=['first']; importScripts('./second.js'); self.importOrder.push('after-second'); var importedValue=42;",
      '/workers/second.js': "self.importOrder.push('second');",
      '/workers/computed.js': `
        const path = './computed-' + String(1) + '.js';
        fetch('./computed-effect').catch(() => {});
        importScripts(path);
        self.onmessage = () => postMessage({computed: self.computedValue});
      `,
      '/workers/computed-1.js': 'self.computedValue=73;',
      '/workers/module.mjs': `
        import {value} from './dependency.mjs';
        let blocked;
        try { importScripts('./ignored.js'); } catch(error) { blocked=error.name; }
        const message = await new Promise(resolve => self.onmessage = event => resolve(event.data));
        const extra = await import('./extra.mjs');
        postMessage({value: value + message.number + extra.extra, href: location.href,
          meta: import.meta.url, blocked, storageType: typeof localStorage});
      `,
      '/workers/dependency.mjs': 'export const value=10;',
      '/workers/extra.mjs': 'export const extra=2;',
      '/workers/port.js': "onmessage = event => { event.data.port.postMessage('port-ok'); };",
      '/workers/nested.js': "const child=new Worker('./nested-child.js'); child.onmessage=event=>{postMessage(event.data);child.terminate();}; onmessage=event=>child.postMessage(event.data);",
      '/workers/nested-child.js': "onmessage=event=>postMessage({nested:event.data+1,href:location.href});",
      '/workers/blob-helper.js': "self.blobImported=99;"
    };
    globalThis.workerRequests = [];
    sandstone.network.session.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      if (!path.startsWith('/workers/')) return previous(url, options);
      workerRequests.push(url);
      if (path.endsWith('effect')) return new Response('ok');
      if (!(path in sources)) return new Response('missing', {status:404});
      return new Response(sources[path], {headers:{'Content-Type':'text/javascript'}});
    };
  });
  const classic = JSON.parse(await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const worker=new Worker('/workers/classic.js');
    const bytes=new Uint8Array([7,8,9]);
    worker.onmessage=event=>{worker.terminate();resolve(JSON.stringify({...event.data,detached:bytes.byteLength===0}));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage({bytes},[bytes.buffer]);
  })`)));
  const expected = {bytes:[7,8,9],order:['first','second','after-second'],imported:42,count:1,
    href:'https://fixture.test/workers/classic.js',origin:'https://fixture.test',
    windowType:'undefined',documentType:'undefined',storageType:'undefined',historyType:'undefined',detached:true};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(classic.uuid))throw new Error('Worker UUID is unavailable or invalid');
  delete classic.uuid;
  if (JSON.stringify(classic)!==JSON.stringify(expected)) throw new Error('Classic worker failed: '+JSON.stringify(classic));
  const computed = JSON.parse(await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const worker=new Worker('/workers/computed.js');
    worker.onmessage=event=>{worker.terminate();resolve(JSON.stringify(event.data));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage('start');
  })`)));
  if (computed.computed!==73) throw new Error('Computed importScripts failed');
  const module = JSON.parse(await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const worker=new Worker('/workers/module.mjs',{type:'module'});
    worker.onmessage=event=>{worker.terminate();resolve(JSON.stringify(event.data));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage({number:30});
  })`)));
  if (module.value!==42 || module.meta!=='https://fixture.test/workers/module.mjs' || module.href!==module.meta || module.blocked!=='TypeError') throw new Error('Module worker failed: '+JSON.stringify(module));
  const port = await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const worker=new Worker('/workers/port.js');
    const channel=new MessageChannel();
    channel.port1.onmessage=event=>{worker.terminate();channel.port1.close();resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage({port:channel.port2},{transfer:[channel.port2]});
  })`));
  if (port!=='port-ok') throw new Error('Queued MessagePort transfer failed');
  const nested = JSON.parse(await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const worker=new Worker('/workers/nested.js');
    worker.onmessage=event=>{worker.terminate();resolve(JSON.stringify(event.data));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage(8);
  })`)));
  if (nested.nested!==9 || nested.href!=='https://fixture.test/workers/nested-child.js') throw new Error('Nested worker failed');
  const blob = JSON.parse(await page.evaluate(() => main_frame.eval_js(`new Promise((resolve,reject) => {
    const url=URL.createObjectURL(new Blob(['importScripts("https://fixture.test/workers/blob-helper.js");onmessage=()=>postMessage({value:self.blobImported,origin:location.origin});'],{type:'text/javascript'}));
    const worker=new Worker(url);
    worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);resolve(JSON.stringify(event.data));};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
    worker.postMessage(true);
  })`)));
  if (blob.value!==99 || blob.origin!=='https://fixture.test') throw new Error('Blob worker origin or imports failed');
  const requests=await page.evaluate(()=>workerRequests);
  if (requests.filter(url=>url.endsWith('/side-effect')).length!==1 || requests.filter(url=>url.endsWith('/computed-effect')).length!==1) throw new Error('Worker discovery repeated network side effects');
  return ['classic and module workers','synchronous nested importScripts','computed worker imports','startup message buffering','ArrayBuffer and MessagePort transfers','nested workers','blob worker origins'];
}
