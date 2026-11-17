/* Usage: node test/shot.js <url-path-with-query> <out.png> [width] [height] [dpr] */
const puppeteer = require('puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); rsp.end('not found'); return; }
      rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}
(async () => {
  const [, , urlPath, out, w = '1280', h = '800', dpr = '1'] = process.argv;
  const srv = await serve(), port = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: +w, height: +h, deviceScaleFactor: +dpr });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => { if (r.url().startsWith('http://127.0.0.1')) r.continue(); else r.abort(); });
  await page.goto('http://127.0.0.1:' + port + '/' + urlPath, { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out });
  console.log(errors.length ? errors.join('\n') : 'no page errors', '->', out);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
