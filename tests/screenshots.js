// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Regenerates the pictures in docs/ from the example form, so the README always shows the
// current design. Run with: npm run screenshots

const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const DOCS = path.join(ROOT, 'docs');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCALE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(ROOT, 'examples/demo-form.html')).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/leads/new`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: [EXT] });

  try {
    const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel/panel.html`;

    async function open({ width, height, dark = false }) {
      const site = await browser.newPage();
      await site.setViewport({ width: 800, height, deviceScaleFactor: SCALE });
      await site.goto(url, { waitUntil: 'load' });
      const panel = await browser.newPage();
      await panel.setViewport({ width, height, deviceScaleFactor: SCALE });
      if (dark) await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await panel.goto(panelUrl);
      await panel.evaluate(() => chrome.storage.local.clear());
      const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
      await panel.goto(`${panelUrl}?tabId=${tabId}`);
      await panel.waitForSelector('button.big');
      const click = (text) => panel.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled).click(), text);
      const setValues = (values) => panel.evaluate((values) => {
        for (const row of document.querySelectorAll('#rows .row[data-id]')) {
          const value = values[row.querySelector('.label').value], v = row.querySelector('.value');
          if (value === undefined) continue;
          if (v.classList.contains('picker')) {
            v.click();
            const pop = document.querySelector('#picker');
            for (const o of [...pop.querySelectorAll('[role="option"]')].filter((o) => [].concat(value).includes(o.textContent))) o.click();
            if (pop.matches(':popover-open')) pop.hidePopover();
            continue;
          }
          v.value = value;
          v.dispatchEvent(new Event(v.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        }
      }, values);
      const type = (selector, text) => panel.$eval(selector, (el, text) => { el.value = text; el.dispatchEvent(new Event('input')); }, text);
      const scan = async () => { await click('Scan this page'); await panel.waitForSelector('#rows .row[data-id]'); await type('.editor-head .mono', 'https://crm.example.com/leads/new'); };
      const fill = async () => { await panel.click('#fillBtn'); await panel.waitForSelector('#report .report'); };
      const quiet = () => panel.$eval('#toast', (el) => { el.hidden = true; scrollTo(0, 0); });
      const grab = async (page) => { await page.bringToFront(); return page.screenshot({ encoding: 'base64' }); };
      return { site, panel, click, setValues, type, scan, fill, quiet, grab };
    }

    // Puts screenshots side by side with a hairline between them, the way Chrome docks a side panel.
    async function stitch(file, shots) {
      const page = await browser.newPage();
      const png = await page.evaluate(async (shots, gap) => {
        const images = await Promise.all(shots.map(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); return img; }));
        const canvas = document.createElement('canvas');
        canvas.width = images.reduce((w, img) => w + img.width, 0) + gap * (images.length - 1);
        canvas.height = Math.max(...images.map((img) => img.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#c3cad6';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        let x = 0;
        for (const img of images) { ctx.drawImage(img, x, 0); x += img.width + gap; }
        return canvas.toDataURL('image/png').split(',')[1];
      }, shots, SCALE);
      await page.close();
      fs.writeFileSync(path.join(DOCS, file), Buffer.from(png, 'base64'));
      console.log(file.padEnd(18), Math.round(fs.statSync(path.join(DOCS, file)).size / 1024) + ' KB');
    }

    // 1. The page and the field sheet, just after a fill.
    let t = await open({ width: 440, height: 800 });
    await t.scan();
    await t.type('.name', 'New lead: call back');
    await t.setValues({ 'First name': 'Maria', 'Last name': 'Santos', Company: 'Northwind Trading', 'Work email': 'maria.santos@northwind.example', 'Lead status': 'Call back - interested', Industry: 'IT / Software', Country: 'Singapore', 'Lead date': '{{today}}', 'Company size': '50-249', 'Interested in': ['Security', 'Cloud'], 'Opted in to email updates': 'true' });
    await t.fill();
    await t.click('Save');
    await sleep(1800); // let the page's green highlight fade
    await t.quiet();
    await stitch('screenshot.png', [await t.grab(t.site), await t.grab(t.panel)]);
    await t.site.close(); await t.panel.close();

    // 2. Data rows: the home card stepping through a sheet, and the check on a sheet with mistakes.
    t = await open({ width: 440, height: 760 });
    await t.scan();
    await t.type('.name', 'Leads from the weekly sheet');
    await t.type('.editor-head .mono', '*/leads/new'); // still matches the test page, without showing its address
    await t.panel.click('.tab:nth-child(2)');
    await t.panel.$eval('.paste', (el, text) => { el.value = text; }, fs.readFileSync(path.join(ROOT, 'examples/leads.csv'), 'utf8'));
    await t.click('Use these rows');
    await t.panel.waitForSelector('.sheet');
    await t.click('Save');
    await sleep(400); // saving finishes before Back stops asking about unsaved changes
    await t.click('‹ Profiles');
    await t.panel.waitForSelector('.profile');
    for (const n of [1, 2]) {
      await t.site.reload({ waitUntil: 'load' });
      await t.click('Fill row ' + n);
      await t.panel.waitForSelector('.profile .report');
      await sleep(300);
    }
    await sleep(1800);
    await t.quiet();
    const filledPage = await t.grab(t.site);
    const home = await t.grab(t.panel); // taken last, so the panel is in front for the clicks below
    await t.click('Edit');
    await t.panel.waitForSelector('#rows .row[data-id]');
    await t.panel.click('.tab:nth-child(2)');
    await t.click('Replace rows');
    await (await t.panel.$('#dataFile')).uploadFile(path.join(ROOT, 'examples/leads-with-mistakes.csv'));
    await t.panel.waitForFunction(() => /mistakes/.test(document.querySelector('#toast').textContent));
    await t.quiet();
    await stitch('data-rows.png', [filledPage, home]);
    await stitch('data-check.png', [await t.grab(t.panel)]);
    await t.site.close(); await t.panel.close();

    // 3. A picklist open: the search box, the recently chosen values, then the full list.
    t = await open({ width: 440, height: 640 });
    await t.scan();
    await t.type('.name', 'New lead: call back');
    for (const industry of ['Education', 'Healthcare', 'IT / Software']) {
      await t.setValues({ Industry: industry });
      await sleep(260);
    }
    await t.setValues({ 'First name': 'Maria', 'Last name': 'Santos', Company: 'Northwind Trading' });
    await t.panel.$eval('#toast', (el) => { el.hidden = true; });
    await t.panel.evaluate(() => {
      const row = [...document.querySelectorAll('#rows .row[data-id]')].find((r) => r.querySelector('.label').value === 'Industry');
      row.scrollIntoView({ block: 'start' });
      scrollBy(0, -60);
    });
    await sleep(300);
    await t.panel.evaluate(() => [...document.querySelectorAll('#rows .row[data-id]')].find((r) => r.querySelector('.label').value === 'Industry').querySelector('.value.picker').click());
    await sleep(200);
    await stitch('picker.png', [await t.grab(t.panel)]);
    await t.site.close(); await t.panel.close();

    // 4. The wide sheet in Chrome's dark theme, with a question and a personal detail in it.
    t = await open({ width: 900, height: 660, dark: true });
    await t.panel.evaluate(() => chrome.storage.local.set({ vars: [{ key: 'email', value: 'me@team.example' }] }));
    await t.panel.reload();
    await t.panel.waitForSelector('button.big');
    await t.scan();
    await t.type('.name', 'New lead: ask for the company');
    await t.setValues({ 'First name': 'Maria', 'Last name': 'Santos', 'Lead status': 'Qualified', Company: '{{ask:Company}}', 'Work email': '{{my.email}}', 'Lead date': '{{today}}' });
    await t.quiet();
    await stitch('panel-dark.png', [await t.grab(t.panel)]);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
