/* Renders icons/icon.svg to the PNG sizes phones ask for. Run: node tools/make-icons.js */
const puppeteer = require('puppeteer-core'), fs = require('fs'), path = require('path');
const DIR = path.resolve(__dirname, '..', 'icons'), svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:' + size + 'px;height:' + size + 'px}</style>' + svg);
    await page.screenshot({ path: path.join(DIR, name), clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote icons/' + name);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
