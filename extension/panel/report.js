// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// The summary shown after a fill: what went in, what did not and why, and which required
// fields are still empty. Field names in it are buttons that point the field out on the page.

import { h, icon, plural, guard, toast } from './dom.js';
import { state } from './state.js';
import { callTab } from '../lib/runner.js';

const locate = (selector) => guard(async () => {
  const hit = (await callTab(state.tab.id, 'highlight', { selector })).find((r) => r.count);
  if (!hit) toast('That field is not on the page right now.', 'bad');
});

const fieldLink = (item) => h('button', { className: 'link', textContent: item.label, title: 'Show on the page', onclick: locate(item.selector) });

export function reportEl(report, { onUndo, onDismiss } = {}) {
  if (!report || report.outcome === 'cancelled') return null;
  if (report.outcome === 'nothing') return h('div', { className: 'report warn' }, h('div', { className: 'report-head' }, icon('alert'), h('strong', { textContent: 'Nothing to fill: no values are set.' })));
  if (report.outcome === 'finished') {
    return h('div', { className: 'report warn' }, h('div', { className: 'report-head' }, icon('alert'),
      h('strong', { textContent: `All ${plural(report.row.count, 'row')} have been used.` })));
  }

  const { filled, problems, missing, row } = report;
  const clean = !problems.length && !missing.length;
  return h('div', { className: 'report ' + (clean ? 'ok' : 'warn') },
    h('div', { className: 'report-head' },
      icon(clean ? 'ok' : 'alert'),
      h('strong', { textContent: `Filled ${plural(filled, 'field')}` + (row ? ` from row ${row.index + 1} of ${row.count}` : '') }),
      onUndo ? h('button', { className: 'small', title: 'Put the page back the way it was (Alt+Shift+U)', onclick: onUndo }, icon('undo', 13), 'Undo') : null,
      onDismiss ? h('button', { className: 'icon', title: 'Hide', onclick: onDismiss }, icon('remove', 12)) : null),
    problems.length ? h('div', { className: 'report-part' },
      h('div', { className: 'report-title', textContent: `${plural(problems.length, 'field')} need${problems.length === 1 ? 's' : ''} a look` }),
      h('ul', {}, problems.map((p) => h('li', {}, fieldLink(p), h('span', { textContent: ' ' + p.detail }))))) : null,
    missing.length ? h('div', { className: 'report-part' },
      h('div', { className: 'report-title', textContent: 'Required by the page but still empty' }),
      h('div', { className: 'chips' }, missing.map(fieldLink))) : null);
}
