// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// End-to-end tests. Loads the unpacked extension into headless Chrome, opens the panel as a page
// bound to a test tab, and drives it the way a person would: scan, type values, fill, undo.
// Run with: npm install, then npm test. Screenshots of each screen are written to tests/shots.

const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = path.join(__dirname, 'shots');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROUTES = {
  '/leads/new': path.join(ROOT, 'examples/demo-form.html'),
  '/widgets.html': path.join(__dirname, 'fixtures/widgets.html'),
  '/frame.html': path.join(__dirname, 'fixtures/frame.html'),
  '/long.html': path.join(__dirname, 'fixtures/long-page.html'),
};
const GOOD = fs.readFileSync(path.join(ROOT, 'examples/leads.csv'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok    ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name + (detail === undefined ? '' : '\n        got: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
}
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), got);
const section = (title) => console.log('\n' + title);

(async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const file = ROUTES[new URL(req.url, 'http://x').pathname];
      if (!file) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: [EXT] });
  const errors = [];

  try {
    const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const panelUrl = `chrome-extension://${id}/panel/panel.html`;

    // Opens a test page and a panel bound to it. Returns helpers for driving both.
    async function open(urlPath, { width = 420, dark = false, wipe = true } = {}) {
      const site = await browser.newPage();
      await site.setViewport({ width: 1000, height: 900 });
      await site.goto(base + urlPath, { waitUntil: 'load' });
      const panel = await browser.newPage();
      panel.on('pageerror', (e) => errors.push('panel error: ' + e.message));
      panel.on('console', (m) => { if (m.type() === 'error') errors.push('panel console: ' + m.text()); });
      await panel.setViewport({ width, height: 900 });
      if (dark) await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await panel.goto(panelUrl);
      if (wipe) await panel.evaluate(() => chrome.storage.local.clear());
      const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, base + urlPath);
      await panel.goto(`${panelUrl}?tabId=${tabId}`);
      await panel.waitForSelector('button.big');

      const click = (text) => panel.evaluate((text) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text && !x.disabled);
        if (!b) throw new Error('no enabled button "' + text + '"');
        b.click();
      }, text);
      const toast = () => panel.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));
      const rows = () => panel.$$eval('#rows .row[data-id]', (rs) => rs.map((r) => {
        const v = r.querySelector('.value');
        return {
          label: r.querySelector('.label').value, selector: r.querySelector('.selector').value,
          control: v.classList.contains('picker') ? (v.dataset.multiple ? 'checklist' : 'dropdown') : v.tagName === 'SELECT' ? 'dropdown' : v.classList.contains('template') ? 'template' : v.tagName === 'TEXTAREA' ? 'textarea' : v.type,
          value: v.classList.contains('picker') ? (v.classList.contains('blank') ? '' : v.querySelector('.picker-text').textContent) : v.value,
          required: !!r.querySelector('.req'), tone: ['ok', 'warn', 'bad'].find((c) => r.classList.contains(c)) || '', msg: r.querySelector('.msg')?.textContent || '',
        };
      }));
      const row = async (label) => (await rows()).find((r) => r.label === label);
      // Sets a row's value the way a person would: typing into a box, or opening the searchable
      // list and clicking an entry. An array ticks exactly those entries of a multi-select.
      const setValue = (label, value) => panel.evaluate((label, value) => {
        const r = [...document.querySelectorAll('#rows .row[data-id]')].find((x) => x.querySelector('.label').value === label);
        if (!r) throw new Error('no row "' + label + '"');
        const v = r.querySelector('.value');
        if (v.classList.contains('picker')) {
          v.click();
          const pop = document.querySelector('#picker');
          const items = () => [...pop.querySelectorAll('[role="option"]:not(.recent)')];
          const name = (o) => o.textContent.replace('✓', '');
          if (!v.dataset.multiple) {
            const hit = items().find((o) => o.dataset.value === value || name(o) === value);
            if (!hit) { pop.hidePopover(); throw new Error(`the list for "${label}" has no "${value}"`); }
            return hit.click();
          }
          for (const text of items().map(name).filter((x) => x !== 'Clear all')) {
            const o = items().find((x) => name(x) === text);
            if ((o.getAttribute('aria-selected') === 'true') !== value.includes(text)) o.click();
          }
          return pop.hidePopover();
        }
        v.value = value;
        if (v.tagName === 'SELECT' && v.value !== value) throw new Error(`the dropdown for "${label}" has no "${value}"`);
        v.dispatchEvent(new Event(v.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        if (v.tagName !== 'SELECT') v.dispatchEvent(new Event('change', { bubbles: true }));
      }, label, value);
      // Chooses an entry of a row's "{ }" menu by its visible text.
      const insert = (label, entry) => panel.evaluate((label, entry) => {
        const r = [...document.querySelectorAll('#rows .row[data-id]')].find((x) => x.querySelector('.label').value === label);
        const menu = r.querySelector('.insert');
        const option = [...menu.options].find((o) => o.textContent === entry);
        if (!option) throw new Error(`"{ }" menu of "${label}" has no "${entry}": ` + [...menu.options].map((o) => o.textContent).join(' | '));
        menu.value = option.value;
        menu.dispatchEvent(new Event('change'));
      }, label, entry);
      const report = () => panel.evaluate(() => {
        const r = document.querySelector('#report .report, .profile .report');
        if (!r) return null;
        return {
          tone: r.classList.contains('ok') ? 'ok' : 'warn', head: r.querySelector('.report-head strong').textContent,
          problems: [...r.querySelectorAll('ul li')].map((li) => li.textContent), missing: [...r.querySelectorAll('.chips .link')].map((b) => b.textContent),
        };
      });
      // Runs something that ends in a new fill report, and returns that report.
      const reportAfter = async (action) => {
        await panel.evaluate(() => document.querySelectorAll('.report').forEach((r) => { r.dataset.old = '1'; }));
        await action();
        await panel.waitForSelector('#report .report:not([data-old]), .profile .report:not([data-old])', { timeout: 15000 });
        return report();
      };
      const fill = () => reportAfter(() => panel.click('#fillBtn'));
      const scan = async () => { await click('Scan this page'); await panel.waitForSelector('#rows .row[data-id]', { timeout: 15000 }); };
      const form = () => site.evaluate(() => {
        const g = (i) => document.getElementById(i);
        return {
          first: g('first').value, last: g('last').value, company: g('company').value, email: g('email').value, phone: g('phone').value, country: g('country').value,
          status: g('status').value, industry: g('industry').value, date: g('date').value, followup: g('followup').value, employees: g('employees').value,
          size: document.querySelector('[name=size]:checked')?.value || '', interests: [...document.querySelectorAll('[name="interest[]"]:checked')].map((e) => e.value).join(','),
          notes: g('notes').value, optin: g('optin').checked,
        };
      });
      const shot = async (name, fullPage = false) => { await panel.bringToFront(); await panel.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage }); };
      const close = async () => { await site.close(); await panel.close(); };
      return { site, panel, tabId, click, toast, rows, row, setValue, insert, report, reportAfter, fill, scan, form, shot, close };
    }

    const BLANK = { first: '', last: '', company: '', email: '', phone: '', country: '', status: '', industry: '', date: '', followup: '', employees: '', size: '', interests: '', notes: '', optin: false };

    // ------------------------------------------------------------------
    section('1. Reading pasted spreadsheets');
    let t = await open('/leads/new');
    const units = await t.panel.evaluate(async () => {
      const { parseTable } = await import('../lib/table.js');
      const { resolveValue, asksIn, mappedColumn } = await import('../lib/template.js');
      const { matchesUrl, suggestPattern } = await import('../lib/url.js');
      const fails = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
      const ctx = { row: { Company: 'Acme', Blank: '' }, vars: { Email: 'me@x.example' }, answers: { Who: 'Zed' } };
      return {
        csvQuotes: parseTable('Name,Note\n"Smith, John","He said ""hi""\nthen left"\nAna,\n'),
        tsvDuplicateHeads: parseTable('A\tB\tA\n1\t2\t3\n\n4\t5\t6'),
        semicolons: parseTable('x;y\n1,5;2'),
        noHeader: parseTable('a,b\nc,d', false),
        bomAndCrlf: parseTable('\uFEFFh1,h2\r\nv1,v2\r\n'),
        raggedRows: parseTable('a,b,c\n1\n1,2,3,4'),
        headerOnly: fails(() => parseTable('Name,Email\n')),
        empty: fails(() => parseTable('  \n ')),
        column: resolveValue('{{ company }} Ltd', ctx),
        mine: resolveValue('{{my.email}}', ctx),
        asked: resolveValue('{{ask:Who}}', ctx),
        builtIn: resolveValue('{{today+7}}', ctx),
        plain: resolveValue('abc', ctx),
        list: resolveValue(['a', 'b'], ctx),
        blankCell: resolveValue('{{Blank}}', ctx),
        unknownColumn: resolveValue('{{Nope}}', ctx),
        noRows: resolveValue('{{Nope}}', { ...ctx, row: null }),
        unknownMine: resolveValue('{{my.x}}', ctx),
        asks: asksIn([{ value: '{{ask:A}}' }, { value: 'x {{ask:B}} {{ask:A}}' }, { value: ['{{ask:C}}'] }]),
        mapped: [mappedColumn('{{Company}}'), mappedColumn('x {{Company}}'), mappedColumn('{{ask:C}}'), mappedColumn('plain')],
        urls: [
          suggestPattern('https://crm.example.com/index.php?module=Leads&view=Edit&record=88123'),
          matchesUrl('https://crm.example.com/index.php?module=Leads&view=Edit', 'https://crm.example.com/index.php?module=Leads&view=Edit&record=5'),
          matchesUrl('https://crm.example.com/index.php?module=Leads&view=Edit', 'https://crm.example.com/index.php?module=Contacts&view=Edit'),
          suggestPattern('https://x.example/leads/88123/edit'), matchesUrl('https://x.example/leads/*/edit', 'https://x.example/leads/7/edit/'),
        ],
      };
    });
    same('CSV with commas, quotes and a line break inside a cell', units.csvQuotes, { columns: ['Name', 'Note'], rows: [['Smith, John', 'He said "hi"\nthen left'], ['Ana', '']] });
    same('tab-separated paste, blank line skipped, duplicate heading renamed', units.tsvDuplicateHeads, { columns: ['A', 'B', 'A (2)'], rows: [['1', '2', '3'], ['4', '5', '6']] });
    same('semicolon-separated file keeps decimal commas', units.semicolons, { columns: ['x', 'y'], rows: [['1,5', '2']] });
    same('no heading row gives Column A, Column B', units.noHeader, { columns: ['Column A', 'Column B'], rows: [['a', 'b'], ['c', 'd']] });
    same('byte-order mark and Windows line endings', units.bomAndCrlf, { columns: ['h1', 'h2'], rows: [['v1', 'v2']] });
    same('short and long rows are squared up', units.raggedRows, { columns: ['a', 'b', 'c', 'Column D'], rows: [['1', '', '', ''], ['1', '2', '3', '4']] });
    check('heading row with nothing under it is explained', /Only the header row/.test(units.headerOnly), units.headerOnly);
    check('empty paste is explained', /nothing to read/.test(units.empty), units.empty);

    section('2. Working out {{tokens}}');
    same('column, ignoring case and spaces', units.column, { value: 'Acme Ltd' });
    same('{{my.email}} from My details', units.mine, { value: 'me@x.example' });
    same('{{ask:Who}} from the answers', units.asked, { value: 'Zed' });
    same('{{today+7}} is left for the page engine', units.builtIn, { value: '{{today+7}}' });
    same('plain text and lists pass through', [units.plain, units.list], [{ value: 'abc' }, { value: ['a', 'b'] }]);
    same('a blank cell means leave the field alone', units.blankCell, { empty: true });
    check('unknown column is an error', /no column called “Nope”/.test(units.unknownColumn.error || ''), units.unknownColumn);
    check('column token without any data rows is an error', /needs data rows/.test(units.noRows.error || ''), units.noRows);
    check('unknown My details key is an error', /“my.x” is not set in My details/.test(units.unknownMine.error || ''), units.unknownMine);
    same('each question is asked once, in order', units.asks, ['A', 'B']);
    same('a column counts as matched only when it is the whole value', units.mapped, ['Company', null, null, null]);
    same('page patterns', units.urls, ['https://crm.example.com/index.php?module=Leads&view=Edit', true, false, 'https://x.example/leads/*/edit', true]);

    // ------------------------------------------------------------------
    section('3. Scanning the demo form');
    await t.shot('01-home-empty');
    await t.scan();
    let r = await t.rows();
    same('15 fields found, in page order', r.map((x) => x.label), ['First name', 'Last name', 'Company', 'Work email', 'Phone', 'Country', 'Lead status', 'Industry', 'Lead date', 'Follow-up date', 'Employees', 'Company size', 'Interested in', 'Notes', 'Opted in to email updates']);
    same('required fields are marked', r.filter((x) => x.required).map((x) => x.label), ['First name', 'Last name', 'Company', 'Work email', 'Lead status']);
    same('each field gets a fitting control', Object.fromEntries(r.map((x) => [x.label, x.control]).filter(([l]) => ['Lead status', 'Company size', 'Interested in', 'Notes', 'Opted in to email updates', 'Country'].includes(l))),
      { Country: 'text', 'Lead status': 'dropdown', 'Company size': 'dropdown', 'Interested in': 'checklist', Notes: 'textarea', 'Opted in to email updates': 'dropdown' });

    section('4. Filling fixed values, the pre-save check, and undo');
    await t.setValue('First name', 'Maria');
    await t.setValue('Lead status', 'Qualified');
    await t.setValue('Company size', '50-249');
    await t.setValue('Interested in', ['Security', 'AI']);
    await t.setValue('Opted in to email updates', 'true');
    await t.setValue('Lead date', '{{today}}');
    let rep = await t.fill();
    let f = await t.form();
    same('the page holds the values', [f.first, f.status, f.size, f.interests, f.optin], ['Maria', 'Qualified', '50-249', 'security,ai', true]);
    check('{{today}} follows the field’s own dd/mm/yyyy format', /^\d{2}\/\d{2}\/\d{4}$/.test(f.date), f.date);
    same('report counts the fields', rep.head, 'Filled 6 fields');
    same('report lists required fields that are still empty', rep.missing, ['Last name', 'Company', 'Work email']);
    same('filled rows are marked', (await t.rows()).filter((x) => x.tone === 'ok').length, 6);
    await t.shot('02-editor-filled');
    await t.click('Undo');
    await sleep(600);
    same('undo puts every field back', await t.form(), BLANK);
    check('undo says what it did', /Put 6 fields back the way they were/.test(await t.toast()), await t.toast());
    await t.click('Undo').then(() => check('undo is switched off once used', false), () => check('undo is switched off once used', true));

    // ------------------------------------------------------------------
    section('5. Wrong values are explained, field by field');
    for (const label of ['First name', 'Lead status', 'Company size', 'Opted in to email updates', 'Lead date']) await t.setValue(label, '');
    await t.setValue('Interested in', []);
    await t.setValue('Work email', 'not-an-email');
    await t.setValue('Phone', 'call me');
    await t.setValue('Employees', 'about fifty');
    await t.setValue('Follow-up date', 'next week');
    await t.setValue('Country', '{{my.nickname}}');
    await t.setValue('Company', '{{Account name}}');
    await t.insert('Lead status', 'Ask me each time');
    same('a picklist turns into a token box', (await t.row('Lead status')).value, '{{ask:Lead status}}');
    await t.click('Row');
    await t.panel.evaluate(() => {
      const last = [...document.querySelectorAll('#rows .row[data-id]')].at(-1);
      const set = (cls, v) => { const el = last.querySelector(cls); el.value = v; el.dispatchEvent(new Event('input')); };
      set('.label', 'Ghost field'); set('.selector', '#does-not-exist'); set('.value', 'x');
    });
    await t.panel.click('#fillBtn');
    await t.panel.waitForSelector('#ask[open]');
    same('the panel asks for the value', await t.panel.$$eval('#ask label span', (els) => els.map((e) => e.textContent)), ['Lead status']);
    await t.shot('03-ask-dialog');
    await t.panel.type('#ask input', 'Nonsense');
    rep = await t.reportAfter(() => t.panel.click('#ask button.primary'));
    r = await t.rows();
    const msg = (label) => r.find((x) => x.label === label);
    check('unknown picklist value', msg('Lead status').tone === 'bad' && /No option “Nonsense” in this list/.test(msg('Lead status').msg), msg('Lead status'));
    check('bad email is filled but flagged with the browser’s reason', msg('Work email').tone === 'warn' && /@/.test(msg('Work email').msg), msg('Work email'));
    check('phone that breaks the page’s pattern is flagged', msg('Phone').tone === 'warn' && msg('Phone').msg.length > 5, msg('Phone'));
    check('words in a number field', msg('Employees').tone === 'bad' && /number field does not accept “about fifty”/.test(msg('Employees').msg), msg('Employees'));
    check('words in a date field', msg('Follow-up date').tone === 'bad' && /date field does not accept “next week”/.test(msg('Follow-up date').msg), msg('Follow-up date'));
    check('{{my.…}} that was never set', msg('Country').tone === 'bad' && /“my.nickname” is not set in My details/.test(msg('Country').msg), msg('Country'));
    check('column token with no data rows', msg('Company').tone === 'bad' && /needs data rows/.test(msg('Company').msg), msg('Company'));
    check('selector that matches nothing', msg('Ghost field').tone === 'bad' && /Not found on this page/.test(msg('Ghost field').msg), msg('Ghost field'));
    same('report: only the two flagged-but-filled fields count', rep.head, 'Filled 2 fields');
    same('report lists all eight problems', rep.problems.length, 8);
    same('report is amber', rep.tone, 'warn');
    await t.shot('04-wrong-values');
    await t.panel.click('#fillBtn');
    await t.panel.waitForSelector('#ask[open]');
    same('the last answer is offered again', await t.panel.$eval('#ask input', (e) => e.value), 'Nonsense');
    await t.click('Cancel');
    await sleep(300);
    same('cancelling the question fills nothing new', (await t.report()).head, 'Filled 2 fields');

    // ------------------------------------------------------------------
    section('6. My details');
    await t.panel.click('#detailsBtn');
    await t.panel.waitForSelector('.var');
    await t.panel.evaluate(() => {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); };
      const vars = [...document.querySelectorAll('.var')];
      set(vars[1].querySelector('.var-value'), 'jo@team.example');
      set(vars[2].querySelector('.var-key'), 'nickname'); set(vars[2].querySelector('.var-value'), 'Jo');
    });
    await sleep(300);
    await t.shot('05-my-details');
    await t.click('‹ Back to the profile');
    await t.panel.waitForSelector('#rows .row[data-id]');
    same('coming back keeps the unsaved sheet', [(await t.rows()).length, await t.panel.$eval('#status', (e) => e.textContent)], [16, 'Unsaved changes']);
    await t.setValue('Work email', '');
    await t.insert('Work email', 'email');
    for (const label of ['Phone', 'Employees', 'Follow-up date', 'Company', 'Lead status', 'Ghost field']) await t.setValue(label, '');
    same('emptying the token turns the picklist back into a dropdown', (await t.row('Lead status')).control, 'dropdown');
    rep = await t.fill();
    f = await t.form();
    same('{{my.email}} and {{my.nickname}} are filled in', [f.email, f.country], ['jo@team.example', 'Jo']);
    same('nothing left to complain about', rep.problems, []);

    // ------------------------------------------------------------------
    section('7. Data rows: paste, match, fill row by row');
    await t.close();
    t = await open('/leads/new');
    await t.scan();
    await t.panel.click('.tab:nth-child(2)');
    await t.shot('06-data-empty');
    await t.panel.$eval('.paste', (el, text) => { el.value = text; }, GOOD);
    await t.click('Use these rows');
    await t.panel.waitForSelector('.sheet');
    check('loading says how many rows and matches', /Loaded 5 rows from the box above\. 14 of 14 columns matched to fields\./.test(await t.toast()), await t.toast());
    same('every column is matched to its field', await t.panel.$$eval('.match .picker', (els) => els.filter((e) => e.dataset.value).length), 14);
    check('the check passes', /All 5 rows look right/.test(await t.panel.$eval('#pane .report', (e) => e.textContent)));
    same('the first row is next', await t.panel.$$eval('.sheet tbody tr', (trs) => trs.map((tr) => tr.className)), ['current', '', '', '', '']);
    await t.shot('07-data-loaded', true);
    same('the Fill button names the row', await t.panel.$eval('#fillBtn', (e) => e.textContent), 'Fill row 1');
    rep = await t.fill();
    const ROW1 = { first: 'Maria', last: 'Santos', company: 'Northwind Trading', email: 'maria.santos@northwind.example', phone: '+65 6123 4567', country: 'Singapore', status: 'Call back - interested', industry: 'IT / Software', date: '', followup: '2026-11-02', employees: '120', size: '50-249', interests: 'security,cloud', notes: 'Asked for a demo, prefers mornings', optin: true };
    const ROW2 = { first: 'Daniel', last: 'Okafor', company: 'Lakeside Clinics', email: 'd.okafor@lakeside.example', phone: '+60 3 5550 1299', country: 'Malaysia', status: 'New', industry: 'Healthcare', date: '', followup: '2026-11-05', employees: '640', size: '250+', interests: 'cloud', notes: '', optin: false };
    same('row 1 lands in the form', await t.form(), ROW1);
    same('clean report naming the row', [rep.head, rep.tone, rep.missing], ['Filled 14 fields from row 1 of 5', 'ok', []]);
    same('a try-out in the editor stays on the row', await t.panel.$eval('#fillBtn', (e) => e.textContent), 'Fill row 1');
    await t.panel.$eval('.name', (e) => { e.value = 'Leads from sheet'; e.dispatchEvent(new Event('input')); });
    await t.click('Save');
    await sleep(300);
    await t.click('‹ Profiles');
    await t.panel.waitForSelector('.profile');
    const card = () => t.panel.evaluate(() => ({ button: document.querySelector('.profile-head button').textContent, info: document.querySelector('.rowinfo span')?.textContent }));
    same('home card shows where the sheet has got to', await card(), { button: 'Fill row 1', info: 'Next: row 1 of 5 · Maria' });
    await t.site.reload({ waitUntil: 'load' });
    rep = await t.reportAfter(() => t.click('Fill row 1'));
    same('Fill on home takes row 1 and moves on', [await t.form(), rep.head, await card()], [ROW1, 'Filled 14 fields from row 1 of 5', { button: 'Fill row 2', info: 'Next: row 2 of 5 · Daniel' }]);
    await t.shot('08-home-rows');
    await t.site.reload({ waitUntil: 'load' });
    rep = await t.reportAfter(() => t.click('Fill row 2'));
    same('row 2: a blank cell leaves the field alone, "no" unticks', await t.form(), ROW2);
    await t.click('Undo');
    await sleep(700);
    same('undo empties the page and steps back to row 2', [await t.form(), await card()], [BLANK, { button: 'Fill row 2', info: 'Next: row 2 of 5 · Daniel' }]);
    await t.panel.click('.rowbar button[title="Skip this row"]');
    await sleep(400);
    same('skip moves to row 3', (await card()).button, 'Fill row 3');
    await t.panel.click('.rowbar button[title="Go back one row"]');
    await sleep(400);
    same('back returns to row 2', (await card()).button, 'Fill row 2');
    for (const n of [2, 3, 4, 5]) {
      await t.site.reload({ waitUntil: 'load' });
      await t.reportAfter(() => t.click('Fill row ' + n));
    }
    same('row 5 is the last one filled', (await t.form()).first, 'Aiko');
    same('after the last row the card says so', await card(), { button: 'Start over', info: 'All 5 rows done' });
    const finished = await t.panel.evaluate(async (tabId) => {
      const { runProfile } = await import('../lib/runner.js');
      const { listProfiles } = await import('../lib/store.js');
      return (await runProfile(tabId, (await listProfiles())[0], { ask: () => ({}) })).outcome;
    }, t.tabId);
    same('filling past the end does nothing', finished, 'finished');
    await t.click('Start over');
    await sleep(400);
    same('Start over goes back to row 1', (await card()).button, 'Fill row 1');

    // ------------------------------------------------------------------
    section('8. A spreadsheet with mistakes in it');
    await t.click('Edit');
    await t.panel.waitForSelector('#rows .row[data-id]');
    await t.panel.click('.tab:nth-child(2)');
    await t.click('Replace rows');
    await (await t.panel.$('#dataFile')).uploadFile(path.join(ROOT, 'examples/leads-with-mistakes.csv'));
    await t.panel.waitForFunction(() => /leads-with-mistakes/.test(document.querySelector('#toast').textContent));
    const dataCheck = await t.panel.evaluate(() => ({
      head: document.querySelector('#pane .report-head strong').textContent,
      items: [...document.querySelectorAll('#pane .report li')].map((li) => li.textContent),
      red: [...document.querySelectorAll('.sheet td.bad')].map((td) => td.textContent),
    }));
    same('the check counts the bad cells', dataCheck.head, '9 cells in 3 rows will not fill correctly');
    same('each bad cell is explained', dataCheck.items, [
      'Row 2, Work email: “pedro.alvarez-at-sunrise.example” is not an email address',
      'Row 2, Lead status: “Call back - maybe” is not one of the page’s options',
      'Row 3, Company: is empty, but the page requires it',
      'Row 3, Industry: “Fintech” is not one of the page’s options',
      'Row 3, Company size: “5000+” is not one of the page’s options',
      'Row 4, Follow-up date: “next week” is not a date',
      'Row 4, Employees: “about fifty” is not a number',
      'Row 4, Interested in: “Blockchain” is not one of the page’s options',
      'Row 4, Opted in to email updates: “maybe” should be yes or no',
    ]);
    same('the same cells are red in the table', dataCheck.red, ['pedro.alvarez-at-sunrise.example', 'Call back - maybe', '', 'Fintech', '5000+', 'next week', 'about fifty', 'Security; Blockchain', 'maybe']);
    await t.shot('09-data-mistakes', true);
    const fillRow = async (n) => {
      await t.panel.$eval(`.sheet tbody tr:nth-child(${n})`, (tr) => tr.click());
      await t.site.reload({ waitUntil: 'load' });
      return t.fill();
    };
    rep = await fillRow(2);
    same('row 2: filled what it could', rep.head, 'Filled 13 fields from row 2 of 5');
    check('row 2: the two problems are named', rep.problems.length === 2 && /Work email .*@/.test(rep.problems[0]) && /Lead status No option “Call back - maybe”/.test(rep.problems[1]), rep.problems);
    same('row 2: the page’s required status is still empty', rep.missing, ['Lead status']);
    rep = await fillRow(3);
    same('row 3: blank required cell is caught by the pre-save check', [rep.head, rep.missing, rep.problems.length], ['Filled 11 fields from row 3 of 5', ['Company'], 2]);
    rep = await fillRow(4);
    check('row 4: four different kinds of mistake', rep.problems.length === 4 && rep.problems.some((p) => /A tick box needs yes or no, not “maybe”/.test(p)) && rep.problems.some((p) => /No option “Blockchain” here/.test(p)), rep.problems);
    same('row 4: the known interest is still ticked', (await t.form()).interests, 'security');
    rep = await fillRow(5);
    check('row 5: phone pattern is only caught by the page itself', rep.problems.length === 1 && /^Phone /.test(rep.problems[0]), rep.problems);
    await t.panel.click('.tab:nth-child(1)');
    await t.shot('10-row-problems');

    // ------------------------------------------------------------------
    section('9. Sharing: exports leave the data rows behind');
    const sharing = await t.panel.evaluate(async () => {
      const { listProfiles, exportPayload, importProfiles } = await import('../lib/store.js');
      const before = (await listProfiles())[0];
      const payload = exportPayload([{ ...before, answers: { Secret: 'x' } }]);
      const text = JSON.stringify(payload);
      await importProfiles(JSON.parse(text));
      const after = (await listProfiles())[0];
      return { exportedRows: payload.profiles[0].data.rows.length, exportedColumns: payload.profiles[0].data.columns.length, leaks: /Maria|Santos|northwind|Secret/.test(text), keptRows: after.data.rows.length, count: (await listProfiles()).length };
    });
    same('export has the column names but no rows, answers or people', [sharing.exportedRows, sharing.exportedColumns, sharing.leaks], [0, 14, false]);
    same('re-importing keeps the rows already on this PC', [sharing.keptRows, sharing.count], [5, 1]);
    await t.close();

    // ------------------------------------------------------------------
    section('10. Keyboard-shortcut fills ask on the page itself');
    t = await open('/leads/new');
    const profile = { id: 'p1', name: 'Shortcut', urlPattern: base + '/leads/new', fields: [
      { id: 'a', label: 'First name', selector: '#first', value: '{{ask:First name}}', enabled: true, frame: 'top' },
      { id: 'b', label: 'Company', selector: '#company', value: 'Acme', enabled: true, frame: 'top' }] };
    const start = () => t.panel.evaluate((tabId, profile) => {
      window.pending = (async () => {
        const { runProfile, askOnPage } = await import('../lib/runner.js');
        const report = await runProfile(tabId, profile, { ask: askOnPage(tabId) });
        return { outcome: report.outcome, filled: report.filled, missing: report.missing?.map((m) => m.label) };
      })();
    }, t.tabId, profile);
    await start();
    await t.site.bringToFront();
    await t.site.waitForSelector('#powerfill-ask');
    same('the question appears on the page', await t.site.$eval('#powerfill-ask', (host) => [...host.shadowRoot.querySelectorAll('label')].map((l) => l.textContent)), ['First name']);
    await t.site.screenshot({ path: path.join(SHOTS, '11-ask-on-page.png') });
    await t.site.keyboard.type('Noor');
    await t.site.keyboard.press('Enter');
    let outcome = await t.panel.evaluate(() => window.pending);
    same('answering fills the page', [outcome.outcome, outcome.filled, (await t.form()).first, (await t.form()).company], ['filled', 2, 'Noor', 'Acme']);
    same('the pre-save check runs here too', outcome.missing, ['Last name', 'Work email', 'Lead status']);
    same('the dialog is gone', await t.site.$('#powerfill-ask'), null);
    const undone = await t.panel.evaluate(async (tabId) => (await import('../lib/runner.js')).undoFill(tabId), t.tabId);
    same('undo restores both fields', [undone, (await t.form()).first, (await t.form()).company], [2, '', '']);
    await start();
    await t.site.bringToFront();
    await t.site.waitForSelector('#powerfill-ask');
    await t.site.keyboard.press('Escape');
    outcome = await t.panel.evaluate(() => window.pending);
    same('Esc cancels without filling', [outcome.outcome, (await t.form()).first], ['cancelled', '']);
    const commands = await (await worker.worker()).evaluate(async () => (await chrome.commands.getAll()).map((c) => c.name + '=' + c.shortcut));
    same('both shortcuts are registered with Chrome', commands.filter((c) => !c.startsWith('_')), ['fill-page=Alt+Shift+F', 'undo-fill=Alt+Shift+U']);
    await t.close();

    // ------------------------------------------------------------------
    section('11. Dropdown widgets, shadow DOM, iframes (and undo on them)');
    t = await open('/widgets.html');
    const live = await t.site.evaluate(() => window.hasSelect2);
    if (!live) console.log('  note  Select2 could not be loaded from its CDN; widget checks run against plain selects');
    await t.scan();
    await t.setValue('Lead Status', 'Lead Converted');
    await t.setValue('Products', ['Alpha', 'Gamma']);
    await t.setValue('Gender', 'f');
    await t.setValue('Interests', ['Security', 'AI']);
    await t.setValue('Notes', 'Hello rich text');
    await t.setValue('Shadow email', 's@shadow.example');
    await t.setValue('Agree to terms', 'true');
    await t.setValue('Country', 'Singapore');
    await t.setValue('React-like', 'react value');
    await t.setValue('Frame phone', '+65 1234');
    const widgets = () => t.site.evaluate(() => {
      const g = (s) => document.querySelector(s);
      return {
        status: g('[name=leadstatus]').value, shown: g('.select2-chosen')?.textContent ?? null, products: [...g('[name="prod[]"]').selectedOptions].map((o) => o.value).join(','),
        gender: g('[name=gender]:checked')?.value || '', interests: [...document.querySelectorAll('[name="int[]"]:checked')].map((e) => e.value).join(','), notes: g('#notes').textContent,
        shadow: g('#host').shadowRoot.querySelector('input').value, agree: g('#agree').getAttribute('aria-checked'), combo: g('#combo').textContent, react: window.reactChanged || '', honeypot: g('[name=website_hp]').value,
      };
    });
    const before = await widgets();
    rep = await t.fill();
    const after = await widgets();
    same('all ten fields filled', [rep.head, rep.problems], ['Filled 10 fields', []]);
    same('values reached the page', after, { status: 'Lead Converted', shown: live ? 'Lead Converted' : null, products: 'Alpha,Gamma', gender: 'f', interests: '1,3', notes: 'Hello rich text', shadow: 's@shadow.example', agree: 'true', combo: 'Singapore', react: 'react value', honeypot: '' });
    same('field inside the iframe', await t.site.frames()[1].evaluate(() => document.querySelector('input').value), '+65 1234');
    await t.click('Undo');
    await sleep(700);
    const restored = await widgets();
    // A custom dropdown can't be un-picked, and the React stand-in only reports changes, so those two are left out.
    const comparable = ({ combo, react, ...rest }) => rest;
    same('undo restores selects, the Select2 label, ticks, rich text, shadow DOM', comparable(restored), comparable(before));
    same('undo reaches into the iframe', await t.site.frames()[1].evaluate(() => document.querySelector('input').value), '');
    await t.close();

    // ------------------------------------------------------------------
    section('12. Layout options');
    t = await open('/leads/new', { width: 900, dark: true });
    await t.scan();
    await t.setValue('First name', 'Maria');
    await t.setValue('Lead status', 'Qualified');
    await t.insert('Company', 'Ask me each time');
    await t.shot('12-wide-dark');
    await t.panel.type('.filter', 'follow');
    same('filter narrows the sheet', await t.panel.$$eval('#rows .row[data-id]:not([hidden]) .label', (els) => els.map((e) => e.value)), ['Follow-up date']);
    await t.panel.evaluate(() => [...document.querySelectorAll('.toolbar .check input')].at(-1).click());
    await sleep(200);
    same('selectors can be hidden, and the choice is remembered', [await t.panel.$eval('#rows', (e) => e.classList.contains('no-selectors')), await t.panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.showSelectors)], [true, false]);
    await t.close();

    // ------------------------------------------------------------------
    section('13. Moving fields up and down');
    t = await open('/leads/new');
    await t.scan();
    const order = async () => (await t.rows()).map((x) => x.label).slice(0, 5);
    const rowScript = "const rowOf = (label) => [...document.querySelectorAll('#rows .row[data-id]')].find((x) => x.querySelector('.label').value === label);";
    // Presses a key on a row's handle and reports which row's handle has the focus afterwards.
    const gripKey = (label, key) => t.panel.evaluate(new Function('label', 'key', rowScript + `
      const grip = rowOf(label).querySelector('.grip');
      grip.focus();
      grip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      return document.activeElement.classList.contains('grip') ? document.activeElement.closest('.row').querySelector('.label').value : '';`), label, key);
    // Goes through the browser's drag-and-drop events for dragging one row onto another.
    const drag = (from, to, where) => t.panel.evaluate(new Function('from', 'to', 'where', rowScript + `
      const src = rowOf(from), dst = rowOf(to), data = new DataTransfer();
      const idle = src.draggable;
      src.querySelector('.grip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const armed = src.draggable;
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      const box = dst.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: where === 'after' ? box.bottom - 3 : box.top + 3, dataTransfer: data };
      dst.dispatchEvent(new DragEvent('dragover', at));
      const marked = (dst.className.match(/drop-[a-z]+/) || [''])[0];
      dst.dispatchEvent(new DragEvent('drop', at));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return { idle, armed, marked };`), from, to, where);
    same('Arrow Up on the handle moves the row up and keeps the handle focused', [await gripKey('Company', 'ArrowUp'), await order()], ['Company', ['First name', 'Company', 'Last name', 'Work email', 'Phone']]);
    await gripKey('Company', 'ArrowDown');
    await gripKey('Company', 'ArrowDown');
    same('Arrow Down moves it down', await order(), ['First name', 'Last name', 'Work email', 'Company', 'Phone']);
    same('the top row cannot go any higher', [await gripKey('First name', 'ArrowUp'), (await order())[0]], ['First name', 'First name']);
    same('a row can only be dragged by its handle, and shows where it will land', await drag('Phone', 'First name', 'before'), { idle: false, armed: true, marked: 'drop-before' });
    same('dropping moves the row there', await order(), ['Phone', 'First name', 'Last name', 'Work email', 'Company']);
    await drag('Phone', 'Company', 'after');
    same('dropping on the lower half puts it after', await order(), ['First name', 'Last name', 'Work email', 'Company', 'Phone']);
    same('dropping a row on itself changes nothing', [(await drag('Company', 'Company', 'after')).marked, await order()], ['', ['First name', 'Last name', 'Work email', 'Company', 'Phone']]);
    await t.panel.$eval('.name', (e) => { e.value = 'Reordered'; e.dispatchEvent(new Event('input')); });
    await t.click('Save');
    await sleep(300);
    same('the saved profile keeps the new order', await t.panel.evaluate(async () => (await chrome.storage.local.get('profiles')).profiles[0].fields.slice(0, 5).map((f) => f.label)), ['First name', 'Last name', 'Work email', 'Company', 'Phone']);
    await t.shot('13-reorder');

    // ------------------------------------------------------------------
    section('14. Searchable picklists and recent values');
    const openPicker = (label) => t.panel.evaluate(new Function('label', rowScript + `
      rowOf(label).querySelector('.value.picker').click();
      return document.querySelector('#picker').matches(':popover-open') ? document.activeElement.className : 'closed';`), label);
    const listed = () => t.panel.$$eval('#picker .picker-list > *', (els) => els.map((e) => (e.classList.contains('picker-head') ? '# ' : '') + e.textContent));
    const search = (text) => t.panel.$eval('#picker .picker-search', (s, text) => { s.value = text; s.dispatchEvent(new Event('input')); }, text);
    const press = (key) => t.panel.$eval('#picker .picker-search', (s, key) => { s.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }, key);
    const isOpen = () => t.panel.$eval('#picker', (p) => p.matches(':popover-open'));
    const clickItem = (text) => t.panel.evaluate((text) => [...document.querySelectorAll('#picker [role="option"]:not(.recent)')].find((o) => o.textContent.replace('✓', '') === text).click(), text);
    const shown = async (label) => (await t.row(label)).value;

    same('opening a picklist puts the cursor in its search box', await openPicker('Industry'), 'picker-search');
    same('the whole list is there, with "skip" first', await listed(), ['— skip —', 'Banking / Financial Services', 'Education', 'Healthcare', 'IT / Software', 'Manufacturing', 'Retail']);
    await search('heal');
    same('typing narrows the list', await listed(), ['Healthcare', 'Use “heal”']);
    await press('Enter');
    same('Enter takes the first match and closes the list', [await shown('Industry'), await isOpen()], ['Healthcare', false]);
    await sleep(250);
    await openPicker('Industry');
    same('the value just chosen is pinned under Recent', (await listed()).slice(0, 5), ['— skip —', '# Recent', 'Healthcare', '# All', 'Banking / Financial Services']);
    await clickItem('Retail');
    await sleep(250);
    await openPicker('Industry');
    same('newest recent first', (await listed()).slice(1, 4), ['# Recent', 'Retail', 'Healthcare']);
    await search('man');
    await press('ArrowDown');
    await press('ArrowUp');
    await press('Enter');
    same('arrow keys move through the matches', await shown('Industry'), 'Manufacturing');
    await sleep(250);
    await openPicker('Industry');
    await search('Aerospace');
    same('a value that is not on the list can still be used', await listed(), ['Use “Aerospace”']);
    await press('Enter');
    same('and it is kept as typed', await shown('Industry'), 'Aerospace');
    await sleep(250);
    await openPicker('Industry');
    await t.panel.bringToFront();
    await t.panel.keyboard.press('Escape');
    same('Esc closes the list and changes nothing', [await isOpen(), await shown('Industry')], [false, 'Aerospace']);
    await openPicker('Interested in');
    await clickItem('Security');
    await clickItem('AI');
    same('a multi-select stays open and ticks what is chosen', [await isOpen(), (await listed()).filter((x) => x.startsWith('✓'))], [true, ['✓Security', '✓AI']]);
    await search('net');
    same('its search works too', await listed(), ['Networking']);
    await t.shot('14-picker-multi');
    await t.panel.$eval('#picker', (p) => p.hidePopover());
    same('the choices show on the button', await shown('Interested in'), 'Security, AI');
    await t.setValue('Country', 'Singapore');
    same('recent values are stored per field of the site, newest first',
      await t.panel.evaluate(async (base) => { const r = (await chrome.storage.local.get('recents')).recents; return [r[base + '|#industry'], r[base + '|#country']]; }, base),
      [['Aerospace', 'Manufacturing', 'Retail', 'Healthcare'], ['Singapore']]);

    await sleep(250);
    await openPicker('Industry');
    await t.shot('14-picker-recents');
    await t.panel.$eval('#picker', (p) => p.hidePopover());
    await t.click('Save');
    await sleep(300);
    await t.click('‹ Profiles');
    await t.panel.waitForSelector('.profile');
    await t.scan();
    await openPicker('Industry');
    same('a new profile for the same site offers the same recents', (await listed()).slice(1, 6), ['# Recent', 'Aerospace', 'Manufacturing', 'Retail', 'Healthcare']);
    await t.panel.$eval('#picker', (p) => p.hidePopover());
    same('text boxes suggest what was typed in them before', await t.panel.evaluate(new Function(rowScript + `
      const input = rowOf('Country').querySelector('.value');
      return [...document.getElementById(input.getAttribute('list')).options].map((o) => o.value);`)), ['Singapore']);

    await t.insert('Lead status', 'Ask me each time');
    await t.panel.click('#fillBtn');
    await t.panel.waitForSelector('#ask[open]');
    same('a question about a picklist offers its options', await t.panel.$$eval('#ask datalist option', (os) => os.map((o) => o.value)), ['New', 'Call back - interested', 'Call back - busy', 'Qualified', 'Not interested']);
    await t.panel.type('#ask input', 'Qualified');
    await t.reportAfter(() => t.panel.click('#ask button.primary'));
    same('the answer is filled in', (await t.form()).status, 'Qualified');
    await t.panel.click('#fillBtn');
    await t.panel.waitForSelector('#ask[open]');
    same('next time that answer leads the suggestions', await t.panel.$$eval('#ask datalist option', (os) => os.map((o) => o.value).slice(0, 2)), ['Qualified', 'New']);
    await t.click('Cancel');

    await t.panel.click('.tab:nth-child(2)');
    await t.panel.$eval('.paste', (el, text) => { el.value = text; }, GOOD);
    await t.click('Use these rows');
    await t.panel.waitForSelector('.sheet');
    await t.panel.$eval('.fold', (d) => { d.open = true; });
    await t.panel.$eval('.match .picker', (b) => b.click());
    await search('zzz');
    same('column matching is searchable, and only offers real fields', await listed(), ['Nothing matches']);
    await search('email');
    same('searching the fields', await listed(), ['Work email', 'Opted in to email updates']);
    await t.panel.$eval('#picker', (p) => p.hidePopover());
    await t.close();

    // ------------------------------------------------------------------
    section('15. Scrolling scan: fields that only appear further down');
    t = await open('/long.html');
    const labels = async () => (await t.rows()).map((x) => x.label);
    const scrollY = () => t.site.evaluate(() => Math.round(scrollY));
    await t.scan();
    same('an ordinary scan sees only what the page has loaded so far', await labels(), ['Top name', 'Top email', 'Pane first']);
    await t.click('‹ Profiles');
    await sleep(100);
    await t.click('Discard changes?');
    await t.panel.waitForSelector('button.big');

    const tickScroll = () => t.panel.evaluate(() => { const box = [...document.querySelectorAll('.scan .check')].find((l) => /Scroll the page/.test(l.textContent)).querySelector('input'); if (!box.checked) box.click(); });
    // The page has to be the visible tab, as it is in real use, or the browser pauses its animations.
    const startScan = async () => { await t.site.bringToFront(); await t.panel.evaluate(() => document.querySelector('button.big').click()); };
    await tickScroll();
    await t.site.evaluate(() => scrollTo(0, 250));
    await startScan();
    await t.site.waitForSelector('#powerfill-scanning');
    same('while it scrolls, the page says so and the panel offers Stop', [await t.site.$eval('#powerfill-scanning', (b) => /Press Esc or click anywhere to stop/.test(b.textContent)), await t.panel.$eval('button.big', (b) => b.textContent)], [true, 'Stop scanning']);
    await t.panel.waitForSelector('#rows .row[data-id]', { timeout: 30000 });
    same('everything is found, in page order', await labels(), ['Top name', 'Top email', 'Pane first', 'Pane last', 'Revealed city', 'Revealed plan', 'Lazy phone', 'Lazy notes']);
    same('the page is put back where it was, and the notice is gone', [await scrollY(), await t.site.$('#powerfill-scanning'), await t.site.$eval('#pane', (p) => p.scrollTop)], [250, null, 0]);
    check('the summary does not claim it was cut short', /^Found 8 fields\. Type the values/.test(await t.toast()), await t.toast());
    same('the choice is remembered', await t.panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.scrollScan), true);
    await t.close();

    t = await open('/long.html?endless', { wipe: false });
    // Runs a scrolling scan through the same code the panel uses and reports how it ended.
    const scanInBackground = () => t.panel.evaluate((tabId) => {
      window.pending = (async () => {
        const started = Date.now();
        const { fields, stopped } = await (await import('../lib/runner.js')).scanPage(tabId, { scroll: true });
        return { stopped, fields: fields.length, seconds: Math.round((Date.now() - started) / 100) / 10 };
      })();
    }, t.tabId);
    const outcome2 = () => t.panel.evaluate(() => window.pending);
    await t.site.bringToFront();
    await scanInBackground();
    let scanResult = await outcome2();
    check('a page that keeps growing is given up on, well inside the time limit', scanResult.stopped === 'endless' && scanResult.seconds < 18 && scanResult.fields > 8, scanResult);
    same('and the page is put back at the top', await scrollY(), 0);

    await scanInBackground();
    await t.site.waitForSelector('#powerfill-scanning');
    await sleep(500);
    await t.site.mouse.move(400, 300);
    await t.site.mouse.wheel({ deltaY: 120 });
    scanResult = await outcome2();
    same('touching the mouse wheel hands the page straight back', scanResult.stopped, 'user');
    check('it stays where the person left it instead of jumping back', (await scrollY()) > 0, await scrollY());
    check('what was found so far is kept', scanResult.fields >= 3, scanResult);

    await t.site.evaluate(() => scrollTo(0, 0));
    await scanInBackground();
    await t.site.waitForSelector('#powerfill-scanning');
    await sleep(400);
    await t.site.keyboard.press('Escape');
    same('so does Esc', (await outcome2()).stopped, 'user');

    await t.site.evaluate(() => scrollTo(0, 0));
    await t.site.mouse.click(5, 5);
    await scanInBackground();
    await t.site.waitForSelector('#powerfill-scanning');
    await sleep(400);
    await t.site.mouse.click(600, 400);
    same('and a click', (await outcome2()).stopped, 'user');

    await t.site.evaluate(() => scrollTo(0, 120));
    await startScan();
    await t.panel.waitForSelector('button.stop');
    await sleep(600);
    await t.panel.evaluate(() => document.querySelector('button.stop').click());
    await t.panel.waitForSelector('#rows .row[data-id]', { timeout: 30000 });
    check('Stop in the panel ends it and says the scan was cut short', /The scroll was stopped early/.test(await t.toast()), await t.toast());
    same('after Stop the page goes back to where it was', await scrollY(), 120);
    same('nothing on the page was changed by any of this', await t.site.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((i) => i.value).length), 0);
    await t.close();

    // ------------------------------------------------------------------
    section('16. Every screen, from the narrowest panel to the widest');
    t = await open('/leads/new');
    await t.panel.evaluate(async (base) => {
      const field = (id, label, selector, extra = {}) => ({ id, label, selector, kind: 'text', value: 'x', enabled: true, frame: 'top', ...extra });
      const long = 'Quarterly enterprise lead intake for the Asia Pacific regional marketing team';
      await chrome.storage.local.set({ profiles: [
        { id: 'here', name: long, urlPattern: base + '/leads/new', fields: [field('a', 'First name', '#first'), field('b', 'A field whose label is much longer than usual labels tend to be', '#company', { required: true }),
          field('c', 'Industry', '#industry', { kind: 'select', value: 'Banking / Financial Services', options: [{ value: 'Banking / Financial Services', text: 'Banking / Financial Services' }] })],
          data: { columns: ['First name', 'A column with a very long heading indeed'], rows: [['Maximiliana-Alexandrina', 'A very long cell value that goes on and on without stopping']], cursor: 0 } },
        { id: 'other', name: 'Leads v2', urlPattern: 'https://crm.example.com/a-very-long-application-path/index.php?module=Leads&view=Edit&app=MARKETING&more=parameters', fields: [field('d', 'First name', '#first')] },
      ] });
    }, base);
    await t.panel.reload();
    await t.panel.waitForSelector('.profile');
    // Anything sticking out past the panel's edge, apart from the data table, which scrolls on purpose.
    const spill = () => t.panel.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.sheet-wrap, datalist, select') || el.tagName === 'SCRIPT') continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height && (r.right > innerWidth + 1 || r.left < -1)) out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
      }
      return { sideways: document.documentElement.scrollWidth - innerWidth, out: out.slice(0, 4) };
    });
    const fits = { sideways: 0, out: [] };
    const widths = [300, 340, 420, 680, 1000, 1400];
    for (const width of widths) {
      await t.panel.setViewport({ width, height: 800 });
      await sleep(120);
      await t.panel.$eval('.others', (d) => { d.open = true; });
      const buttons = await t.panel.$$eval('.profile-head button', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return r.width > 30 && r.left >= 0 && r.right <= innerWidth; }));
      same(`home at ${width}px: nothing spills, both Fill buttons are on screen`, [await spill(), buttons], [fits, [true, true]]);
      if (width === 300 || width === 1400) await t.shot('16-home-' + width);
    }
    await t.panel.setViewport({ width: 300, height: 800 });
    await sleep(120);
    same('at 300px long addresses are cut short with an ellipsis rather than pushing the card wider', await t.panel.$$eval('.meta', (ms) => ms.map((m) => m.scrollWidth > m.clientWidth)), [true, true]);
    await t.panel.evaluate(() => document.querySelector('.profile .links .link').click());
    await t.panel.waitForSelector('#rows .row[data-id]');
    for (const width of widths) {
      await t.panel.setViewport({ width, height: 800 });
      await sleep(120);
      same(`field sheet at ${width}px`, await spill(), fits);
    }
    await t.panel.setViewport({ width: 300, height: 800 });
    await sleep(120);
    await t.shot('16-sheet-300');
    await t.panel.$eval('.value.picker', (b) => b.click());
    same('an open picklist stays inside a 300px panel', await t.panel.$eval('#picker', (p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
    await t.panel.$eval('#picker', (p) => p.hidePopover());
    await t.panel.click('.tab:nth-child(2)');
    for (const width of widths) {
      await t.panel.setViewport({ width, height: 800 });
      await sleep(120);
      same(`data rows at ${width}px`, await spill(), fits);
    }
    await t.panel.setViewport({ width: 300, height: 800 });
    await t.panel.click('#detailsBtn');
    await t.panel.waitForSelector('.var');
    for (const width of [300, 1400]) {
      await t.panel.setViewport({ width, height: 800 });
      await sleep(120);
      same(`My details at ${width}px`, await spill(), fits);
    }
    await t.close();
  } finally {
    await browser.close();
    server.close();
  }

  section('Result');
  if (errors.length) { failures.push('errors in the panel'); console.log('  FAIL  the panel logged errors:\n        ' + errors.join('\n        ')); }
  console.log(`  ${passed} passed, ${failures.length} failed` + (failures.length ? ':\n    - ' + failures.join('\n    - ') : ''));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
