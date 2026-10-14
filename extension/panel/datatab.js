// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// The editor's "Data rows" tab: paste or load a spreadsheet, match its columns to fields,
// see which cells the page will not accept, and choose which row is filled next.

import { $, h, mount, icon, toast, guard, confirmClick, plural } from './dom.js';
import { pickerEl } from './picker.js';
import { parseTable, autoMatch, checkData } from '../lib/table.js';
import { norm, mappedColumn, columnToken, columnsIn, tokensIn } from '../lib/template.js';

const MAX_SHOWN = 200;
let replacing = false;   // the paste box is showing although rows are already loaded

export const resetDataTab = () => { replacing = false; };

const usesColumn = (f, column) => tokensIn(f.value).some((t) => t.type === 'column' && norm(t.name) === norm(column));

export function renderDataTab(pane, { draft, touch, refresh }) {
  const loaded = !!draft.data?.columns.length;

  function load(text, source) {
    const data = { ...parseTable(text, header.checked), cursor: 0 };
    draft.data = data;
    replacing = false;
    autoMatch(draft);
    const matched = data.columns.filter((c) => draft.fields.some((f) => usesColumn(f, c))).length;
    touch();
    refresh();
    toast(`Loaded ${plural(data.rows.length, 'row')} from ${source}. ${matched} of ${plural(data.columns.length, 'column')} matched to fields`
      + (matched < data.columns.length ? '; match the rest below.' : '.'));
  }

  const header = h('input', { type: 'checkbox', checked: true });
  const paste = h('textarea', {
    className: 'paste', rows: 4, spellcheck: false,
    placeholder: 'Copy the cells in Excel or Google Sheets, including the heading row, and paste them here.',
  });
  // Pasting is the whole gesture: read the cells as soon as they land.
  paste.addEventListener('paste', () => setTimeout(guard(() => load(paste.value, 'the clipboard'))));
  const file = $('#dataFile');
  file.onchange = guard(async () => {
    const chosen = file.files[0];
    file.value = '';
    if (chosen) load(await chosen.text(), chosen.name);
  });
  const intake = h('div', { className: 'card intake' },
    paste,
    h('div', { className: 'toolbar' },
      h('label', { className: 'check' }, header, 'First row has the column names'),
      h('span', { className: 'spacer' }),
      h('button', { onclick: () => file.click() }, icon('file', 13), 'Load a file'),
      h('button', { className: 'primary', textContent: 'Use these rows', onclick: guard(() => load(paste.value, 'the box above')) })),
    loaded ? h('button', { className: 'link', textContent: 'Cancel', onclick: () => { replacing = false; refresh(); } }) : null);

  if (!loaded) {
    return mount(pane,
      h('div', { className: 'empty' },
        h('strong', { textContent: 'Fill one row at a time from a spreadsheet' }),
        h('span', { textContent: 'Paste your rows, match each column to a field once, and every press of Fill takes the next row.' })),
      intake);
  }

  const { columns, rows } = draft.data;
  const cursor = Math.min(draft.data.cursor || 0, rows.length);
  const problems = checkData(draft);
  const flagged = new Map(problems.map((p) => [`${p.row}:${p.column}`, p.message]));
  const orphans = columnsIn(draft.fields).filter((name) => !columns.some((c) => norm(c) === norm(name)));

  // One line per column: which field does it go into?
  const matching = columns.map((column) => {
    const current = draft.fields.find((f) => norm(mappedColumn(f.value) ?? '\0') === norm(column)) || draft.fields.find((f) => usesColumn(f, column));
    const choice = pickerEl({
      options: draft.fields.map((f) => ({ value: f.id, text: f.label || f.selector })), value: current?.id || '',
      placeholder: '— not used —', allowCustom: false, label: `Field for column ${column}`,
      onchange: (id) => {
        for (const f of draft.fields) if (norm(mappedColumn(f.value) ?? '\0') === norm(column)) f.value = '';
        const target = draft.fields.find((f) => f.id === id);
        if (target) Object.assign(target, { value: columnToken(column), enabled: true });
        touch();
        refresh();
      },
    });
    return h('div', { className: 'match' + (current ? '' : ' unused') },
      h('div', { className: 'match-col' }, h('strong', { textContent: column }), h('span', { className: 'muted', textContent: rows[cursor]?.[columns.indexOf(column)] || rows[0][columns.indexOf(column)] || '' })),
      h('span', { className: 'arrow', textContent: '→' }),
      choice);
  });

  const check = orphans.length || problems.length
    ? h('div', { className: 'report warn' },
      h('div', { className: 'report-head' }, icon('alert'), h('strong', { textContent: problems.length
        ? `${plural(problems.length, 'cell')} in ${plural(new Set(problems.map((p) => p.row)).size, 'row')} will not fill correctly`
        : 'Some fields point at columns that are not here' })),
      orphans.length ? h('div', { className: 'report-part' }, h('ul', {}, orphans.map((name) => h('li', { textContent: `A field uses {{${name}}}, but the data has no column with that name.` })))) : null,
      problems.length ? h('div', { className: 'report-part' }, h('ul', {},
        problems.slice(0, 30).map((p) => h('li', {}, h('b', { textContent: `Row ${p.row + 1}, ${p.label}: ` }), p.message)),
        problems.length > 30 ? h('li', { className: 'muted', textContent: `…and ${problems.length - 30} more, marked in the table below.` }) : null)) : null)
    : h('div', { className: 'report ok' }, h('div', { className: 'report-head' }, icon('ok'), h('strong', { textContent: `All ${plural(rows.length, 'row')} look right for the matched fields.` })));

  const used = columns.map((c) => draft.fields.some((f) => usesColumn(f, c)));
  const table = h('table', { className: 'sheet' },
    h('thead', {}, h('tr', {}, h('th', { textContent: '#' }), columns.map((c, i) => h('th', { className: used[i] ? '' : 'unused', textContent: c })))),
    h('tbody', {}, rows.slice(0, MAX_SHOWN).map((cells, r) => {
      const tr = h('tr', { className: r === cursor ? 'current' : r < cursor ? 'done' : '', title: 'Click to make this the next row to fill', onclick: () => { draft.data.cursor = r; touch(); refresh(); } },
        h('td', { className: 'num', textContent: r < cursor ? '✓' : r + 1 }),
        cells.map((cell, c) => {
          const message = flagged.get(`${r}:${c}`);
          return h('td', { className: (message ? 'bad ' : '') + (used[c] ? '' : 'unused'), textContent: cell, title: message ? `${cell || '(empty)'} ${message}` : '' });
        }));
      return tr;
    })));

  mount(pane,
    replacing ? intake : null,
    h('div', { className: 'data-head' },
      h('strong', { textContent: `${plural(rows.length, 'row')} · ${plural(columns.length, 'column')}` }),
      h('span', { className: 'muted', textContent: cursor >= rows.length ? 'all used' : `next: row ${cursor + 1}` }),
      h('span', { className: 'spacer' }),
      replacing ? null : h('button', { className: 'link', textContent: 'Replace rows', onclick: () => { replacing = true; refresh(); } }),
      confirmClick(h('button', { className: 'link', textContent: 'Remove' }), 'Remove the data?', () => {
        for (const f of draft.fields) if (mappedColumn(f.value)) f.value = '';
        delete draft.data;
        touch();
        refresh();
      })),
    check,
    // Matching is a one-off job: once every column has a field, it folds away.
    h('details', { className: 'fold', open: used.includes(false) },
      h('summary', {}, h('h2', {}, 'Match columns to fields', h('span', { className: 'count', textContent: `${used.filter(Boolean).length} of ${columns.length}` }))),
      h('div', { className: 'matches' }, matching)),
    h('h2', { textContent: 'Rows' }),
    h('div', { className: 'sheet-wrap' }, table),
    rows.length > MAX_SHOWN ? h('p', { className: 'muted hint', textContent: `Showing the first ${MAX_SHOWN} rows. All ${rows.length} will be filled in order.` }) : null,
    h('p', { className: 'muted hint', textContent: 'Rows are kept on this PC only and are left out of exported profiles.' }));
}
