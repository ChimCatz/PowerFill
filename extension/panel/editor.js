// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Editor view: one profile's name, page pattern, field sheet and data rows.

import { $, h, mount, iconButton, icon, toast, hideToast, guard, confirmClick, plural, asText } from './dom.js';
import { state, nav, currentTab } from './state.js';
import { reportEl } from './report.js';
import { askInPanel } from './ask.js';
import { renderDataTab, resetDataTab } from './datatab.js';
import { pickerEl } from './picker.js';
import { saveProfile, saveSettings, newId, recentKey, pushRecent } from '../lib/store.js';
import { callTab, scanTab, scanPage, runProfile, undoFill, hasValue } from '../lib/runner.js';
import { normalizeLocator } from '../lib/locator.js';
import { isTemplate, askToken, columnToken, myToken, columnsIn } from '../lib/template.js';

export const toRow = ({ current, empty, ...scanned }) => ({ ...scanned, id: newId(), value: '', enabled: true });

const hasChoices = (f) => f.kind === 'check' || (f.options?.length && ['select', 'radio', 'multi'].includes(f.kind));
const usesRows = (d) => !!d.data?.rows.length && columnsIn(d.fields.filter((f) => f.enabled !== false)).length > 0;

function openEditor(profile, isNew) {
  state.draft = structuredClone(profile);
  state.dirty = isNew;
  state.pane = 'fields';
  state.results = {};
  state.report = null;
  state.filter = '';
  resetDataTab();
  renderEditor();
}

nav.editor = openEditor;
nav.editorResume = renderEditor;

function touch() {
  state.dirty = true;
  const status = $('#status');
  if (status) status.textContent = 'Unsaved changes';
}

function renderEditor() {
  state.view = 'editor';
  $('#view').dataset.view = 'editor';
  const d = state.draft;
  const name = h('input', { className: 'name', value: d.name, placeholder: 'Profile name', oninput: () => { d.name = name.value; touch(); } });
  name.setAttribute('aria-label', 'Profile name');
  const pattern = h('input', {
    className: 'mono', value: d.urlPattern, spellcheck: false, placeholder: 'https://site.com/form*',
    title: 'Pages this profile is offered on. * matches anything; query parameters listed here must be present on the page.',
    oninput: () => { d.urlPattern = pattern.value.trim(); touch(); },
  });
  const back = confirmClick(h('button', { className: 'link back', textContent: '‹ Profiles' }), 'Discard changes?', guard(() => nav.home()), () => state.dirty);

  mount($('#view'),
    h('div', { className: 'editor-head' }, back, name,
      h('label', { className: 'stack' }, h('span', { textContent: 'Use on pages matching' }), pattern)),
    h('div', { id: 'tabs', className: 'tabs', role: 'tablist' }),
    h('div', { id: 'report' }),
    h('div', { id: 'pane' }),
    h('div', { className: 'actions' },
      h('button', { id: 'fillBtn', className: 'primary', title: 'Fill the page with these values now (no need to save first)', onclick: guard(fillNow) }),
      h('button', { id: 'undoBtn', title: 'Put the page back the way it was before the last fill', onclick: guard(undoNow) }, icon('undo', 13), 'Undo'),
      h('button', { textContent: 'Save', onclick: guard(save) }),
      h('span', { id: 'status', className: 'muted', textContent: state.dirty ? 'Unsaved changes' : '' })));
  renderChrome();
  renderReport();
  renderPane();
}

// The parts around the pane that depend on the sheet: tab counts, the Fill button's wording, Undo.
function renderChrome() {
  const d = state.draft;
  const tab = (pane, label, count) => {
    const button = h('button', { className: 'tab' + (state.pane === pane ? ' active' : ''), role: 'tab', onclick: () => { state.pane = pane; renderChrome(); renderPane(); } },
      label, h('span', { className: 'count', textContent: count }));
    button.setAttribute('aria-selected', state.pane === pane);
    return button;
  };
  mount($('#tabs'), tab('fields', 'Fields', d.fields.length), tab('data', 'Data rows', d.data?.rows.length || 0));
  const cursor = Math.min(d.data?.cursor || 0, d.data?.rows.length || 0);
  mount($('#fillBtn'), icon('bolt', 14), usesRows(d) ? `Fill row ${cursor + 1}` : 'Fill page');
  $('#undoBtn').disabled = state.report?.outcome !== 'filled';
}

function renderReport() {
  mount($('#report'), reportEl(state.report, { onDismiss: () => { state.report = null; renderReport(); } }));
}

function renderPane() {
  if (state.pane === 'data') return renderDataTab($('#pane'), { draft: state.draft, touch, refresh: () => { renderChrome(); renderPane(); } });
  renderFields();
}

// ---------- the field sheet ----------

function renderFields() {
  const filter = h('input', {
    className: 'filter', type: 'search', placeholder: 'Filter fields…', value: state.filter,
    oninput: () => { state.filter = filter.value.toLowerCase(); applyFilter(); },
  });
  const selectors = h('input', { type: 'checkbox', checked: state.settings.showSelectors, onchange: () => {
    state.settings.showSelectors = selectors.checked;
    saveSettings(state.settings);
    $('#rows').classList.toggle('no-selectors', !selectors.checked);
  } });

  mount($('#pane'),
    h('div', { className: 'toolbar' },
      h('button', { textContent: 'Rescan', title: 'Add fields that have appeared on the page since the last scan', onclick: guard(rescan) }),
      h('button', { textContent: 'Grab page values', title: 'Copy what is currently entered in the page’s form into this sheet', onclick: guard(grabValues) }),
      h('button', { title: 'Add an empty row and paste a selector into it', onclick: () => addRow(false) }, icon('plus', 12), 'Row'),
      h('button', { title: 'Add a row by clicking a field on the page', onclick: guard(() => addRow(true)) }, icon('pick', 13), 'Pick field')),
    h('div', { className: 'toolbar' }, filter, h('label', { className: 'check', title: 'Show each field’s selector' }, selectors, 'Selectors')),
    h('div', { id: 'rows', className: state.settings.showSelectors ? '' : 'no-selectors' }),
    h('p', { className: 'muted hint' }, 'A blank value leaves the field alone. Use ', h('b', { textContent: '{ }' }),
      ' on a row to ask for the value each time, or to take it from a data column or My details.'));
  renderRows();
}

function renderRows() {
  const fields = state.draft.fields;
  mount($('#rows'),
    h('div', { className: 'row head' },
      h('span', { className: 'grip' }), h('span', { className: 'on' }), h('span', { className: 'labelbox', textContent: 'Label' }),
      h('span', { className: 'selector', textContent: 'Selector' }), h('span', { className: 'valuebox', textContent: 'Value to fill' }),
      h('span', { className: 'tools' })),
    fields.length ? fields.map(rowEl) : h('div', { className: 'empty' },
      h('strong', { textContent: 'No fields yet' }),
      h('span', { textContent: 'Use Rescan to read the page, or Pick field to add one by clicking it.' })));
  const rows = $('#rows');
  rows.ondragover = (e) => {
    const over = dragged && e.target.closest?.('.row[data-id]');
    if (!over) return;
    e.preventDefault();
    const after = e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
    clearDropMarks();
    if (over.dataset.id !== dragged.id) over.classList.add(after ? 'drop-after' : 'drop-before');
  };
  rows.ondrop = (e) => {
    const mark = rows.querySelector('.drop-before, .drop-after');
    if (!dragged || !mark) return;
    e.preventDefault();
    // The dragged row is about to be redrawn, and a removed row may never get its dragend.
    const moved = dragged;
    dragged = null;
    moveField(moved, state.draft.fields.find((x) => x.id === mark.dataset.id), mark.classList.contains('drop-after'));
  };
  applyFilter();
}

// ---------- moving rows ----------

let dragged = null;   // the field whose row is being dragged

const clearDropMarks = () => document.querySelectorAll('#rows .drop-before, #rows .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));

// Puts `f` just before or after `target` in the sheet. Fields are filled in sheet order.
function moveField(f, target, after) {
  if (!target || target === f) return;
  const fields = state.draft.fields.filter((x) => x !== f);
  fields.splice(fields.indexOf(target) + (after ? 1 : 0), 0, f);
  state.draft.fields = fields;
  touch();
  renderRows();
  const row = document.querySelector(`#rows .row[data-id="${f.id}"]`);
  row?.classList.add('moved');
  row?.scrollIntoView({ block: 'nearest' });
}

// Keyboard version of dragging: swaps the row with its visible neighbour.
function nudge(f, direction) {
  const visible = [...document.querySelectorAll('#rows .row[data-id]:not([hidden])')].map((r) => r.dataset.id);
  const neighbour = visible[visible.indexOf(f.id) + direction];
  if (!neighbour) return;
  moveField(f, state.draft.fields.find((x) => x.id === neighbour), direction > 0);
  document.querySelector(`#rows .row[data-id="${f.id}"] .grip`)?.focus();
}

function applyFilter() {
  for (const row of document.querySelectorAll('#rows .row[data-id]')) {
    const f = state.draft.fields.find((x) => x.id === row.dataset.id);
    row.hidden = !!state.filter && !`${f.label} ${f.selector} ${asText(f.value)}`.toLowerCase().includes(state.filter);
  }
}

const TONE = { filled: 'ok', warn: 'warn', skipped: '' };
const NOTE = { notfound: 'Not found on this page. Check the selector.', skipped: 'Blank for this fill, so the field was left alone.' };

function rowEl(f) {
  const result = state.results[f.id];
  const row = h('div', { className: 'row' });
  row.dataset.id = f.id;
  if (result) row.classList.add(TONE[result.status] ?? 'bad');
  row.classList.toggle('off', f.enabled === false);

  // The handle makes the row draggable only while it is held, so text in the boxes can still be selected.
  const grip = h('button', { className: 'grip', title: 'Drag to move this field. With the keyboard: Up and Down arrows.' }, icon('grip', 14));
  grip.setAttribute('aria-label', `Move ${f.label || 'this field'}`);
  grip.onpointerdown = () => {
    row.draggable = true;
    addEventListener('pointerup', () => { row.draggable = false; }, { once: true });
  };
  grip.onkeydown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    nudge(f, e.key === 'ArrowUp' ? -1 : 1);
  };
  row.ondragstart = (e) => {
    dragged = f;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', f.label || f.selector || '');
    row.classList.add('dragging');
  };
  row.ondragend = () => {
    dragged = null;
    row.draggable = false;
    row.classList.remove('dragging');
    clearDropMarks();
  };

  const on = h('input', {
    className: 'on', type: 'checkbox', checked: f.enabled !== false, title: 'Fill this field',
    onchange: () => { f.enabled = on.checked; row.classList.toggle('off', !on.checked); touch(); renderChrome(); },
  });
  // In a narrow panel a long label is cut short, so the full text is also the tooltip.
  const label = h('input', { className: 'label', value: f.label || '', title: f.label || '', placeholder: 'Label', oninput: () => { f.label = label.title = label.value; touch(); } });
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
  selector.setAttribute('aria-label', 'Selector');

  row.append(grip, on,
    h('div', { className: 'labelbox' }, label, f.required ? h('span', { className: 'req', textContent: 'required', title: 'The page will not save without this field' }) : null),
    h('div', { className: 'tools' },
      iconButton('pick', 'Pick this field by clicking it on the page', guard(() => pick(f))),
      iconButton('show', 'Show this field on the page', guard(() => inspect(f, false))),
      iconButton('remove', 'Remove this row', () => {
        state.draft.fields = state.draft.fields.filter((x) => x !== f);
        row.remove();
        touch();
        renderChrome();
      })),
    h('div', { className: 'valuebox' }, valueEl(f), insertMenu(f)),
    selector);
  const note = result && (result.detail || NOTE[result.status]);
  if (note) row.append(h('div', { className: 'msg', textContent: note }));
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

const recentsOf = (f) => state.recents[recentKey(state.draft.urlPattern, f.selector)] || [];

// Remembers a value just chosen for a field, so every profile for this site offers it first next time.
function remember(f, value) {
  if (!f.selector || !value || typeof value !== 'string' || isTemplate(value) || f.inputType === 'password' || value.length > 120) return;
  const key = recentKey(state.draft.urlPattern, f.selector);
  state.recents[key] = [value, ...(state.recents[key] || []).filter((v) => v !== value)].slice(0, 6);
  pushRecent(key, value);
}

// The value cell matches the field: a searchable list for picklists and radios (several can be
// ticked for multi-selects), check / uncheck for a checkbox, otherwise a text box. A value
// containing {{tokens}} is always shown as text, whatever the field is.
function valueEl(f) {
  const onset = (v) => { f.value = v; touch(); };
  const skip = ['', '— skip —'];
  if (!isTemplate(f.value)) {
    if (f.kind === 'check') return selectEl([skip, ['true', '☑ Check'], ['false', '☐ Uncheck']], f.value, onset);
    if (f.options?.length && ['select', 'radio', 'multi'].includes(f.kind)) {
      const multiple = f.kind === 'multi';
      return pickerEl({
        options: f.options, value: f.value, multiple, recents: () => recentsOf(f), label: `Value for ${f.label || 'this field'}`,
        onchange: (v) => { onset(v); if (!multiple) remember(f, v); },
      });
    }
  }
  const el = h(f.multiline ? 'textarea' : 'input', {
    className: 'value', value: asText(f.value), placeholder: 'Value',
    oninput: () => { onset(el.value); el.classList.toggle('template', isTemplate(el.value)); },
    // Once the tokens are gone, a picklist goes back to being a dropdown.
    onchange: () => {
      if (!f.multiline) remember(f, el.value.trim());
      if (hasChoices(f) && !isTemplate(f.value)) replaceRow(f);
      renderChrome();
    },
  });
  el.classList.toggle('template', isTemplate(f.value));
  if (f.multiline) el.rows = 2; else el.type = f.inputType === 'password' && !isTemplate(f.value) ? 'password' : 'text';
  // Values typed into this field before are offered as suggestions while typing.
  const recent = f.multiline || f.inputType === 'password' ? [] : recentsOf(f);
  if (!recent.length) return el;
  const list = h('datalist', { id: 'recent-' + f.id }, recent.map((value) => h('option', { value })));
  el.setAttribute('list', list.id);
  return [el, list];
}

// The "{ }" menu: values that are worked out at fill time.
function insertMenu(f) {
  const group = (label, items) => (items.length ? h('optgroup', { label }, items.map(([value, text]) => h('option', { value, textContent: text }))) : null);
  const vars = state.vars.map((v) => v.key.trim()).filter(Boolean);
  const menu = h('select', { className: 'insert', title: 'Insert a value that is worked out when filling' },
    h('option', { value: '', textContent: '{ }', hidden: true }),
    group('When filling', [[askToken(f.label || 'Value'), 'Ask me each time'], ['{{today}}', 'Today’s date'], ['{{clear}}', 'Empty the field']]),
    group('Data columns', (state.draft.data?.columns || []).map((c) => [columnToken(c), c])),
    group('My details', vars.map((key) => [myToken(key), key])));
  menu.setAttribute('aria-label', 'Insert a special value');
  menu.onchange = () => {
    const token = menu.value;
    menu.value = '';
    // Text can combine tokens with typing ("Hi {{First name}}"); anything else is replaced outright.
    const append = !hasChoices(f) && typeof f.value === 'string' && f.value && token !== '{{clear}}';
    f.value = append ? f.value + token : token;
    f.enabled = true;
    touch();
    replaceRow(f);
    renderChrome();
  };
  return menu;
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
  if (!hit) return quiet ? null : toast('Nothing on the page matches this selector.', 'bad');
  if (hit.field) {
    const shape = JSON.stringify([f.label, f.kind, f.options, f.required]);
    adopt(f, hit.field);
    if (shape !== JSON.stringify([f.label, f.kind, f.options, f.required])) replaceRow(f);
  }
  if (quiet) return;
  if (hit.field) toast('Highlighted on the page.');
  else toast('That selector matches something, but it is not a form field.', 'bad');
}

function addRow(thenPick) {
  const f = { id: newId(), label: '', selector: '', kind: 'text', value: '', enabled: true, frame: 'any' };
  state.draft.fields.push(f);
  state.filter = '';
  $('.filter').value = '';
  touch();
  renderRows();
  renderChrome();
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
  toast('Click the field on the page. Press Esc to cancel.', 'sticky');
}

export async function endPick() {
  state.picking = null;
  hideToast();
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

// Said after a scrolling scan that did not reach the end of the page.
export const scanNote = (stopped) => ({
  user: ' The scroll was stopped early, so fields further down may be missing.',
  panel: ' The scroll was stopped early, so fields further down may be missing.',
  time: ' The scroll hit its 20-second limit, so fields further down may be missing.',
  endless: ' The page kept growing as it scrolled, so the scan stopped following it.',
}[stopped] || '');

async function rescan() {
  const tab = await currentTab();
  const scroll = state.settings.scrollScan;
  if (scroll) toast('Scrolling the page to find every field. Click the page or press Esc on it to stop.', 'sticky');
  const { fields: scanned, stopped } = await scanPage(tab.id, { includeHidden: state.includeHidden, scroll });
  let added = 0;
  for (const s of scanned) {
    const existing = state.draft.fields.find((f) => f.selector === s.selector);
    if (existing) adopt(existing, s);
    else { state.draft.fields.push(toRow(s)); added++; }
  }
  if (added) touch();
  renderRows();
  renderChrome();
  toast((added ? `Added ${plural(added, 'new field')}.` : 'No new fields on the page.') + scanNote(stopped), stopped ? 'bad' : '');
}

async function grabValues() {
  const tab = await currentTab();
  const scanned = await scanTab(tab.id, { includeHidden: true });
  let grabbed = 0;
  for (const f of state.draft.fields) {
    const s = scanned.find((x) => x.selector === f.selector);
    // Values that are worked out at fill time are the user's intent; a typed value never replaces them.
    if (!s || !hasValue(s.current) || isTemplate(f.value)) continue;
    f.value = s.current;
    grabbed++;
  }
  if (grabbed) touch();
  renderRows();
  toast(grabbed ? `Copied ${plural(grabbed, 'value')} from the page.` : 'The page’s fields are all empty.');
}

async function fillNow() {
  const tab = await currentTab();
  // A try-out from the editor fills the current row but stays on it; saving is up to the user.
  const report = await runProfile(tab.id, state.draft, { ask: askInPanel, persist: false, advance: false });
  if (report.outcome === 'cancelled') return;
  state.results = report.results || {};
  state.report = report;
  renderReport();
  renderChrome();
  if (state.pane === 'fields') renderRows();
}

async function undoNow() {
  const tab = await currentTab();
  const undone = await undoFill(tab.id);
  state.results = {};
  state.report = null;
  renderReport();
  renderChrome();
  if (state.pane === 'fields') renderRows();
  toast(undone ? `Put ${plural(undone, 'field')} back the way ${undone === 1 ? 'it was' : 'they were'}.` : 'Nothing to undo. The page has changed since the fill.', undone ? '' : 'bad');
}

async function save() {
  const d = state.draft;
  d.name = d.name.trim();
  if (!d.name) return toast('Give the profile a name first.', 'bad');
  d.updatedAt = Date.now();
  await saveProfile(d);
  state.dirty = false;
  $('#status').textContent = 'Saved';
  toast('Profile saved.');
}
