// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// The dialog that collects {{ask:...}} values before a fill started from the panel.

import { $, h, mount } from './dom.js';

// Resolves to { label: answer } or to null if the person cancels. `choices` maps a label to
// suggestions offered while typing: that field's recent values first, then its picklist options.
export function askInPanel(labels, defaults = {}, choices = {}) {
  return new Promise((resolve) => {
    const dialog = $('#ask');
    const inputs = labels.map((label) => h('input', { name: label, value: defaults[label] ?? '', autocomplete: 'off' }));
    const lists = labels.map((label, i) => {
      if (!choices[label]?.length) return null;
      inputs[i].setAttribute('list', 'ask-choices-' + i);
      inputs[i].placeholder = 'Type to search, or pick from the list';
      return h('datalist', { id: 'ask-choices-' + i }, choices[label].map((value) => h('option', { value })));
    });
    let answers = null;
    const form = h('form', { method: 'dialog' },
      h('h1', { textContent: 'A few values for this fill' }),
      labels.map((label, i) => h('label', { className: 'stack' }, h('span', { textContent: label }), inputs[i], lists[i])),
      h('div', { className: 'dialog-actions' },
        h('button', { type: 'button', textContent: 'Cancel', onclick: () => dialog.close() }),
        h('button', { className: 'primary', textContent: 'Fill' })));
    form.addEventListener('submit', () => { answers = Object.fromEntries(inputs.map((i) => [i.name, i.value])); });
    dialog.onclose = () => resolve(answers);
    mount(dialog, form);
    dialog.showModal();
    inputs[0].select();
  });
}
