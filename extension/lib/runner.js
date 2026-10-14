// Runs the page engine inside a tab (all frames) and merges what the frames report.

async function exec(tabId, injection) {
  try {
    return await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, ...injection });
  } catch {
    // One frame mid-navigation or showing an error page fails the whole call; fall back to the top frame.
    return chrome.scripting.executeScript({ target: { tabId }, ...injection });
  }
}

// Calls engine[method](arg) in every frame and returns the non-empty answers.
export async function callTab(tabId, method, arg = null) {
  try {
    await exec(tabId, { files: ['content/engine.js'] });
    const frames = await exec(tabId, { func: (m, a) => window.__powerfill?.[m](a) ?? null, args: [method, arg] });
    return frames.map((f) => f.result).filter(Boolean);
  } catch (e) {
    throw new Error('PowerFill can’t access this page. (' + (e?.message || e) + ')');
  }
}

export async function scanTab(tabId, options) {
  const frames = await callTab(tabId, 'scan', options);
  frames.sort((a, b) => (b.frame === 'top') - (a.frame === 'top'));
  return frames.flatMap((f) => f.fields);
}

export const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v != null && String(v) !== '');
const isActive = (f) => f.enabled !== false && f.selector && hasValue(f.value);

const RANK = { filled: 4, nooption: 3, error: 2, notfound: 1, otherframe: 0 };

function merge(frames) {
  const best = {};
  for (const r of frames.flat()) if (!best[r.id] || RANK[r.status] > RANK[best[r.id].status]) best[r.id] = r;
  return best;
}

// Fills every enabled row that has a value. Returns { results: { [fieldId]: { status, detail } }, filled, failed }.
export async function fillTab(tabId, fields) {
  const active = fields.filter(isActive).map(({ id, selector, value, frame }) => ({ id, selector, value, frame }));
  if (!active.length) return { results: {}, filled: 0, failed: 0 };
  const results = merge(await callTab(tabId, 'fill', { fields: active }));
  // A field whose frame has moved since it was scanned is retried in whichever frame has it.
  const orphans = active.filter((f) => (results[f.id]?.status ?? 'otherframe') === 'otherframe');
  if (orphans.length) Object.assign(results, merge(await callTab(tabId, 'fill', { fields: orphans.map((f) => ({ ...f, frame: 'any' })) })));
  for (const f of active) if (!results[f.id] || results[f.id].status === 'otherframe') results[f.id] = { id: f.id, status: 'notfound' };
  const filled = active.filter((f) => results[f.id].status === 'filled').length;
  return { results, filled, failed: active.length - filled };
}
