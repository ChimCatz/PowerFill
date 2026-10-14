// URL patterns decide which profiles are offered on which page.
// "https://site.com/leads/*/edit?module=Leads" means: that path (* matches anything) and the page's
// query string must contain module=Leads. Extra query parameters on the page are ignored.

const looksLikeId = (s) => /^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s);

export function suggestPattern(url) {
  const u = new URL(url);
  const path = u.pathname.split('/').map((seg) => (looksLikeId(seg) ? '*' : seg)).join('/');
  // Keep query parameters that name a screen (module=Leads, view=Edit); drop record ids and tokens.
  const keep = [...u.searchParams].filter(([, v]) => v && v.length <= 30 && !/\d/.test(v));
  const query = keep.map(([k, v]) => `${k}=${v}`).join('&');
  return u.origin + path + (query ? '?' + query : '');
}

export function matchesUrl(pattern, url) {
  if (!pattern || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const [base, query = ''] = pattern.trim().split('?');
  const escaped = base.replace(/\/+$/, '').split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const target = (u.origin + u.pathname).replace(/\/+$/, '');
  if (!new RegExp('^' + escaped + '$', 'i').test(target)) return false;
  for (const [k, v] of new URLSearchParams(query)) {
    if (v === '*' ? !u.searchParams.has(k) : u.searchParams.get(k) !== v) return false;
  }
  return true;
}
