// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// "My details" view: a person's own values (name, email, phone...) that any profile can use as
// {{my.key}}. They stay on this PC, so a shared profile fills in each colleague's own details.

import { $, h, mount, icon, iconButton, guard } from './dom.js';
import { state, nav } from './state.js';
import { listVars, saveVars } from '../lib/store.js';

async function showDetails() {
  const from = state.view === 'details' ? 'home' : state.view;
  state.view = 'details';
  $('#view').dataset.view = 'details';
  state.vars = await listVars();
  if (!state.vars.length) state.vars = [{ key: 'name', value: '' }, { key: 'email', value: '' }, { key: 'phone', value: '' }];
  render(from);
}

nav.details = showDetails;

function render(from) {
  const status = h('span', { className: 'muted' });
  const store = guard(async () => {
    await saveVars(state.vars);
    status.textContent = 'Saved';
  });
  const leave = guard(async () => {
    state.vars = await listVars();
    if (from === 'editor' && state.draft) nav.editorResume(); else nav.home();
  });

  const rowEl = (item) => {
    const hint = h('code', { className: 'muted' });
    const paint = () => { hint.textContent = item.key.trim() ? `{{my.${item.key.trim()}}}` : ''; };
    const key = h('input', { className: 'var-key', value: item.key, placeholder: 'name it, e.g. email', spellcheck: false, oninput: () => { item.key = key.value.replace(/[{}]/g, ''); paint(); store(); } });
    key.setAttribute('aria-label', 'Name');
    const value = h('input', { className: 'var-value', value: item.value, placeholder: 'value', oninput: () => { item.value = value.value; store(); } });
    value.setAttribute('aria-label', 'Value');
    paint();
    return h('div', { className: 'var' }, key, value,
      iconButton('remove', 'Remove', () => { state.vars = state.vars.filter((v) => v !== item); store(); render(from); }), hint);
  };

  mount($('#view'),
    h('div', { className: 'editor-head' },
      h('button', { className: 'link back', textContent: from === 'editor' ? '‹ Back to the profile' : '‹ Profiles', onclick: leave }),
      h('h1', { textContent: 'My details' }),
      h('p', { className: 'muted', textContent: 'Set these once and use them in any profile from the { } menu. They stay on this PC and are never included in an export, so a profile you share fills in each person’s own details.' })),
    h('div', { className: 'vars card' }, state.vars.map(rowEl)),
    h('div', { className: 'toolbar' },
      h('button', { onclick: () => { state.vars.push({ key: '', value: '' }); render(from); $('.var:last-child .var-key').focus(); } }, icon('plus', 12), 'Add a detail'),
      status));
}
