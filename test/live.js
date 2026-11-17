/* A check of the published site itself, to run after publishing.
   It opens the live page in headless Chrome, makes one entry with the built-in reader, and reports every
   address the page contacted. It does not connect a key and does not call Claude.
   Usage: node test/live.js [url] [screenshot.png] */
const puppeteer = require('puppeteer-core');
const assert = require('assert');
const URL_ = process.argv[2] || 'https://aviralgupta2211.github.io/horizon/', SHOT = process.argv[3];

(async () => {
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'];
  if (process.env.HTTPS_PROXY) args.push('--proxy-server=' + process.env.HTTPS_PROXY); // some networks only reach the web through a proxy
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const errors = [], hosts = {}, failed = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u)) { const h = new URL(u).host; hosts[h] = (hosts[h] || 0) + 1; } });
  page.on('requestfailed', (r) => failed.push(r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(r.url() + ' HTTP ' + r.status()); });

  await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__hz && window.__hz.S.ready', { timeout: 30000 });
  const site = new URL(URL_).host;
  const facts = await page.evaluate(async () => {
    await document.fonts.ready;
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    let outside = 'sent'; try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch (e) { outside = 'blocked'; }
    return {
      version: window.HZEnv.version, standalone: window.HZEnv.standalone, policy: meta ? meta.content : null, outside,
      fonts: document.fonts.check('italic 500 15px Literata') && document.fonts.check('600 13px "Bricolage Grotesque"'),
      secure: window.isSecureContext, panel: document.querySelector('.panel').innerText
    };
  });
  errors.length = 0; // the refused request above is logged by the browser; it was the point
  assert.strictEqual(facts.standalone, true, 'runs as a website');
  assert.ok(facts.policy && facts.policy.includes("default-src 'none'") && facts.policy.includes('connect-src https://api.anthropic.com'), 'the page locked itself down');
  assert.strictEqual(facts.outside, 'blocked', 'a request to another server is refused');
  assert.ok(facts.fonts, 'both typefaces loaded from the site');
  assert.ok(facts.secure, 'served over https');
  assert.ok(facts.panel.includes('What is on your mind?') && facts.panel.includes('Connect Claude'));

  await page.type('#t-today', 'I think most plans fail quietly. My father always said finish what you start. Why do I trust momentum more than strategy?', { delay: 0 });
  await page.evaluate(() => document.querySelector('[data-act="submit-today"]').click());
  await page.waitForSelector('.move', { timeout: 10000 });
  const s = await page.evaluate(() => ({ units: window.__hz.S.state.units.length, offline: window.__hz.S.state.moves[0].offline, saved: !!localStorage.getItem('horizon.state.v1') || 'pending' }));
  assert.ok(s.units >= 2 && s.offline === true, 'the built-in reader placed the entry');
  await new Promise((r) => setTimeout(r, 900));
  if (SHOT) await page.screenshot({ path: SHOT });

  const others = Object.keys(hosts).filter((h) => h !== site);
  console.log('site       ' + URL_);
  console.log('version    ' + facts.version);
  console.log('requests   ' + JSON.stringify(hosts));
  console.log('placed     ' + s.units + ' things from one entry, with the built-in reader');
  console.log('failed     ' + (failed.length ? failed.join('\n           ') : 'none'));
  console.log('errors     ' + (errors.length ? errors.join('\n           ') : 'none'));
  assert.deepStrictEqual(others, [], 'the page contacted no other server');
  assert.deepStrictEqual(errors, []);
  console.log('\nlive check passed');
  await browser.close();
})().catch((e) => { console.error('\nlive check FAILED\n' + (e && e.stack || e)); process.exit(1); });
