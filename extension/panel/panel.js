import { listProfiles, saveProfile, deleteProfile, markUsed, importProfiles, exportPayload, newId } from '../lib/store.js';
import { suggestPattern, matchesUrl } from '../lib/url.js';
import { callTab, scanTab, fillTab, hasValue } from '../lib/runner.js';
import { normalizeLocator } from '../lib/locator.js';

const $ = (selector) => document.querySelector(selector);
const home = $('#home');
const editor = $('#editor');

const state = {
  tab: null,
  profiles: [],
  draft: null,       // the profile open in the editor
  dirty: false,
  results: {},       // last fill result per field id, shown on the rows
  lastRun: null,     // last fill summary, shown on the profile card
  picking: null,     // id of the row waiting for a click on the page
  includeHidden: false,
  filter: '',
};

// ---------- small helpers ----------

// Children may be nodes, strings, arrays of those, or null / false for "nothing here".
const kids = (children) => children.flat().filter((c) => c != null && c !== false);

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids(children));
  return el;
}

const mount = (parent, ...children) => parent.replaceChildren(...kids(children));

const ICONS = {
  pick: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  show: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  remove: '<path d="M4 4l8 8M12 4l-8 8"/>',
};

function iconButton(name, title, onclick) {
  const button = h('button', { className: 'icon', title, onclick });
  button.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return button;
}

const asText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let toastTimer;
function toast(text, bad = false, sticky = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Wraps a click handler so failures (restricted page, bad file...) show up as a message.
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e?.message || String(e), true); }
};

// Destructive buttons ask once: the first click arms them, a second click within 3s confirms.
function confirmClick(button, question, action, needed = () => true) {
  const label = button.textContent;
  button.onclick = () => {
    if (button.dataset.armed || !needed()) return action();
    button.dataset.armed = '1';
    button.textContent = question;
    button.classList.add('danger');
    setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = label;
      button.classList.remove('danger');
    }, 3000);
  };
  return button;
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const summarize = (filled, failed) => (filled + failed === 0
  ? 'Nothing to fill: no values are set.'
  : `Filled ${plural(filled, 'field')}` + (failed ? `, ${failed} could not be filled` : ''));

// ---------- current tab ----------

// panel.html?tabId=123 binds the panel to one tab, so it can also be opened as an ordinary page.
const boundTab = Number(new URLSearchParams(location.search).get('tabId'));
const canRun = (tab) => /^(https?|file):/.test(tab?.url || '');

async function currentTab() {
  state.tab = boundTab ? await chrome.tabs.get(boundTab) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return state.tab;
}

async function syncTab() {
  const before = state.tab?.url;
  const tab = await currentTab().catch(() => null);
  $('#page').textContent = tab?.title || '';
  if (tab?.url !== before) state.lastRun = null;
  if (!home.hidden) renderHome();
}

// ---------- home: scan + profile list ----------

async function showHome() {
  state.draft = null;
  editor.hidden = true;
  home.hidden = false;
  state.profiles = await listProfiles();
  await syncTab();
}

function renderHome() {
  const { tab, profiles } = state;
  const usable = canRun(tab);
  const here = profiles.filter((p) => usable && matchesUrl(p.urlPattern, tab.url));
  const others = profiles.filter((p) => !here.includes(p));
  const hidden = h('input', { type: 'checkbox', checked: state.includeHidden, onchange: () => { state.includeHidden = hidden.checked; } });

  mount(home,
    h('section', { className: 'card scan' },
      h('button', { className: 'primary big', textContent: 'Scan this page', disabled: !usable, onclick: guard(startScan) }),
      usable
        ? h('label', { className: 'check' }, hidden, ' Include hidden fields')
        : h('p', { className: 'muted', textContent: 'PowerFill can’t run on this kind of page. Open the form you want to fill.' })),
    h('h2', { textContent: 'Profiles for this page' }),
    here.length ? here.map(profileCard) : h('p', { className: 'muted', textContent: 'None yet. Scan the page to create one.' }),
    others.length ? h('details', { className: 'others' }, h('summary', { textContent: `Other profiles (${others.length})` }), others.map(profileCard)) : null,
    h('footer', { className: 'links' },
      h('button', { className: 'link', textContent: 'Import profiles', onclick: () => $('#importFile').click() }),
      profiles.length ? h('button', { className: 'link', textContent: 'Export all', onclick: () => download('powerfill-profiles.json', exportPayload(profiles)) }) : null),
  );
}

function profileCard(p) {
  const count = p.fields.filter((f) => f.enabled !== false && hasValue(f.value)).length;
  const run = state.lastRun?.id === p.id ? state.lastRun : null;
  const copy = () => openEditor({ ...p, id: newId(), name: p.name + ' (copy)', fields: p.fields.map((f) => ({ ...f, id: newId() })) }, true);
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  return h('article', { className: 'card profile' },
    h('div', { className: 'profile-head' },
      h('div', { className: 'profile-name', textContent: p.name }),
      h('button', { className: 'primary', textContent: 'Fill', onclick: guard(() => runProfile(p)) })),
    h('div', { className: 'meta', textContent: `${plural(count, 'value')} · ${p.urlPattern.replace(/^https?:\/\//, '')}`, title: p.urlPattern }),
    run ? h('div', { className: 'run ' + (run.failed ? 'bad' : 'ok'), textContent: run.text }) : null,
    h('div', { className: 'links' },
      h('button', { className: 'link', textContent: 'Edit', onclick: () => openEditor(p, false) }),
      h('button', { className: 'link', textContent: 'Duplicate', onclick: copy }),
      h('button', { className: 'link', textContent: 'Export', onclick: () => download(`powerfill-${slug}.json`, exportPayload([p])) }),
      confirmClick(h('button', { className: 'link', textContent: 'Delete' }), 'Really delete?', guard(async () => {
        await deleteProfile(p.id);
        await showHome();
      }))));
}

async function runProfile(p) {
  const tab = await currentTab();
  const { results, filled, failed } = await fillTab(tab.id, p.fields);
  await markUsed(p.id);
  const missed = p.fields.filter((f) => results[f.id] && results[f.id].status !== 'filled').map((f) => f.label || f.selector);
  state.lastRun = { id: p.id, failed, text: summarize(filled, failed) + (missed.length ? ': ' + missed.join(', ') : '') };
  renderHome();
}

const toRow = ({ current, ...scanned }) => ({ ...scanned, id: newId(), value: '', enabled: true });

async function startScan() {
  const tab = await currentTab();
  const fields = await scanTab(tab.id, { includeHidden: state.includeHidden });
  openEditor({ id: newId(), name: (tab.title || 'New profile').slice(0, 60), urlPattern: suggestPattern(tab.url), fields: fields.map(toRow) }, true);
  toast(fields.length ? `Found ${plural(fields.length, 'field')}. Type the values to fill, then Save.` : 'No fields found. Add rows by hand or use “Pick field”.', !fields.length);
}

$('#importFile').onchange = guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('That file is not a PowerFill export.'); }
  const count = await importProfiles(data);
  await showHome();
  toast(`Imported ${plural(count, 'profile')}.`);
});

// ---------- editor: the field sheet ----------

function openEditor(profile, isNew) {
  state.draft = structuredClone(profile);
  state.dirty = isNew;
  state.results = {};
  state.filter = '';
  home.hidden = true;
  editor.hidden = false;
  renderEditor();
}

function touch() {
  state.dirty = true;
  const status = $('#status');
  if (status) status.textContent = 'Unsaved changes';
}

function renderEditor() {
  const d = state.draft;
  const name = h('input', { className: 'name', value: d.name, placeholder: 'Profile name', oninput: () => { d.name = name.value; touch(); } });
  const pattern = h('input', {
    className: 'mono', value: d.urlPattern, spellcheck: false, placeholder: 'https://site.com/form*',
    title: 'Pages this profile is offered on. * matches anything; query parameters listed here must be present on the page.',
    oninput: () => { d.urlPattern = pattern.value.trim(); touch(); },
  });
  const filter = h('input', {
    className: 'filter', type: 'search', placeholder: 'Filter fields…',
    oninput: () => { state.filter = filter.value.toLowerCase(); applyFilter(); },
  });
  const back = confirmClick(h('button', { className: 'link', textContent: '‹ Profiles' }), 'Discard changes?', guard(showHome), () => state.dirty);

  mount(editor,
    h('div', { className: 'editor-head' },
      back,
      h('label', { className: 'stack' }, h('span', { textContent: 'Profile name' }), name),
      h('label', { className: 'stack' }, h('span', { textContent: 'Use on pages matching' }), pattern),
      h('div', { className: 'toolbar' },
        h('button', { textContent: 'Rescan', title: 'Add fields that have appeared on the page since the last scan', onclick: guard(rescan) }),
        h('button', { textContent: 'Grab page values', title: 'Copy what is currently entered in the page’s form into this sheet', onclick: guard(grabValues) }),
        h('button', { textContent: '+ Row', title: 'Add an empty row and paste a selector into it', onclick: () => addRow(false) }),
        h('button', { textContent: 'Pick field', title: 'Add a row by clicking a field on the page', onclick: guard(() => addRow(true)) }),
        filter)),
    h('div', { id: 'rows' }),
    h('p', { className: 'muted hint', textContent: 'Blank value = leave the field alone. {{clear}} empties it. {{today}} or {{today+7}} inserts a date.' }),
    h('div', { className: 'actions' },
      h('button', { className: 'primary', textContent: 'Fill page', title: 'Fill the page with these values now (no need to save first)', onclick: guard(fillNow) }),
      h('button', { textContent: 'Save profile', onclick: guard(save) }),
      h('span', { id: 'status', className: 'muted', textContent: state.dirty ? 'Unsaved changes' : '' })),
  );
  renderRows();
}

function renderRows() {
  const fields = state.draft.fields;
  mount($('#rows'),
    h('div', { className: 'row head' },
      h('span', { className: 'on' }), h('span', { className: 'label', textContent: 'Label' }),
      h('span', { className: 'selector', textContent: 'Selector' }), h('span', { className: 'value', textContent: 'Value to fill' }),
      h('span', { className: 'tools' })),
    fields.length ? fields.map(rowEl) : h('p', { className: 'muted', textContent: 'No rows yet.' }));
  applyFilter();
}

function applyFilter() {
  for (const row of document.querySelectorAll('#rows .row[data-id]')) {
    const f = state.draft.fields.find((x) => x.id === row.dataset.id);
    row.hidden = !!state.filter && !`${f.label} ${f.selector} ${asText(f.value)}`.toLowerCase().includes(state.filter);
  }
}

const EXPLAIN = { notfound: 'Not found on this page. Check the selector.', otherframe: 'Not found on this page. Check the selector.' };

function rowEl(f) {
  const result = state.results[f.id];
  const row = h('div', { className: 'row' });
  row.dataset.id = f.id;
  if (result) row.classList.add(result.status === 'filled' ? 'ok' : 'bad');
  row.classList.toggle('off', f.enabled === false);

  const on = h('input', {
    className: 'on', type: 'checkbox', checked: f.enabled !== false, title: 'Fill this field',
    onchange: () => { f.enabled = on.checked; row.classList.toggle('off', !on.checked); touch(); },
  });
  const label = h('input', {
    className: 'label' + (f.required ? ' required' : ''), value: f.label || '', placeholder: 'Label',
    title: f.required ? 'Required on the page' : '', oninput: () => { f.label = label.value; touch(); },
  });
  // Pasting from DevTools (Copy selector / JS path / XPath / outerHTML) is tidied up, then the row
  // re-reads the element so a dropdown gets its list of options.
  const tidy = guard(async () => {
    selector.value = f.selector = normalizeLocator(selector.value);
    if (f.selector) await inspect(f, true);
  });
  const selector = h('input', {
    className: 'selector mono', value: f.selector || '', spellcheck: false, placeholder: 'CSS selector, XPath, id or name',
    oninput: () => { f.selector = selector.value; f.frame = 'any'; touch(); }, onchange: tidy,
  });
  const tools = h('div', { className: 'tools' },
    iconButton('pick', 'Pick this field by clicking it on the page', guard(() => pick(f))),
    iconButton('show', 'Show this field on the page', guard(() => inspect(f, false))),
    iconButton('remove', 'Remove this row', () => {
      state.draft.fields = state.draft.fields.filter((x) => x !== f);
      row.remove();
      touch();
    }));

  row.append(on, label, selector, valueEl(f), tools);
  if (result && result.status !== 'filled') row.append(h('div', { className: 'msg', textContent: result.detail || EXPLAIN[result.status] }));
  return row;
}

function selectEl(pairs, value, onset) {
  const current = asText(value);
  const known = pairs.some(([v]) => v === current);
  const el = h('select', { className: 'value', onchange: () => onset(el.value) },
    (known ? pairs : [...pairs, [current, current]]).map(([v, text]) => h('option', { value: v, textContent: text })));
  el.value = current;
  return el;
}

function multiEl(f, onset) {
  const chosen = new Set(Array.isArray(f.value) ? f.value : hasValue(f.value) ? [String(f.value)] : []);
  const summary = h('summary');
  const paint = () => {
    summary.textContent = f.options.filter((o) => chosen.has(o.value)).map((o) => o.text).join(', ') || '— skip —';
  };
  paint();
  return h('details', { className: 'value multi' }, summary, f.options.map((o) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(o.value), onchange: () => {
      if (box.checked) chosen.add(o.value); else chosen.delete(o.value);
      onset([...chosen]);
      paint();
    } });
    return h('label', {}, box, ' ' + o.text);
  }));
}

// The value cell matches the field: a dropdown for picklists and radios, a checklist for
// multi-selects, check / uncheck for a checkbox, otherwise a text box.
function valueEl(f) {
  const onset = (v) => { f.value = v; touch(); };
  const skip = ['', '— skip —'];
  if (f.kind === 'check') return selectEl([skip, ['true', '☑ Check'], ['false', '☐ Uncheck']], f.value, onset);
  if (f.options?.length && f.kind === 'multi') return multiEl(f, onset);
  if (f.options?.length && (f.kind === 'select' || f.kind === 'radio')) return selectEl([skip, ...f.options.map((o) => [o.value, o.text])], f.value, onset);
  const el = h(f.multiline ? 'textarea' : 'input', { className: 'value', value: asText(f.value), placeholder: 'Value', oninput: () => onset(el.value) });
  if (f.multiline) el.rows = 2; else el.type = f.inputType === 'password' ? 'password' : 'text';
  return el;
}

// Takes on what the page says about the element behind a row, keeping the user's label and value.
function adopt(f, scanned) {
  if (!f.label) f.label = scanned.label;
  const { kind, options, inputType, multiline, required, frame } = scanned;
  Object.assign(f, { kind, options, inputType, multiline, required, frame });
}

// Redraws one row, keeping the keyboard focus where it was (the user may be tabbing through it).
function replaceRow(f) {
  const old = document.querySelector(`#rows .row[data-id="${f.id}"]`);
  if (!old) return;
  const focused = old.contains(document.activeElement) ? document.activeElement.classList[0] : null;
  const fresh = rowEl(f);
  old.replaceWith(fresh);
  if (focused) fresh.querySelector('.' + focused)?.focus();
}

async function inspect(f, quiet) {
  const tab = await currentTab();
  const hit = (await callTab(tab.id, 'highlight', { selector: f.selector, quiet })).find((r) => r.count);
  if (!hit) return quiet ? null : toast('Nothing on the page matches this selector.', true);
  if (hit.field) {
    const shape = JSON.stringify([f.label, f.kind, f.options]);
    adopt(f, hit.field);
    if (shape !== JSON.stringify([f.label, f.kind, f.options])) replaceRow(f);
  }
  if (!quiet) toast(hit.field ? 'Highlighted on the page.' : 'Found, but that element is not a form field.', !hit.field);
}

function addRow(thenPick) {
  const f = { id: newId(), label: '', selector: '', kind: 'text', value: '', enabled: true, frame: 'any' };
  state.draft.fields.push(f);
  state.filter = '';
  $('.filter').value = '';
  touch();
  renderRows();
  const row = document.querySelector(`#rows .row[data-id="${f.id}"]`);
  row.scrollIntoView({ block: 'center' });
  if (thenPick) return pick(f);
  row.querySelector('.selector').focus();
}

async function pick(f) {
  if (state.picking) return endPick();
  const tab = await currentTab();
  await callTab(tab.id, 'startPicker');
  state.picking = f.id;
  toast('Click the field on the page. Press Esc to cancel.', false, true);
}

async function endPick() {
  state.picking = null;
  $('#toast').hidden = true;
  if (state.tab) await callTab(state.tab.id, 'stopPicker').catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!state.picking || sender.tab?.id !== state.tab?.id) return;
  if (msg?.type === 'pf-picked') {
    const f = state.draft?.fields.find((x) => x.id === state.picking);
    if (f) {
      f.selector = msg.field.selector;
      adopt(f, msg.field);
      touch();
      replaceRow(f);
    }
    endPick();
  } else if (msg?.type === 'pf-pick-cancel') {
    endPick();
  }
});

async function rescan() {
  const tab = await currentTab();
  const scanned = await scanTab(tab.id, { includeHidden: state.includeHidden });
  let added = 0;
  for (const s of scanned) {
    const existing = state.draft.fields.find((f) => f.selector === s.selector);
    if (existing) adopt(existing, s);
    else { state.draft.fields.push(toRow(s)); added++; }
  }
  if (added) touch();
  renderRows();
  toast(added ? `Added ${plural(added, 'new field')}.` : 'No new fields on the page.');
}

async function grabValues() {
  const tab = await currentTab();
  const scanned = await scanTab(tab.id, { includeHidden: true });
  let grabbed = 0;
  for (const f of state.draft.fields) {
    const s = scanned.find((x) => x.selector === f.selector);
    if (!s || !hasValue(s.current)) continue;
    f.value = s.current;
    grabbed++;
  }
  if (grabbed) touch();
  renderRows();
  toast(grabbed ? `Copied ${plural(grabbed, 'value')} from the page.` : 'The page’s fields are all empty.');
}

async function fillNow() {
  const tab = await currentTab();
  const { results, filled, failed } = await fillTab(tab.id, state.draft.fields);
  state.results = results;
  renderRows();
  toast(summarize(filled, failed), failed > 0);
}

async function save() {
  const d = state.draft;
  d.name = d.name.trim();
  if (!d.name) return toast('Give the profile a name first.', true);
  d.updatedAt = Date.now();
  await saveProfile(d);
  state.dirty = false;
  $('#status').textContent = 'Saved';
  toast('Profile saved.');
}

// ---------- wiring ----------

chrome.tabs.onActivated.addListener(() => syncTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tab?.id && (info.url || info.title || info.status === 'complete')) syncTab();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) endPick();
});

showHome();
