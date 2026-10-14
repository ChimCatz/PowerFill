// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Small DOM toolkit shared by the panel's views.

export const $ = (selector, root = document) => root.querySelector(selector);
export const asText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Children may be nodes, strings, arrays of those, or null / false for "nothing here".
const kids = (children) => children.flat().filter((c) => c != null && c !== false);

export function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids(children));
  return el;
}

export const mount = (parent, ...children) => parent.replaceChildren(...kids(children));

const ICONS = {
  scan: '<path d="M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2M5 8h6"/>',
  pick: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  show: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  remove: '<path d="M4 4l8 8M12 4l-8 8"/>',
  back: '<path d="M10 3L5 8l5 5"/>',
  prev: '<path d="M10 3L5 8l5 5"/>',
  next: '<path d="M6 3l5 5-5 5"/>',
  user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.6-2.8 2.7-4.2 5.5-4.2s4.9 1.4 5.5 4.2"/>',
  undo: '<path d="M5 3L2 6l3 3"/><path d="M2 6h7.5a4 4 0 0 1 0 8H6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  ok: '<circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l1.9 1.9 3.7-4"/>',
  alert: '<path d="M8 2.2L14.3 13H1.7L8 2.2Z"/><path d="M8 6.5v3.2M8 11.4v.1"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4V1.8Z"/><path d="M9 1.8v3h3"/>',
  bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z"/>',
  rows: '<path d="M2 3.5h12M2 8h12M2 12.5h12"/>',
};

export function icon(name, size = 15) {
  const holder = document.createElement('span');
  holder.innerHTML = `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return holder.firstChild;
}

export function iconButton(name, title, onclick, props = {}) {
  const button = h('button', { className: 'icon', title, onclick, ...props }, icon(name));
  button.setAttribute('aria-label', title);
  return button;
}

let toastTimer;
// kind: '' (neutral), 'bad' (something went wrong), 'sticky' (stays until replaced or hidden)
export function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = kind === 'bad' ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  if (kind !== 'sticky') toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 6000 : 3500);
}

export const hideToast = () => { $('#toast').hidden = true; };

// Wraps a handler so failures (restricted page, bad file...) show up as a message instead of vanishing.
export const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e?.message || String(e), 'bad'); }
};

// Destructive buttons ask once: the first click arms them, a second click within 3s confirms.
export function confirmClick(button, question, action, needed = () => true) {
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

export function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
