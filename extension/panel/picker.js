// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// A picklist with a search box at the top and the recently chosen values pinned above the rest.
// Stands in for <select>, which cannot hold a search box. One pop-up is shared by every picklist.

import { h, mount, icon } from './dom.js';
import { norm } from '../lib/template.js';

const RECENTS_SHOWN = 5;
let box = null;
let closedAt = 0, closedBy = null;

function popup() {
  if (box) return box;
  box = h('div', { id: 'picker' });
  box.setAttribute('popover', 'auto');   // the browser closes it on Esc or a click elsewhere
  document.body.append(box);
  return box;
}

// options: [{ value, text }]. `value` is a string, or an array when `multiple`.
// `recents` returns the values chosen before for this field, read each time the list opens;
// `allowCustom` offers "Use what I typed".
// Returns the button that shows the choice and opens the list.
export function pickerEl({ options, value, multiple = false, placeholder = '— skip —', recents = () => [], allowCustom = true, label = '', onchange }) {
  let current = multiple ? (Array.isArray(value) ? [...value] : value ? [String(value)] : []) : String(value ?? '');
  const textOf = (v) => options.find((o) => o.value === v)?.text ?? v;
  const face = h('span', { className: 'picker-text' });
  const trigger = h('button', { type: 'button', className: 'value picker' }, face, icon('chevron', 12));
  trigger.setAttribute('aria-haspopup', 'listbox');
  if (label) trigger.setAttribute('aria-label', label);
  if (multiple) trigger.dataset.multiple = '1';

  function paint() {
    const text = multiple ? current.map(textOf).join(', ') : current === '' ? '' : textOf(current);
    face.textContent = text || placeholder;
    trigger.classList.toggle('blank', !text);
    trigger.title = text;
    trigger.dataset.value = multiple ? JSON.stringify(current) : current;
  }

  function open() {
    // A click on the button while the list is open has just closed it; don't open it again.
    if (closedBy === trigger && performance.now() - closedAt < 200) return;
    const pop = popup();
    const search = h('input', { type: 'search', className: 'picker-search', placeholder: 'Search…', autocomplete: 'off', spellcheck: false });
    search.setAttribute('aria-label', 'Search the list');
    const list = h('div', { className: 'picker-list', role: 'listbox' });
    let items = [], active = 0;

    const activate = (index) => {
      active = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((el, i) => el.classList.toggle('active', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
    };

    function choose(v) {
      if (!multiple) {
        current = v;
        paint();
        pop.hidePopover();
        return onchange(v);
      }
      current = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
      paint();
      onchange([...current]);
      const keep = active;
      draw();
      activate(keep);
    }

    const item = (v, text, extra = '') => {
      const chosen = multiple ? current.includes(v) : current === v && v !== '';
      const el = h('div', { className: 'picker-item ' + extra, role: 'option', onclick: () => choose(v) },
        multiple ? h('span', { className: 'tick', textContent: chosen ? '✓' : '' }) : null, h('span', { textContent: text }));
      el.dataset.value = v;
      el.setAttribute('aria-selected', chosen);
      el.addEventListener('mousedown', (e) => e.preventDefault());   // keep the typing cursor in the search box
      return el;
    };

    function draw() {
      const q = norm(search.value);
      const typed = search.value.trim();
      const shown = options.filter((o) => !q || norm(o.text).includes(q) || norm(o.value).includes(q));
      const exact = options.some((o) => norm(o.text) === q || norm(o.value) === q);
      // Recent values lead the list, but only while nothing is being searched for.
      const recent = q || multiple ? [] : recents().map((r) => findOptionExact(options, r) || (allowCustom ? { value: r, text: r } : null))
        .filter((o, i, all) => o && all.findIndex((x) => x?.value === o.value) === i).slice(0, RECENTS_SHOWN);
      mount(list,
        !q && !multiple ? item('', placeholder, 'clear') : null,
        !q && multiple && current.length ? h('div', { className: 'picker-item clear', role: 'option', onclick: () => { current = []; paint(); onchange([]); draw(); } }, h('span', { textContent: 'Clear all' })) : null,
        recent.length ? [h('div', { className: 'picker-head', textContent: 'Recent' }), recent.map((o) => item(o.value, o.text, 'recent')), h('div', { className: 'picker-head', textContent: 'All' })] : null,
        shown.map((o) => item(o.value, o.text)),
        q && allowCustom && !multiple && !exact ? item(typed, `Use “${typed}”`, 'custom') : null,
        q && !shown.length && !(allowCustom && !multiple) ? h('div', { className: 'picker-none', textContent: 'Nothing matches' }) : null);
      items = [...list.querySelectorAll('[role="option"]')];
      // Start on the current choice, or on the first real match while searching.
      const at = q ? 0 : items.findIndex((el) => el.getAttribute('aria-selected') === 'true' && !el.classList.contains('recent'));
      activate(at < 0 ? 0 : at);
    }

    search.oninput = draw;
    search.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); activate(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activate(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); items[active]?.click(); }
      else if (e.key === 'Tab') pop.hidePopover();
    };

    // The list hangs under the button, or above it when there is more room there.
    function place() {
      const r = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(r.width, 240), innerWidth - 16);
      const below = innerHeight - r.bottom - 12, above = r.top - 12;
      const up = below < 220 && above > below;
      Object.assign(pop.style, {
        width: width + 'px',
        left: Math.max(8, Math.min(r.left, innerWidth - width - 8)) + 'px',
        top: up ? 'auto' : r.bottom + 4 + 'px',
        bottom: up ? innerHeight - r.top + 4 + 'px' : 'auto',
        maxHeight: Math.min(360, Math.max(140, up ? above : below)) + 'px',
      });
    }

    // Scrolling the panel would leave the list hanging in mid-air, so it closes instead. Scrolls
    // already under way when the list opened (a flick, then a click) are let through.
    const openedAt = performance.now();
    const onScroll = (e) => { if (!pop.contains(e.target) && performance.now() - openedAt > 250) pop.hidePopover(); };
    pop.ontoggle = (e) => {
      if (e.newState !== 'closed') return;
      closedAt = performance.now();
      closedBy = trigger;
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', place);
      if (document.activeElement === document.body || pop.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    };

    mount(pop, search, list);
    draw();
    pop.showPopover();
    place();
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', place);
    search.focus({ preventScroll: true });
    activate(active);
  }

  trigger.onclick = open;
  trigger.onkeydown = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } };
  paint();
  return trigger;
}

// A remembered value is matched to an option by its stored value or its exact text, never loosely.
function findOptionExact(options, wanted) {
  return options.find((o) => o.value === wanted) || options.find((o) => norm(o.text) === norm(wanted)) || null;
}
