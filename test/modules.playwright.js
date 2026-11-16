async page => {
  await page.evaluate(async () => {
    const sources = {
      '/assets/entry.mjs': `
        import {value, increment} from 'shared';
        import {readA} from './cycle.mjs';
        import {scoped} from './scoped/consumer.mjs';
        import settings from './settings.json' with {type: 'json'};
        export {named} from './reexport.mjs';
        export const a = 'cycle-a';
        window.moduleEvents.push('module-start');
        window.moduleResult = {before: value, url: import.meta.url,
          asset: new URL('./image.png', import.meta.url).href,
          resolved: import.meta.resolve('shared'), ready: document.readyState, scoped, setting: settings.answer,
          jsonOwnPrototype: Object.hasOwn(settings, '__proto__')};
        increment();
        window.moduleResult.after = value;
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', () => {
          window.moduleEvents.push('module-DCL'); resolve();
        }, {once: true}));
        window.moduleResult.cycle = readA();
        window.moduleResult.lazy = (await import(('./lazy.mjs'))).value;
        window.moduleResult.json = (await import('./settings.json', {with: {type: 'json'}})).default.answer;
        window.moduleResult.done = true;
      `,
      '/assets/shared.mjs': 'export let value = 1; export function increment() { value++; }',
      '/assets/cycle.mjs': "import {a} from './entry.mjs'; export function readA() { return a; }",
      '/assets/reexport.mjs': "export const named = 'reexported';",
      '/assets/lazy.mjs': "import {value} from 'shared'; export {value};",
      '/assets/scoped/consumer.mjs': "import {scoped} from 'shared'; export {scoped};",
      '/assets/scoped-shared.mjs': "export const scoped = 'scoped-map';",
      '/assets/settings.json': '{"answer":42,"__proto__":{"safe":true}}'
    };
    const previous = sandstone.network.session.fetch;
    globalThis.moduleRequests = [];
    sandstone.network.session.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      if (!(path in sources)) return previous(url, options);
      moduleRequests.push(url);
      return new Response(sources[path], {headers: {'Content-Type': path.endsWith('.json') ? 'application/json' : 'text/javascript'}});
    };
    main_frame.special_pages['https://fixture.test/module-page'] = `<!doctype html>
      <head><base href="https://fixture.test/assets/">
      <script type="importmap">{"imports":{"shared":"./shared.mjs"},"scopes":{"./scoped/":{"shared":"./scoped-shared.mjs"}}}<\/script>
      <script>
        window.moduleEvents = ['classic'];
        document.addEventListener('DOMContentLoaded', () => window.moduleEvents.push('classic-DCL'));
      <\/script>
      <script type="module" src="entry.mjs"><\/script>
      <script type="module">window.moduleEvents.push('inline');<\/script>
      <script nomodule>window.noModuleRan = true;<\/script>
      </head><body>Module fixture</body>`;
    await main_frame.navigate_to('https://fixture.test/module-page');
  });
  const deadline = Date.now() + 10000;
  while (!await page.evaluate(() => main_frame.eval_js('Boolean(window.moduleResult?.done)'))) {
    if (Date.now() > deadline) throw new Error('Module graph did not finish executing');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const result = JSON.parse(await page.evaluate(() => main_frame.eval_js(`JSON.stringify({
    ...window.moduleResult, events: window.moduleEvents, noModule: Boolean(window.noModuleRan)
  })`)));
  const expected = {
    before: 1, after: 2, url: 'https://fixture.test/assets/entry.mjs',
    asset: 'https://fixture.test/assets/image.png', resolved: 'https://fixture.test/assets/shared.mjs',
    ready: 'interactive', scoped: 'scoped-map', setting: 42, jsonOwnPrototype: true, cycle: 'cycle-a', lazy: 2, json: 42, done: true, noModule: false
  };
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value) throw new Error(`Module ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(result[key])}; full result ${JSON.stringify(result)}`);
  }
  for (const event of ['classic', 'module-start', 'inline', 'classic-DCL', 'module-DCL']) {
    if (!result.events.includes(event)) throw new Error('Missing module event: ' + event);
  }
  if (result.events.indexOf('inline') > result.events.indexOf('classic-DCL')) throw new Error('DOMContentLoaded preceded the inline module');
  const imported = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
    const first = await import('./assets/entry.mjs');
    const second = await import('./assets/entry.mjs');
    return JSON.stringify({same: first === second, value: first.a, reexport: first.named});
  })()`)));
  if (!imported.same || imported.value !== 'cycle-a' || imported.reexport !== 'reexported') throw new Error('Module namespace identity or re-exports failed');
  const requests = await page.evaluate(() => moduleRequests);
  if (requests.length !== 8 || new Set(requests).size !== 8) throw new Error('Module dependencies were fetched more than once: ' + JSON.stringify(requests));
  return ['ES modules', 'import maps and scopes', 'cycles and live bindings', 'dynamic import', 'import.meta', 'JSON modules', 'top-level await', 'module event ordering', 'nomodule'];
}
