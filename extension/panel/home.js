// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Home view: scan the page, and the list of profiles with their Fill buttons.

import { $, h, mount, icon, iconButton, toast, guard, confirmClick, download, plural } from './dom.js';
import { state, nav, canRun, currentTab } from './state.js';
import { reportEl } from './report.js';
import { askInPanel } from './ask.js';
import { toRow, scanNote } from './editor.js';
import { listProfiles, deleteProfile, patchProfile, importProfiles, exportPayload, newId, saveSettings } from '../lib/store.js';
import { suggestPattern, matchesUrl } from '../lib/url.js';
import { callTab, scanPage, runProfile, undoFill, hasValue } from '../lib/runner.js';
import { columnsIn } from '../lib/template.js';

const view = () => $('#view');
const activeFields = (p) => p.fields.filter((f) => f.enabled !== false && hasValue(f.value));
// A profile only steps through its data rows if some field actually takes a value from them.
const rowsOf = (p) => (p.data?.rows.length && columnsIn(activeFields(p)).length ? p.data : null);

async function showHome({ reload = true } = {}) {
  state.view = 'home';
  view().dataset.view = 'home';
  state.draft = null;
  if (reload) {
    state.profiles = await listProfiles();
    await currentTab().catch(() => null);
  }
  renderHome();
}

nav.home = showHome;

function renderHome() {
  const { tab, profiles } = state;
  const usable = canRun(tab);
  const here = profiles.filter((p) => usable && matchesUrl(p.urlPattern, tab.url));
  const others = profiles.filter((p) => !here.includes(p));
  const hidden = h('input', { type: 'checkbox', checked: state.includeHidden, onchange: () => { state.includeHidden = hidden.checked; } });
  const scroll = h('input', { type: 'checkbox', checked: state.settings.scrollScan, onchange: () => {
    state.settings.scrollScan = scroll.checked;
    saveSettings(state.settings);
  } });

  mount(view(),
    h('section', { className: 'card scan' },
      h('div', { className: 'pagebar', title: tab?.url || '' },
        h('span', { className: 'dot' + (usable ? ' on' : '') }),
        h('span', { className: 'pagetitle', textContent: tab?.title || 'No page' })),
      state.scanning
        ? h('button', { className: 'big stop', onclick: guard(() => callTab(state.tab.id, 'stopScan')) }, icon('stop', 14), 'Stop scanning')
        : h('button', { className: 'primary big', disabled: !usable, onclick: guard(startScan) }, icon('scan', 16), 'Scan this page'),
      state.scanning ? h('p', { className: 'muted', textContent: 'Scrolling the page to find every field. It only scrolls, and stops the moment you click or type on the page.' }) : null,
      usable
        ? [h('label', { className: 'check' }, hidden, 'Include hidden fields'),
          h('label', { className: 'check', title: 'Scrolls the page from top to bottom first, so fields that only load or appear further down are found too. It only scrolls, stops when you touch the page, and puts the page back where it was.' },
            scroll, 'Scroll the page to find every field')]
        : h('p', { className: 'muted', textContent: 'PowerFill can’t work on this kind of page. Open the form you want to fill.' })),

    h('h2', {}, 'Profiles for this page', here.length ? h('span', { className: 'count', textContent: here.length }) : null),
    here.length ? here.map(profileCard) : h('div', { className: 'empty' },
      h('strong', { textContent: 'No profile for this page yet' }),
      h('span', { textContent: 'Scan the page, type the values you want, and save. After that it is one click.' })),
    others.length ? otherProfiles(others) : null,

    h('footer', { className: 'foot' },
      h('div', { className: 'links' },
        h('button', { className: 'link', textContent: 'Import profiles', onclick: () => $('#importFile').click() }),
        profiles.length ? h('button', { className: 'link', textContent: 'Export all', onclick: () => download('powerfill-profiles.json', exportPayload(profiles)) }) : null),
      h('div', { className: 'credit' }, `PowerFill ${chrome.runtime.getManifest().version} · © 2026 `,
        h('a', { href: 'https://github.com/ChimCatz/PowerFill', target: '_blank', rel: 'noopener', textContent: 'ChimCatz' }))));
}

// Profiles saved for other pages. The list stays open once opened, and while one of its
// profiles has a fill report to show, so a fill started from here does not hide its own result.
function otherProfiles(others) {
  const box = h('details', { className: 'others', open: state.othersOpen || others.some((p) => state.runs[p.id]) },
    h('summary', { textContent: `Other profiles (${others.length})` }), others.map(profileCard));
  box.ontoggle = () => { state.othersOpen = box.open; };
  return box;
}

// Where a data-row profile has got to, with buttons to step back or skip ahead.
function rowBar(p, data) {
  const total = data.rows.length;
  const cursor = Math.min(data.cursor || 0, total);
  const move = (to) => guard(async () => {
    await patchProfile(p.id, (stored) => { stored.data.cursor = to; });
    delete state.runs[p.id];
    await showHome();
  });
  const preview = data.rows[cursor]?.find(Boolean);
  return h('div', { className: 'rowbar' },
    iconButton('prev', 'Go back one row', move(cursor - 1), { disabled: cursor === 0 }),
    h('div', { className: 'rowinfo' },
      h('div', { className: 'progress' }, h('div', { style: `width:${(cursor / total) * 100}%` })),
      h('span', { textContent: cursor >= total ? `All ${total} rows done` : `Next: row ${cursor + 1} of ${total}` + (preview ? ` · ${preview}` : '') })),
    iconButton('next', 'Skip this row', move(cursor + 1), { disabled: cursor >= total }));
}

function profileCard(p) {
  const data = rowsOf(p);
  const finished = data && (data.cursor || 0) >= data.rows.length;
  const count = activeFields(p).length;
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  const copy = () => nav.editor({ ...structuredClone(p), id: newId(), name: p.name + ' (copy)', fields: p.fields.map((f) => ({ ...f, id: newId() })) }, true);
  const restart = guard(async () => {
    await patchProfile(p.id, (stored) => { stored.data.cursor = 0; });
    delete state.runs[p.id];
    await showHome();
  });

  return h('article', { className: 'card profile' },
    h('div', { className: 'profile-head' },
      h('div', { className: 'profile-text' },
        h('div', { className: 'profile-name', textContent: p.name }),
        h('div', { className: 'meta', title: p.urlPattern, textContent: `${plural(count, 'value')} · ${p.urlPattern.replace(/^https?:\/\//, '')}` })),
      finished
        ? h('button', { textContent: 'Start over', title: 'Go back to the first data row', onclick: restart })
        : h('button', { className: 'primary', onclick: guard(() => runFromHome(p)) }, icon('bolt', 14), data ? `Fill row ${(data.cursor || 0) + 1}` : 'Fill')),
    data ? rowBar(p, data) : null,
    reportEl(state.runs[p.id], { onUndo: guard(() => undoFromHome(p)) }),
    h('div', { className: 'links' },
      h('button', { className: 'link', textContent: 'Edit', onclick: () => nav.editor(p, false) }),
      h('button', { className: 'link', textContent: 'Duplicate', onclick: copy }),
      h('button', { className: 'link', textContent: 'Export', title: 'Save this profile as a file to share. Data rows are not included.', onclick: () => download(`powerfill-${slug}.json`, exportPayload([p])) }),
      confirmClick(h('button', { className: 'link', textContent: 'Delete' }), 'Really delete?', guard(async () => {
        await deleteProfile(p.id);
        await showHome();
      }))));
}

// While a fill or undo is under way the panel saves profiles itself; `busy` stops the storage
// listener from redrawing the list halfway through with the previous fill's report on it.
async function runFromHome(p) {
  const tab = await currentTab();
  state.busy = true;
  let report;
  try { report = await runProfile(tab.id, p, { ask: askInPanel }); } finally { state.busy = false; }
  if (report.outcome === 'cancelled') return;
  state.runs = { [p.id]: report };
  await showHome();
}

async function undoFromHome(p) {
  const tab = await currentTab();
  state.busy = true;
  let undone;
  try { undone = await undoFill(tab.id); } finally { state.busy = false; }
  delete state.runs[p.id];
  await showHome();
  toast(undone ? `Put ${plural(undone, 'field')} back the way ${undone === 1 ? 'it was' : 'they were'}.` : 'Nothing to undo. The page has changed since the fill.', undone ? '' : 'bad');
}

async function startScan() {
  const tab = await currentTab();
  const scroll = state.settings.scrollScan;
  let result;
  // A scrolling scan takes a few seconds, so the button turns into Stop while it runs.
  state.scanning = scroll;
  if (scroll) renderHome();
  try {
    result = await scanPage(tab.id, { includeHidden: state.includeHidden, scroll });
  } finally {
    state.scanning = false;
    if (!result && state.view === 'home') renderHome();
  }
  const { fields, stopped } = result;
  nav.editor({ id: newId(), name: (tab.title || 'New profile').slice(0, 60), urlPattern: suggestPattern(tab.url), fields: fields.map(toRow) }, true);
  if (fields.length) toast(`Found ${plural(fields.length, 'field')}.` + (scanNote(stopped) || ' Type the values to fill, then save.'), stopped ? 'bad' : '');
  else toast('No fields found on this page. Add rows by hand, or use Pick field.', 'bad');
}

$('#importFile').onchange = guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('That file is not a PowerFill export. Choose a .json file saved with Export.'); }
  const count = await importProfiles(data);
  await showHome();
  toast(`Imported ${plural(count, 'profile')}.`);
});
