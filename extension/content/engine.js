// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Page engine. Injected on demand into every frame of the tab.
// Plain DOM code: scan fields, fill and undo, highlight a field, an element picker, and a prompt.
(() => {
  window.__powerfill?.stopPicker?.();

  // Identifies which frame a field lives in, so a profile fills it in the same frame later.
  const FRAME = window === window.top ? 'top'
    : /^(about|blob|data):/.test(location.protocol) ? 'frame:' + (window.name || 'inline')
    : location.origin + location.pathname;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
  const NATIVE = 'input,textarea,select';
  const CANDIDATES = NATIVE + ',[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],' +
    '[role="textbox"],[role="combobox"],[role="checkbox"],[role="switch"],[role="radio"]';
  // Dropdown libraries (Select2, Chosen, Tom Select, Selectize...) hide the real <select> and draw
  // their own box next to it. Their internal search inputs are not form fields.
  const WIDGETS = '.select2-container,.chosen-container,.ts-wrapper,.selectize-control,.nice-select';
  const WIDGET_PARTS = WIDGETS + ',.select2-drop,.select2-dropdown,.choices__list,.bs-searchbox';
  const TEXT_SKIP = 'script,style,noscript,select,textarea,button,svg,' + WIDGET_PARTS;
  const AUTO_ID = /^(s2id_|select2-|ember|react-|mui-|mat-|radix-|headlessui-|:r|ext-gen|yui_|gwt-|j_id)|\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-|^\d/i;
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-fieldname', 'data-field', 'data-key', 'data-name'];
  const YES = new Set(['true', 'yes', 'y', '1', 'on', 'x', 'check', 'checked']);
  const NO = new Set(['false', 'no', 'n', '0', 'off', 'uncheck', 'unchecked']);
  const OK_COLOR = '#16a34a';
  const WARN_COLOR = '#d97706';
  const PICK_COLOR = '#1273c4';

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase();
  const quote = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const asText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
  const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\s*[;|\n]\s*/)).filter(Boolean);

  function tidyLabel(s) {
    s = clean(s).replace(/^[*:\s]+|[\s*:]+$/g, '');
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  function pretty(s) {
    s = clean(String(s || '').replace(/\[\]$/, '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
    return s && s[0].toUpperCase() + s.slice(1);
  }

  function shadowOf(el) {
    try { return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot; }
    catch { return el.shadowRoot; }
  }

  function deepAll(root, selector, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) {
      const shadow = shadowOf(el);
      if (shadow) deepAll(shadow, selector, out);
    }
    return out;
  }

  // ---------- classifying elements ----------

  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return el.multiple ? 'multi' : 'select';
    if (tag === 'TEXTAREA') return 'text';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'check';
      if (type === 'radio') return 'radio';
      return SKIP_TYPES.has(type) ? null : 'text';
    }
    const role = el.getAttribute('role');
    if (role === 'checkbox' || role === 'switch') return 'check';
    if (role === 'radio') return 'radio';
    if (el.isContentEditable || role === 'textbox') return 'text';
    if (role === 'combobox') return 'combo';
    return null;
  }

  const isWidgetPart = (el) => el.tagName !== 'SELECT' && !!el.closest(WIDGET_PARTS);
  const isField = (el) => !!kindOf(el) && !isWidgetPart(el) && !el.disabled;
  const isChecked = (el) => ('checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true');

  function widgetOf(el) {
    if (el.tagName !== 'SELECT') return null;
    for (const sib of [el.previousElementSibling, el.nextElementSibling]) if (sib?.matches(WIDGETS)) return sib;
    return el.closest('.bootstrap-select,.choices,.nice-select');
  }

  function rendered(el) {
    if (!el?.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return false;
    return r.right + scrollX >= 0 && r.bottom + scrollY >= 0;
  }

  // Hidden text inputs are usually spam honeypots, so they are left out unless asked for.
  // Selects and checkboxes are often hidden behind a styled replacement and still count.
  function isVisible(el) {
    if (rendered(el)) return true;
    if (el.tagName === 'SELECT') return rendered(widgetOf(el));
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      return [...(el.labels || [])].some(rendered) || rendered(el.parentElement);
    }
    return false;
  }

  // Radios (always) and same-named checkboxes (two or more) are treated as one field.
  function groupOf(el) {
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && el.name) {
      const same = [...el.getRootNode().querySelectorAll(`input[type="${el.type}"][name=${quote(el.name)}]`)]
        .filter((m) => m.form === el.form && !m.disabled);
      if (el.type === 'radio' || same.length > 1) return same;
    }
    if (el.getAttribute('role') === 'radio') {
      const group = el.closest('[role="radiogroup"]');
      if (group) return [...group.querySelectorAll('[role="radio"]')];
    }
    return [el];
  }

  // ---------- labels ----------

  // Visible text inside `root`, ignoring the given elements and the contents of other controls.
  function textAround(root, exclude) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let n = walker.nextNode(); n && out.length < 400; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(TEXT_SKIP) || exclude.some((x) => x.contains(p))) continue;
      out += ' ' + n.nodeValue;
    }
    return clean(out);
  }

  const hasOtherFields = (node, set) => [...node.querySelectorAll(NATIVE)].some((f) => !set.has(f) && isField(f));

  function precedingText(node) {
    for (let s = node.previousSibling, i = 0; s && i < 4; s = s.previousSibling, i++) {
      if (s.nodeType === Node.TEXT_NODE) {
        if (clean(s.nodeValue)) return clean(s.nodeValue);
      } else if (s.nodeType === Node.ELEMENT_NODE && !s.matches('br')) {
        // Text that sits with another field is that field's caption, not ours.
        if (s.matches(CANDIDATES) || s.querySelector(CANDIDATES)) return '';
        const text = textAround(s, []);
        if (text) return text.length <= 160 ? text : '';
      }
    }
    return '';
  }

  // Finds the caption for a field with no <label>: the text of the smallest wrapper that holds only
  // this field, else the neighbouring table cell (vtiger and most CRMs). Also returns the outermost
  // wrapper it reached, so the caller can fall back to the text just before it.
  function contextLabel(members) {
    const set = new Set(members);
    const grouped = members.length > 1;
    const exclude = grouped ? [...members, ...members.flatMap((m) => [...(m.labels || [])])] : members;
    let node = members[0].parentElement;
    while (grouped && node && !members.every((m) => node.contains(m))) node = node.parentElement;
    let last = grouped ? null : members[0];
    for (let depth = 0; node && node !== document.documentElement && depth < 4; depth++, node = node.parentElement) {
      // A wrapper full of links and buttons is a navbar or toolbar, not a field's caption.
      if (node.querySelectorAll('a,button').length > 3) break;
      const crowded = hasOtherFields(node, set);
      if (!crowded) {
        const legend = node.matches('fieldset') ? node.querySelector('legend') : null;
        const text = legend ? clean(legend.textContent) : textAround(node, exclude);
        if (text) return { text: text.length <= 160 ? text : '' };
        last = node;
      }
      if (node.matches('td,th,dd')) {
        const prev = node.previousElementSibling;
        const text = prev && !hasOtherFields(prev, new Set()) ? textAround(prev, []) : '';
        if (text && text.length <= 160) return { text };
      }
      if (crowded) break;
    }
    return { text: '', last };
  }

  function labelledBy(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return clean(ids.map((id) => document.getElementById(id)?.textContent || '').join(' '));
  }

  function labelOf(el, members) {
    if (members.length === 1) {
      const direct = clean(el.getAttribute('aria-label')) || labelledBy(el);
      if (direct) return direct;
      const label = el.labels?.[0];
      const text = label && textAround(label, [el]);
      if (text) return text;
    }
    // The field's own placeholder is firmer evidence than loose text that merely precedes it.
    const context = contextLabel(members);
    return context.text || clean(el.getAttribute('placeholder')) || (context.last && precedingText(context.last)) ||
      clean(el.getAttribute('title')) || pretty(el.getAttribute('name') || el.id) || el.tagName.toLowerCase();
  }

  // The caption of one radio / checkbox inside a group.
  function optionText(el) {
    const label = el.labels?.[0];
    return clean(el.getAttribute('aria-label')) || (label && textAround(label, [el])) ||
      (el.nextSibling?.nodeType === Node.TEXT_NODE && clean(el.nextSibling.nodeValue)) ||
      clean(el.textContent) || clean(el.value);
  }

  // ---------- selectors ----------

  function isUnique(root, selector, el) {
    try {
      const found = root.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch { return false; }
  }

  function pathSelector(el, root) {
    const parts = [];
    for (let n = el; n && n.nodeType === Node.ELEMENT_NODE; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') { parts.unshift(tag); break; }
      if (n !== el && n.id && !AUTO_ID.test(n.id) && isUnique(root, '#' + CSS.escape(n.id), n)) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      const same = [...n.parentNode.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return parts.join(' > ');
  }

  // Prefers the most stable handle: id, then name, then test/data attributes, then a DOM path.
  function localSelector(el, root) {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    const tries = [];
    if (el.id && !AUTO_ID.test(el.id)) tries.push('#' + CSS.escape(el.id));
    if (name) tries.push(`${tag}[name=${quote(name)}]`);
    for (const attr of [...STABLE_ATTRS, 'aria-label', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) tries.push(`${tag}[${attr}=${quote(v)}]`);
    }
    if (name && el.form?.id && !AUTO_ID.test(el.form.id)) tries.push(`#${CSS.escape(el.form.id)} ${tag}[name=${quote(name)}]`);
    return tries.find((s) => isUnique(root, s, el)) || pathSelector(el, root);
  }

  // Elements inside shadow DOM get "host >>> inner", the same idea as DevTools' "Copy JS path".
  const withHost = (root, local) => (root instanceof ShadowRoot ? selectorFor(root.host) + ' >>> ' + local : local);

  function selectorFor(el) {
    const root = el.getRootNode();
    return withHost(root, localSelector(el, root));
  }

  function groupSelector(el, members) {
    const root = el.getRootNode();
    if (el.tagName === 'INPUT' && (members.length > 1 || el.type === 'radio') && el.name) {
      const base = `input[type="${el.type}"][name=${quote(el.name)}]`;
      const clash = root.querySelectorAll(base).length > members.length && el.form?.id;
      return withHost(root, clash ? `#${CSS.escape(el.form.id)} ${base}` : base);
    }
    if (members.length > 1) return selectorFor(el.closest('[role="radiogroup"]')) + ' [role="radio"]';
    return selectorFor(el);
  }

  function queryAll(root, selector) {
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  }

  // Accepts whatever the user pasted: a CSS selector, an XPath, "host >>> inner", or a bare id / name / class.
  function resolve(locator) {
    const s = clean(locator);
    if (!s) return [];
    if (/^\(*\.?\//.test(s)) {
      try {
        const snap = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: snap.snapshotLength }, (_, i) => snap.snapshotItem(i)).filter((n) => n.nodeType === Node.ELEMENT_NODE);
      } catch { return []; }
    }
    const steps = s.split('>>>').map(clean);
    let roots = [document];
    for (const step of steps.slice(0, -1)) roots = roots.flatMap((r) => queryAll(r, step)).map(shadowOf).filter(Boolean);
    const found = roots.flatMap((r) => queryAll(r, steps.at(-1)));
    if (found.length || steps.length > 1 || !/^[\w\-.:[\]]+$/.test(s)) return found;
    return [document.getElementById(s), ...document.getElementsByName(s), ...document.getElementsByClassName(s)].filter(Boolean);
  }

  // Maps whatever was matched onto the real field: the styled Select2 box maps to its hidden
  // <select>, a <label> to its control, a wrapper to the field inside it.
  function toField(el) {
    if (kindOf(el) && !isWidgetPart(el)) return el;
    const widget = el.closest(WIDGETS);
    if (widget) {
      const byId = widget.id?.startsWith('s2id_') ? document.getElementById(widget.id.slice(5)) : null;
      const select = [byId, widget.previousElementSibling, widget.nextElementSibling].find((x) => x?.tagName === 'SELECT');
      if (select) return select;
    }
    const control = el.closest('label')?.control;
    return control || [...el.querySelectorAll(CANDIDATES)].find(isField) || el;
  }

  const fieldsFor = (selector) => [...new Set(resolve(selector).map(toField))];

  // ---------- scan ----------

  function describe(el, members = groupOf(el)) {
    const kind = members.length > 1 && kindOf(el) === 'check' ? 'multi' : kindOf(el);
    const field = {
      label: tidyLabel(labelOf(el, members)),
      selector: groupSelector(el, members),
      kind,
      frame: FRAME,
      required: members.some((m) => m.required || m.getAttribute('aria-required') === 'true'),
      hint: el.getAttribute('name') || el.id || '',
    };
    if (el.tagName === 'SELECT') {
      field.options = [...el.options].filter((o) => o.value !== '' && !o.disabled).slice(0, 500)
        .map((o) => ({ value: o.value, text: clean(o.textContent) || o.value }));
      field.current = el.multiple ? [...el.selectedOptions].map((o) => o.value).filter(Boolean) : el.value;
      field.empty = !field.current.length;
    } else if (kind === 'radio' || kind === 'multi') {
      field.options = members.map((m) => ({ value: m.value || '', text: optionText(m) }));
      // Radios that all post "on", or share a value, can only be told apart by their caption.
      const values = field.options.map((o) => o.value);
      if (values.some((v) => !v || v === 'on') || new Set(values).size < values.length) field.options.forEach((o) => { o.value = o.text; });
      const on = field.options.filter((_, i) => isChecked(members[i])).map((o) => o.value);
      field.current = kind === 'radio' ? on[0] || '' : on;
      field.empty = !on.length;
    } else if (kind === 'check') {
      field.current = isChecked(el) ? 'true' : '';
      field.empty = !field.current;
    } else if (kind === 'text') {
      field.inputType = el.tagName === 'INPUT' ? el.type : 'text';
      field.multiline = el.tagName !== 'INPUT';
      const text = 'value' in el ? el.value : clean(el.innerText);
      // Passwords are never read back, but whether one has been typed is still reported.
      field.current = field.inputType === 'password' ? '' : text;
      field.empty = !text;
    }
    return field;
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const SCROLL_TIME_LIMIT = 20000;   // ms a scrolling scan may run in one frame

  // With `scroll`, the page is scrolled from top to bottom first, so fields that are only loaded
  // or revealed when they come into view are found as well. See scrollThrough for the safeguards.
  async function scan({ includeHidden, scroll } = {}) {
    const seen = new Set();
    const found = [];
    // Adds the fields that are on the page right now and have not been recorded yet.
    const sweep = () => {
      const visited = new Set();
      for (const el of deepAll(document, CANDIDATES)) {
        if (seen.has(el) || visited.has(el) || !isField(el) || el.parentElement?.isContentEditable) continue;
        const members = groupOf(el);
        members.forEach((m) => visited.add(m));
        if (!includeHidden && !members.some(isVisible)) continue;
        members.forEach((m) => seen.add(m));
        found.push({ el, field: describe(el, members) });
      }
    };
    sweep();
    const stopped = scroll ? await scrollThrough(sweep) : '';
    // Page order, whatever order the scrolling turned them up in. Fields the page has since removed go last.
    const inPage = found.filter((x) => x.el.isConnected)
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const fields = [...inPage, ...found.filter((x) => !x.el.isConnected)].map((x) => x.field);
    // Two fields sharing a caption (e.g. salutation + first name in one cell) get their name appended.
    const count = {};
    for (const f of fields) count[f.label] = (count[f.label] || 0) + 1;
    for (const f of fields) {
      if (count[f.label] > 1 && f.hint) f.label += ` (${f.hint})`;
      delete f.hint;
    }
    return { frame: FRAME, fields, stopped };
  }

  // The window, plus any large panes inside the page that scroll on their own.
  function scrollers() {
    const inner = deepAll(document, 'div,main,section,article,form,ul,table,tbody').filter((el) => {
      if (el.scrollHeight < el.clientHeight + 150 || el.clientHeight < 200) return false;
      return /auto|scroll/.test(getComputedStyle(el).overflowY);
    });
    return [document.scrollingElement, ...inner.sort((a, b) => b.clientHeight - a.clientHeight).slice(0, 5)].filter(Boolean);
  }

  // Scrolls each pane from top to bottom, calling `sweep` at every stop. It only ever scrolls: it
  // never clicks, types or follows links. It gives the page back the moment the person touches the
  // mouse, wheel, keyboard or screen, when Stop is pressed in the panel, after SCROLL_TIME_LIMIT, or
  // when a page keeps growing as it is scrolled (an endless feed). Unless the person took over, every pane is put back
  // where it was. Returns why it stopped early: 'user', 'panel', 'time', 'endless', or '' if it finished.
  async function scrollThrough(sweep) {
    window.__powerfillStop = false;
    let reason = '';
    const takeOver = (e) => {
      reason ||= 'user';
      if (e.type === 'keydown' && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const signals = ['wheel', 'mousedown', 'touchstart', 'keydown'];
    signals.forEach((type) => window.addEventListener(type, takeOver, { capture: true, passive: type !== 'keydown' }));
    const banner = FRAME === 'top' ? document.createElement('div') : null;
    if (banner) {
      banner.id = 'powerfill-scanning';
      banner.textContent = 'PowerFill is scrolling to find every field. Press Esc or click anywhere to stop.';
      banner.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);pointer-events:none;'
        + 'padding:8px 14px;border-radius:999px;background:#172033;color:#fff;font:13px/1.3 system-ui,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);white-space:nowrap';
      document.documentElement.append(banner);
    }
    const deadline = Date.now() + SCROLL_TIME_LIMIT;
    const halted = () => {
      reason ||= window.__powerfillStop ? 'panel' : Date.now() > deadline ? 'time' : '';
      return !!reason;
    };
    const visited = [];
    try {
      for (const pane of scrollers()) {
        visited.push([pane, pane.scrollTop]);
        const bottom = () => Math.max(0, pane.scrollHeight - pane.clientHeight);
        // Lazy sections make a page a little taller as it is scrolled. A feed makes it taller without
        // end, so once the page is several times its starting height we stop following it.
        const tallest = pane.scrollHeight * 3 + pane.clientHeight * 5;
        for (let top = 0; !halted(); top = Math.min(top + Math.max(200, pane.clientHeight * 0.8), bottom())) {
          pane.scrollTo({ top, behavior: 'instant' });
          await pause(160);
          sweep();
          if (pane.scrollHeight > tallest) { reason ||= 'endless'; break; }
          if (top < bottom()) continue;
          // At the bottom: give lazy content a moment to arrive, then see whether the page grew.
          const before = bottom();
          await pause(350);
          sweep();
          if (bottom() <= before) break;
        }
        if (reason) break;
      }
    } finally {
      signals.forEach((type) => window.removeEventListener(type, takeOver, { capture: true }));
      banner?.remove();
      if (reason !== 'user') for (const [pane, top] of visited) pane.scrollTo({ top, behavior: 'instant' });
    }
    return reason;
  }

  // Asks a scrolling scan in this frame to stop. Called through a fresh injection of the engine,
  // so the request travels on `window`.
  function stopScan() {
    window.__powerfillStop = true;
    return { frame: FRAME };
  }

  // ---------- fill ----------

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const done = (el) => ({ status: 'filled', el });
  const fail = (detail, status = 'error') => ({ status, detail });

  // Full pointer sequence, for custom widgets that open on mousedown / pointerdown rather than click.
  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
    el.click();
  }

  function setChecked(el, want) {
    if (isChecked(el) === want) return;
    if (el.tagName === 'INPUT') el.click(); else press(el);
  }

  function formatDate(date, format) {
    const pad = (n) => String(n).padStart(2, '0');
    const parts = { yyyy: date.getFullYear(), yy: pad(date.getFullYear() % 100), mm: pad(date.getMonth() + 1), m: date.getMonth() + 1, dd: pad(date.getDate()), d: date.getDate() };
    return format.replace(/yyyy|yy|mm|m|dd|d/gi, (token) => parts[token.toLowerCase()]);
  }

  // {{clear}} empties the field. {{today}}, {{today+7}}, {{today:dd/mm/yyyy}} insert a date,
  // defaulting to the format the field itself declares (vtiger: data-date-format).
  function expand(value, el) {
    return value.replace(/\{\{\s*clear\s*\}\}/gi, '').replace(/\{\{\s*today\s*([+-]\s*\d+)?\s*(?::\s*([^}]+?))?\s*\}\}/gi, (_, shift, format) => {
      const date = new Date();
      if (shift) date.setDate(date.getDate() + Number(shift.replace(/\s/g, '')));
      return formatDate(date, format || el.dataset?.dateFormat || 'yyyy-mm-dd');
    });
  }

  // Puts text into an <input> / <textarea> and tells the page about it the way typing would.
  function setText(el, value) {
    // The prototype setter bypasses React/Vue value tracking, so their change handlers still run.
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    fire(el, 'change');
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // What the page thinks of the value it was just given: too long, wrong email format, and so on.
  function complaint(el, value) {
    if (el.maxLength > 0 && value.length > el.maxLength) return `Longer than the ${el.maxLength} characters this field allows`;
    if (el.validity && !el.validity.valid && !el.validity.valueMissing) return el.validationMessage;
    return el.getAttribute('aria-invalid') === 'true' ? 'The page marked this value as invalid' : '';
  }

  function fillText(el, value) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      // Rich-text editors only notice edits that come through the editing pipeline.
      el.focus();
      getSelection().selectAllChildren(el);
      if (!document.execCommand('insertText', false, value)) {
        el.textContent = value;
        fire(el, 'input');
      }
      return done(el);
    }
    if (el.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = new Date(value);
      if (!isNaN(parsed)) value = formatDate(parsed, 'yyyy-mm-dd');
    }
    setText(el, value);
    if (value !== '' && el.value === '') return fail(`This ${el.type} field does not accept “${value}”`);
    const problem = value === '' ? '' : complaint(el, value);
    return problem ? { status: 'warn', detail: problem, el } : done(el);
  }

  function matchOption(options, wanted) {
    const w = norm(wanted);
    return options.find((o) => o.value === wanted) || options.find((o) => norm(o.textContent) === w) ||
      options.find((o) => norm(o.value) === w) || (w && options.find((o) => norm(o.textContent).startsWith(w))) ||
      (w && options.find((o) => norm(o.textContent).includes(w))) || null;
  }

  function fillSelect(el, value) {
    const options = [...el.options];
    let missing = [];
    if (el.multiple) {
      const wanted = asList(value);
      const hits = wanted.map((w) => matchOption(options, w));
      missing = wanted.filter((_, i) => !hits[i]);
      options.forEach((o) => { o.selected = hits.includes(o); });
    } else {
      const wanted = expand(asText(value), el);
      const hit = matchOption(options, wanted);
      if (!hit) return fail(`No option “${wanted}” in this list`, 'nooption');
      hit.selected = true;
    }
    announceSelect(el);
    return missing.length ? fail(`No option “${missing.join('”, “')}” in this list`, 'nooption') : done(el);
  }

  // Tells the page, and any dropdown widget drawn over the <select>, that the selection changed.
  function announceSelect(el) {
    fire(el, 'input');
    fire(el, 'change');
    // Chosen needs to be told; Select2 follows the change event, with a manual repaint as a safety net.
    el.dispatchEvent(new Event('chosen:updated'));
    el.dispatchEvent(new Event('liszt:updated'));
    const shown = !el.multiple && widgetOf(el)?.querySelector('.select2-chosen');
    const text = clean(el.selectedOptions[0]?.textContent);
    if (shown && clean(shown.textContent) !== text) {
      shown.textContent = text;
      shown.closest('.select2-default')?.classList.remove('select2-default');
    }
  }

  // Radio groups pick one member; checkbox groups end up with exactly the listed members ticked.
  function fillChoice(members, wanted, single) {
    const want = wanted.map(norm);
    const hits = new Set();
    for (const m of members) {
      const key = [norm(m.value), norm(optionText(m))].find((k) => k && want.includes(k));
      if (key) hits.add(key);
      if (key) setChecked(m, true); else if (!single) setChecked(m, false);
      if (key && single) break;
    }
    const missing = wanted.filter((w) => !hits.has(norm(w)));
    return missing.length ? fail(`No option “${missing.join('”, “')}” here`, 'nooption') : done(members[0]);
  }

  // Best effort for custom dropdowns (MUI, Radix, Ant...): open it, then click the matching option.
  async function fillCombo(el, value) {
    const OPTIONS = '[role="option"],[role="listbox"] li,[role="menuitem"]';
    press(el);
    const want = norm(value);
    for (let waited = 0; waited <= 1500; waited += 100) {
      const options = deepAll(document, OPTIONS).filter(rendered);
      const hit = options.find((o) => norm(o.textContent) === want) || options.find((o) => norm(o.textContent).startsWith(want));
      if (hit) { press(hit); return done(el); }
      await new Promise((r) => setTimeout(r, 100));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return fail(`No option “${value}” appeared`, 'nooption');
  }

  async function fillOne(f) {
    const els = fieldsFor(f.selector);
    if (!els.length) return { status: 'notfound' };
    const el = els[0];
    const kind = kindOf(el);
    if (!kind) return fail(`<${el.tagName.toLowerCase()}> is not a fillable field`);
    if (el.disabled) return fail('This field is disabled on the page');
    const members = els.length > 1 ? els : groupOf(el);
    const flag = Array.isArray(f.value) ? undefined : YES.has(norm(f.value)) ? true : NO.has(norm(f.value)) ? false : undefined;
    const restore = snapshot(el, kind === 'check' && flag !== undefined ? els : members);
    if (restore) window.__powerfillUndo.push(restore);
    let result;
    if (el.tagName === 'SELECT') result = fillSelect(el, f.value);
    else if (kind === 'check' && flag !== undefined) { els.forEach((e) => setChecked(e, flag)); result = done(el); }
    else if (kind === 'check' && members.length === 1) result = fail(`A tick box needs yes or no, not “${asText(f.value)}”`);
    else if (kind === 'check') result = fillChoice(members, asList(f.value), false);
    else if (kind === 'radio' && flag === true && members.length === 1) { setChecked(el, true); result = done(el); }
    else if (kind === 'radio') result = fillChoice(members, [asText(f.value)], true);
    else if (kind === 'combo') result = await fillCombo(el, asText(f.value));
    else result = fillText(el, expand(asText(f.value), el));
    if (result.el) flash(result.el, result.status === 'warn' ? WARN_COLOR : OK_COLOR);
    return { status: result.status, detail: result.detail };
  }

  // Captures how a field looks now and returns a function that puts it back.
  function snapshot(el, members) {
    const kind = kindOf(el);
    if (el.tagName === 'SELECT') {
      const before = [...el.options].map((o) => o.selected);
      return () => {
        [...el.options].forEach((o, i) => { o.selected = !!before[i]; });
        announceSelect(el);
      };
    }
    if (kind === 'check' || kind === 'radio') {
      const before = members.map(isChecked);
      return () => members.forEach((m, i) => {
        if (isChecked(m) === before[i]) return;
        if (before[i] || kind === 'check') return setChecked(m, before[i]);
        // A radio can't be clicked off; this group had nothing chosen before the fill.
        m.checked = false;
        fire(m, 'change');
      });
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const before = el.value;
      return () => setText(el, before);
    }
    if (kind === 'text') {
      const before = el.innerHTML;
      return () => { el.innerHTML = before; fire(el, 'input'); };
    }
    return null;
  }

  // Puts back everything the last fill changed in this frame. The list lives on `window`
  // because the engine is injected afresh for every call.
  function undo() {
    const steps = window.__powerfillUndo || [];
    window.__powerfillUndo = [];
    for (const restore of steps.reverse()) {
      try { restore(); } catch { /* the element has gone; nothing to put back */ }
    }
    return { frame: FRAME, undone: steps.length };
  }

  // `keepUndo` is set when a second pass retries fields in other frames as part of the same fill.
  async function fill({ fields, keepUndo }) {
    if (!keepUndo || !window.__powerfillUndo) window.__powerfillUndo = [];
    const results = [];
    for (const f of fields) {
      if (f.frame && f.frame !== 'any' && f.frame !== FRAME) { results.push({ id: f.id, status: 'otherframe' }); continue; }
      try { results.push({ id: f.id, ...(await fillOne(f)) }); }
      catch (e) { results.push({ id: f.id, status: 'error', detail: String(e?.message || e) }); }
    }
    return results;
  }

  // ---------- highlight + picker ----------

  const flashing = new WeakMap();

  // A hidden <select> or checkbox is shown through its visible stand-in.
  const visibleProxy = (el) => (rendered(el) ? el : widgetOf(el) || el.labels?.[0] || el.parentElement || el);

  function flash(el, color) {
    const target = visibleProxy(el);
    if (!flashing.has(target)) flashing.set(target, [target.style.outline, target.style.outlineOffset]);
    target.style.outline = `2px solid ${color}`;
    target.style.outlineOffset = '1px';
    clearTimeout(target.__pfTimer);
    target.__pfTimer = setTimeout(() => {
      [target.style.outline, target.style.outlineOffset] = flashing.get(target);
      flashing.delete(target);
    }, 1500);
  }

  // Shows where a selector points and reports what kind of field it is.
  function highlight({ selector, quiet }) {
    const els = fieldsFor(selector);
    if (!els.length) return { frame: FRAME, count: 0 };
    if (!quiet) {
      visibleProxy(els[0]).scrollIntoView({ block: 'center', behavior: 'smooth' });
      els.forEach((el) => flash(el, PICK_COLOR));
    }
    const field = kindOf(els[0]) ? describe(els[0]) : null;
    return { frame: FRAME, count: els.length, field };
  }

  let stopPicking = null;

  function stopPicker() {
    stopPicking?.();
    stopPicking = null;
  }

  // Lets the user click a field on the page instead of copying a selector out of DevTools.
  function startPicker() {
    stopPicker();
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid ${PICK_COLOR};background:rgba(18,115,196,.15);border-radius:3px`;
    document.documentElement.appendChild(box);
    const send = (msg) => globalThis.chrome?.runtime?.sendMessage?.(msg)?.catch?.(() => {});
    const targetOf = (e) => {
      const first = e.composedPath()[0];
      return toField(first instanceof Element ? first : e.target);
    };
    const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const handlers = {
      mousemove(e) {
        const r = visibleProxy(targetOf(e)).getBoundingClientRect();
        Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      },
      click(e) {
        block(e);
        const el = targetOf(e);
        stopPicker();
        send({ type: 'pf-picked', field: kindOf(el) ? describe(el) : { selector: selectorFor(el), label: '', kind: 'text', frame: FRAME } });
      },
      keydown(e) {
        if (e.key !== 'Escape') return;
        block(e);
        stopPicker();
        send({ type: 'pf-pick-cancel' });
      },
      mousedown: block, mouseup: block, pointerdown: block, pointerup: block,
    };
    for (const [type, fn] of Object.entries(handlers)) window.addEventListener(type, fn, true);
    stopPicking = () => {
      for (const [type, fn] of Object.entries(handlers)) window.removeEventListener(type, fn, true);
      box.remove();
    };
  }

  // ---------- prompt ----------

  const ASK_CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: start center;
      padding-top: 12vh; background: rgb(15 23 42 / .45); font: 14px/1.4 system-ui, "Segoe UI", sans-serif; }
    form { width: min(360px, 90vw); padding: 18px; background: #fff; color: #1c2330; border-radius: 12px;
      box-shadow: 0 20px 50px rgb(0 0 0 / .35); display: grid; gap: 12px; }
    h1 { margin: 0; font-size: 15px; }
    label { display: grid; gap: 4px; font-size: 12px; font-weight: 600; color: #667085; }
    input { font: inherit; color: #1c2330; padding: 8px 10px; border: 1px solid #c9d0db; border-radius: 6px; }
    input:focus { outline: 2px solid #1273c4; outline-offset: -1px; }
    footer { display: flex; justify-content: flex-end; gap: 8px; }
    button { font: inherit; padding: 7px 16px; border-radius: 6px; border: 1px solid #c9d0db; background: #fff; color: #1c2330; cursor: pointer; }
    button.go { background: #1273c4; border-color: #1273c4; color: #fff; font-weight: 600; }`;

  // Asks for the {{ask:...}} values on the page itself. Used when a fill is started with the
  // keyboard shortcut, where the side panel may not be open. Resolves to { answers } or { answers: null }.
  // `choices` maps a label to suggestions (recent values, then the picklist's options) offered while typing.
  function ask({ labels, defaults = {}, choices = {} }) {
    if (FRAME !== 'top') return null;
    return new Promise((resolve) => {
      const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
      const host = make('div');
      host.id = 'powerfill-ask';
      const root = host.attachShadow({ mode: 'open' });
      // A constructed stylesheet is not blocked by the page's Content Security Policy.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(ASK_CSS);
      root.adoptedStyleSheets = [sheet];
      const inputs = labels.map((label) => make('input', { name: label, value: defaults[label] ?? '', autocomplete: 'off' }));
      const form = make('form');
      const footer = make('footer');
      const cancel = make('button', { type: 'button', textContent: 'Cancel' });
      footer.append(cancel, make('button', { className: 'go', textContent: 'Fill' }));
      form.append(make('h1', { textContent: 'PowerFill needs a few values' }),
        ...labels.map((label, i) => {
          const row = make('label', { textContent: label });
          row.append(inputs[i]);
          if (choices[label]?.length) {
            const list = make('datalist', { id: 'choices-' + i });
            list.append(...choices[label].map((value) => make('option', { value })));
            inputs[i].setAttribute('list', list.id);
            row.append(list);
          }
          return row;
        }), footer);
      root.append(form);
      const finish = (answers) => { host.remove(); resolve({ answers }); };
      form.addEventListener('submit', (e) => { e.preventDefault(); finish(Object.fromEntries(inputs.map((i) => [i.name, i.value]))); });
      cancel.addEventListener('click', () => finish(null));
      // Keep the page's own shortcuts from firing while the user types an answer.
      host.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') finish(null); });
      document.documentElement.append(host);
      inputs[0].focus();
      inputs[0].select();
    });
  }

  window.__powerfill = { scan, stopScan, fill, undo, highlight, startPicker, stopPicker, ask };
})();
