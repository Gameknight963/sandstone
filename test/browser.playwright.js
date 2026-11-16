// Run with a Playwright Page against the example server. No live target sites are required.
async (page, url = page.url().startsWith("file:") ? page.url() : "http://127.0.0.1:5001/") => {
  const assert = {
    equal(actual, expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    deepEqual(actual, expected) { this.equal(JSON.stringify(actual), JSON.stringify(expected)); },
    match(actual, pattern) { if (!pattern.test(actual)) throw new Error(`Expected ${actual} to match ${pattern}`); },
    doesNotMatch(actual, pattern) { if (pattern.test(actual)) throw new Error(`Expected ${actual} not to match ${pattern}`); }
  };
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => globalThis.main_frame && sandstone.libcurl.ready && !main_frame.is_navigating);
  await page.evaluate(async () => {
    const fixture = `<!doctype html><title>Compatibility fixture</title><body>
      <form action="/upload" method="post" enctype="multipart/form-data"><input name="field" value="value"><button name="send" value="yes">Send</button></form>
      <script>
        window.fixtureResult = [];
        localStorage.empty = '';
        localStorage.value = 'persisted';
        sessionStorage.value = 'session';
        document.cookie = 'script=visible; Path=/';
        const first = document.createElement('script');
        first.textContent = 'window.fixtureResult.push("inline")';
        document.body.append(first);
        const fragment = document.createDocumentFragment();
        const second = document.createElement('script');
        second.textContent = 'window.fixtureResult.push("fragment")';
        fragment.append(second);
        document.body.append(fragment);
        const container = document.createElement('div');
        document.body.append(container);
        container.innerHTML = '<script>window.fixtureResult.push("inert")<\\/script><span>content</span>';
        const external = document.createElement('script');
        external.src = '/external.js';
        document.body.append(external);
        window.fixtureResult.push('initial');
      <\/script>`;
    globalThis.fixtureRequests = [];
    const makeResponse = (body, init = {}) => {
      const response = new Response(body, init);
      // Match libcurl: browsers hide Set-Cookie in Headers even on constructed responses.
      Object.defineProperty(response, 'raw_headers', {value: Object.entries(init.headers || {})});
      return response;
    };
    sandstone.network.session.fetch = async (url, init) => {
      fixtureRequests.push({url, method: init.method, headers: init.headers, body: init.body ? [...new Uint8Array(init.body)] : null});
      if (url.endsWith('/external.js')) return makeResponse('window.fixtureResult.push("external")', {headers: {'Content-Type': 'text/javascript'}});
      if (url.endsWith('/stream')) {
        return makeResponse(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
            setTimeout(() => { controller.enqueue(new TextEncoder().encode('second')); controller.close(); }, 150);
          }
        }), {headers: {'Content-Type': 'text/plain', 'Set-Cookie': 'http=visible; Path=/'}});
      }
      if (url.endsWith('/status')) return makeResponse('missing', {status: 404, headers: {'Content-Type': 'text/plain'}});
      if (url.endsWith('/upload')) return makeResponse('<!doctype html><body>Uploaded</body>', {headers: {'Content-Type': 'text/html'}});
      return makeResponse(fixture, {headers: {'Content-Type': 'text/html', 'Set-Cookie': 'secret=hidden; HttpOnly; Path=/'}});
    };
    await main_frame.navigate_to('https://fixture.test/');
  });
  await page.waitForFunction(async () => {
    const result = await main_frame.eval_js('JSON.stringify(window.fixtureResult)');
    return JSON.parse(result).includes('external');
  });
  const runtime = await page.evaluate(() => main_frame.eval_js(`JSON.stringify({
    result: window.fixtureResult,
    cookies: document.cookie,
    empty: localStorage.getItem('empty'),
    stored: localStorage.value,
    session: sessionStorage.value,
    webrtc: typeof RTCPeerConnection
  })`));
  const parsed = JSON.parse(runtime);
  assert.deepEqual(parsed.result, ['inline', 'fragment', 'initial', 'external']);
  assert.match(parsed.cookies, /script=visible/);
  assert.doesNotMatch(parsed.cookies, /secret/);
  assert.equal(parsed.empty, '');
  assert.equal(parsed.stored, 'persisted');
  assert.equal(parsed.session, 'session');
  assert.equal(parsed.webrtc, 'undefined');

  const stream = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
    const response = await fetch('/stream');
    const reader = response.body.getReader();
    const first = await reader.read();
    const second = await reader.read();
    return JSON.stringify({first: new TextDecoder().decode(first.value), second: new TextDecoder().decode(second.value), cookies: document.cookie});
  })()`)));
  assert.equal(stream.first, 'first');
  assert.equal(stream.second, 'second');
  assert.match(stream.cookies, /http=visible/);

  const response = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
    const response = await fetch('/status');
    const copy = response.clone();
    return JSON.stringify({status: copy.status, ok: copy.ok, url: copy.url, text: await copy.text(), original: await response.text(), secret: response.headers.get('set-cookie')});
  })()`)));
  assert.deepEqual(response, {status: 404, ok: false, url: 'https://fixture.test/status', text: 'missing', original: 'missing', secret: null});

  const databaseResult = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
    const done = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const open = indexedDB.open('fixture-idb', 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore('records', {keyPath: 'id', autoIncrement: true});
      store.createIndex('byName', 'name', {unique: true});
    };
    const database = await done(open);
    const transaction = database.transaction('records', 'readwrite');
    const committed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    });
    const store = transaction.objectStore('records');
    const request = store.put({name: 'alpha', bytes: new Uint8Array([2, 3, 4]), blob: new Blob(['contents'])});
    const key = await done(request);
    const value = await done(store.index('byName').get(IDBKeyRange.only('alpha')));
    const rows = [];
    const cursor = store.openCursor();
    await new Promise((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) return resolve();
        rows.push(cursor.result.primaryKey); cursor.result.continue();
      };
    });
    await committed;
    const blob = await value.blob.text();
    const result = {key, rows, name: value.name, bytes: Array.from(value.bytes), blob,
      databaseBrand: database instanceof IDBDatabase, requestBrand: request instanceof IDBRequest,
      stores: Array.from(database.objectStoreNames)};
    database.close();
    return JSON.stringify(result);
  })()`)));
  assert.deepEqual(databaseResult, {key: 1, rows: [1], name: 'alpha', bytes: [2, 3, 4], blob: 'contents', databaseBrand: true, requestBrand: true, stores: ['records']});

  await page.evaluate(() => main_frame.navigate_to('https://fixture.test/again'));
  const restored = JSON.parse(await page.evaluate(() => main_frame.eval_js('JSON.stringify({local: localStorage.value, session: sessionStorage.value})')));
  assert.deepEqual(restored, {local: 'persisted', session: 'session'});
  const savedDatabase = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
    const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const database = await done(indexedDB.open('fixture-idb'));
    const record = await done(database.transaction('records').objectStore('records').get(1));
    database.close(); return JSON.stringify({name: record.name});
  })()`)));
  assert.deepEqual(savedDatabase, {name: 'alpha'});

  await page.evaluate(() => main_frame.eval_js("document.querySelector('button').click()"));
  await page.waitForFunction(() => main_frame.url.pathname === '/upload');
  const upload = await page.evaluate(() => fixtureRequests.find(request => request.url.endsWith('/upload')));
  assert.equal(upload.method, 'POST');
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  const uploadBody = new TextDecoder().decode(new Uint8Array(upload.body));
  assert.match(uploadBody, /name="field"/);
  assert.match(uploadBody, /name="send"/);

  await page.evaluate(async () => {
    main_frame.special_pages['https://inactive.test/'] = '<!doctype html><body>Inactive database fixture</body>';
    await main_frame.navigate_to('https://inactive.test/');
  });
  await page.evaluate(() => main_frame.eval_js(`new Promise((resolve, reject) => {
    const request = indexedDB.open('discard');
    request.onupgradeneeded = () => request.result.createObjectStore('items');
    request.onsuccess = () => { request.result.close(); resolve(true); };
    request.onerror = () => reject(request.error);
  })`));
  await page.evaluate(() => main_frame.navigate_to('https://fixture.test/upload'));

  await page.getByRole('button', {name: 'Options', exact: true}).evaluate(button => button.click());
  await page.locator('#theme_select').selectOption('dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  await page.evaluate(() => {
    const data = sandstone.controller.site_data;
    data.setCookie('https://inactive.test/', 'saved=1; Path=/');
    data.setLocal('https://inactive.test', [['key', 'value']]);
    document.getElementById('site_data_details').open = true;
  });
  const storedSite = page.locator('.site_data_row').filter({hasText: 'inactive.test'});
  await storedSite.getByRole('button', {name: 'Clear IndexedDB', exact: true}).evaluate(button => button.click());
  await page.waitForFunction(() => sandstone.controller.site_data.list().find(site => site.hostname === 'inactive.test')?.indexedDB === 0);
  assert.deepEqual(await page.evaluate(() => sandstone.controller.indexed_db.databases('https://inactive.test')), []);
  await storedSite.getByRole('button', {name: 'Clear all', exact: true}).evaluate(button => button.click());
  await page.waitForFunction(() => !sandstone.controller.site_data.list().some(site => site.hostname === 'inactive.test'));
  assert.equal(await page.evaluate(() => sandstone.controller.site_data.list().some(site => site.hostname === 'inactive.test')), false);
  await page.locator('#close_options_button').evaluate(button => button.click());
  await page.locator('#hide_ui_button').evaluate(button => button.click());
  assert.equal(await page.locator('#address_bar').isVisible(), false);
  assert.equal(await page.locator('#show_ui_button').isVisible(), true);
  await page.locator('#show_ui_button').evaluate(button => button.click());
  assert.equal(await page.locator('#address_bar').isVisible(), true);
  assert.deepEqual(errors, []);
  return {url, passed: ['dynamic scripts', 'fragments', 'inert innerHTML', 'cookies', 'localStorage', 'sessionStorage', 'streaming', 'response cloning', 'multipart forms', 'IndexedDB indexes/cursors/binary data', 'IndexedDB navigation persistence', 'dark mode', 'per-site database clearing', 'hide/show UI', 'WebRTC disabled']};
}
