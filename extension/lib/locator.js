// Turns whatever DevTools' "Copy" menu produced into something the engine can look up.
// Copy selector / XPath / full XPath pass through untouched; JS path and element / outerHTML are converted.

const quote = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function fromJsPath(s) {
  const calls = [...s.matchAll(/querySelector(?:All)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)/g)];
  if (calls.length) {
    // Each .shadowRoot hop becomes one ">>>" step.
    return calls.map(([, q, body]) => {
      try { return q === '"' ? JSON.parse('"' + body + '"') : body.replace(/\\(.)/g, '$1'); }
      catch { return body; }
    }).join(' >>> ');
  }
  const byId = s.match(/getElementById\(\s*["'`]([^"'`]+)/);
  return byId ? '#' + CSS.escape(byId[1]) : null;
}

function fromHtml(s) {
  const root = new DOMParser().parseFromString(s, 'text/html').body;
  const el = root.querySelector('input,select,textarea') || root.firstElementChild;
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (el.id) return '#' + CSS.escape(el.id);
  for (const attr of ['name', 'data-fieldname', 'data-testid', 'data-key', 'aria-label', 'placeholder']) {
    if (el.getAttribute(attr)) return `${tag}[${attr}=${quote(el.getAttribute(attr))}]`;
  }
  return el.classList.length ? tag + [...el.classList].map((c) => '.' + CSS.escape(c)).join('') : null;
}

export function normalizeLocator(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('<')) return fromHtml(s) || s;
  if (/^document\./.test(s)) return fromJsPath(s) || s;
  return s;
}
