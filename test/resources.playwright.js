async page => {
  await page.evaluate(async () => {
    const previous = sandstone.network.session.fetch;
    globalThis.resourceRequests = [];
    sandstone.network.session.fetch = async (url, options) => {
      if (!url.includes('/resource-fixture/')) return previous(url, options);
      resourceRequests.push(url);
      if (url.endsWith('.css')) return new Response('#styled { color: rgb(12, 34, 56); }', {headers: {'Content-Type': 'text/css'}});
      return new Response(new Uint8Array([0]), {headers: {'Content-Type': 'video/mp4'}});
    };
    main_frame.special_pages['https://fixture.test/resources'] = `<!doctype html><body>
      <div id="styled">Styled content</div>
      <video src="https://fixture.test/resource-fixture/movie.mp4" preload="metadata"></video>
      <script>
        const sheet = document.createElement('link');
        sheet.rel = 'stylesheet'; sheet.href = '/resource-fixture/initial.css';
        sheet.onload = () => { window.stylesheetLoaded = true; };
        document.head.append(sheet);
        window.resourceSheet = sheet;
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
        walker.currentNode = document;
        window.walkerResult = {root: walker.root === document, current: walker.currentNode === document, next: walker.nextNode().tagName};
      <\/script>`;
    await main_frame.navigate_to('https://fixture.test/resources');
  });
  const deadline = Date.now() + 10000;
  while (!await page.evaluate(() => main_frame.eval_js('Boolean(window.stylesheetLoaded)'))) {
    if (Date.now() > deadline) throw new Error('Rewritten dynamic stylesheet did not load');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const result = JSON.parse(await page.evaluate(() => main_frame.eval_js(`JSON.stringify({
    color: getComputedStyle(document.getElementById('styled')).color,
    walker: window.walkerResult, video: document.querySelector('video').src,
    sheet: window.resourceSheet.href
  })`)));
  if (result.color !== 'rgb(12, 34, 56)') throw new Error('Dynamic stylesheet was not applied');
  if (!result.walker.root || !result.walker.current || result.walker.next !== 'HTML') throw new Error('TreeWalker document identity is incorrect');
  if (result.video !== 'https://fixture.test/resource-fixture/movie.mp4') throw new Error('Inherited video src was not virtualized');
  if (result.sheet !== 'https://fixture.test/resource-fixture/initial.css') throw new Error('Stylesheet href was not virtualized');
  const requests = await page.evaluate(() => resourceRequests);
  if (!requests.some(url => url.endsWith('/movie.mp4'))) throw new Error('Video did not use the relay');
  if (!requests.some(url => url.endsWith('/initial.css'))) throw new Error('Stylesheet did not use the relay');
  return ['dynamic stylesheets through the relay', 'inherited media properties', 'TreeWalker document identity'];
}
