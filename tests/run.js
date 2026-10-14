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
          control: v.tagName === 'DETAILS' ? 'checklist' : v.tagName === 'SELECT' ? 'dropdown' : v.classList.contains('template') ? 'template' : v.tagName === 'TEXTAREA' ? 'textarea' : v.type,
          value: v.tagName === 'DETAILS' ? v.querySelector('summary').textContent : v.value,
          required: !!r.querySelector('.req'), tone: ['ok', 'warn', 'bad'].find((c) => r.classList.contains(c)) || '', msg: r.querySelector('.msg')?.textContent || '',
        };
      }));
      const row = async (label) => (await rows()).find((r) => r.label === label);
      // Types a value into a row's value cell. An array ticks those entries of a checklist.
      const setValue = (label, value) => panel.evaluate((label, value) => {
        const r = [...document.querySelectorAll('#rows .row[data-id]')].find((x) => x.querySelector('.label').value === label);
        if (!r) throw new Error('no row "' + label + '"');
        const v = r.querySelector('.value');
        if (v.tagName === 'DETAILS') {
          for (const l of v.querySelectorAll('label')) { const box = l.querySelector('input'); if (box.checked !== value.includes(l.textContent.trim())) box.click(); }
          return;
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
    same('every column is matched to its field', await t.panel.$$eval('.match select', (els) => els.filter((e) => e.value).length), 14);
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
    same('selectors can be hidden, and the choice is remembered', [await t.panel.$eval('#rows', (e) => e.classList.contains('no-selectors')), await t.panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings)], [true, { showSelectors: false }]);
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
