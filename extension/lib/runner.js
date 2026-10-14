// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Runs the page engine inside a tab (all frames), and carries out a whole fill: work out the
// values, fill, check what is still missing, remember enough to undo.

import { saveProfile, patchProfile, varsMap } from './store.js';
import { asksIn, columnsIn, resolveValue } from './template.js';
import { rowObject } from './table.js';

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
    throw new Error('PowerFill can’t reach this page. Reload the page and try again. (' + (e?.message || e) + ')');
  }
}

export async function scanTab(tabId, options) {
  const frames = await callTab(tabId, 'scan', options);
  frames.sort((a, b) => (b.frame === 'top') - (a.frame === 'top'));
  return frames.flatMap((f) => f.fields);
}

export const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v != null && String(v) !== '');
const isActive = (f) => f.enabled !== false && f.selector && hasValue(f.value);

const RANK = { filled: 5, warn: 4, nooption: 3, error: 2, notfound: 1, otherframe: 0 };

function merge(frames) {
  const best = {};
  for (const r of frames.flat()) if (!best[r.id] || RANK[r.status] > RANK[best[r.id].status]) best[r.id] = r;
  return best;
}

// Sends ready-made values to the page. Returns { [fieldId]: { status, detail } }.
async function fillFields(tabId, fields) {
  // Called even with nothing to send, so the page forgets the undo steps of the previous fill.
  const results = merge(await callTab(tabId, 'fill', { fields }));
  // A field whose frame has moved since it was scanned is retried in whichever frame has it.
  const orphans = fields.filter((f) => (results[f.id]?.status ?? 'otherframe') === 'otherframe');
  if (orphans.length) {
    Object.assign(results, merge(await callTab(tabId, 'fill', { fields: orphans.map((f) => ({ ...f, frame: 'any' })), keepUndo: true })));
  }
  for (const f of fields) if (!results[f.id] || results[f.id].status === 'otherframe') results[f.id] = { id: f.id, status: 'notfound' };
  return results;
}

const EXPLAIN = { notfound: 'Not found on this page. Check the selector.' };

// Shows the questions on the page itself; used when there is no side panel to ask in.
export const askOnPage = (tabId) => async (labels, defaults) => (await callTab(tabId, 'ask', { labels, defaults }))[0]?.answers ?? null;

// Fills the page from a profile. `ask(labels, defaults)` must resolve to { label: answer } or null
// to cancel. With `advance`, a profile with data rows moves on to its next row afterwards.
// Returns a report: { outcome: 'filled' | 'cancelled' | 'finished' | 'nothing', filled, problems, missing, row }.
export async function runProfile(tabId, profile, { ask, persist = true, advance = true } = {}) {
  const active = profile.fields.filter(isActive);
  if (!active.length) return { outcome: 'nothing' };

  const data = profile.data?.rows.length ? profile.data : null;
  const usesRows = !!data && columnsIn(active).length > 0;
  const cursor = usesRows ? Math.max(0, data.cursor || 0) : 0;
  if (usesRows && cursor >= data.rows.length) return { outcome: 'finished', row: { count: data.rows.length } };

  const labels = asksIn(active);
  const answers = labels.length ? await ask(labels, profile.answers || {}) : {};
  if (!answers) return { outcome: 'cancelled' };

  const context = { row: data ? rowObject(data, cursor) : null, vars: await varsMap(), answers };
  const results = {};
  const toFill = [];
  for (const f of active) {
    const resolved = resolveValue(f.value, context);
    if (resolved.error) results[f.id] = { status: 'error', detail: resolved.error };
    else if (resolved.empty) results[f.id] = { status: 'skipped' };
    else toFill.push({ id: f.id, selector: f.selector, frame: f.frame, value: resolved.value });
  }
  Object.assign(results, await fillFields(tabId, toFill));

  const problems = active.filter((f) => !['filled', 'skipped'].includes(results[f.id].status))
    .map((f) => ({ id: f.id, label: f.label || f.selector, selector: f.selector, status: results[f.id].status, detail: results[f.id].detail || EXPLAIN[results[f.id].status] }));
  const filled = active.filter((f) => ['filled', 'warn'].includes(results[f.id].status)).length;
  // The pre-save check: anything the page requires that is still blank.
  const missing = (await scanTab(tabId, {})).filter((f) => f.required && f.empty).map((f) => ({ label: f.label, selector: f.selector }));

  profile.lastUsed = Date.now();
  if (labels.length) profile.answers = { ...profile.answers, ...answers };
  if (usesRows && advance) data.cursor = cursor + 1;
  if (persist) await saveProfile(profile);
  await chrome.storage.session.set({ lastFill: { tabId, profileId: persist ? profile.id : null, cursor, moved: usesRows && advance } });

  return { outcome: 'filled', filled, problems, missing, results, row: usesRows ? { index: cursor, count: data.rows.length } : null };
}

// Puts the page back the way it was before the last fill, and steps a data-row profile back to
// the row that fill used. Returns how many fields were restored.
export async function undoFill(tabId) {
  const undone = (await callTab(tabId, 'undo')).reduce((sum, frame) => sum + (frame.undone || 0), 0);
  const { lastFill } = await chrome.storage.session.get('lastFill');
  await chrome.storage.session.remove('lastFill');
  if (undone && lastFill?.tabId === tabId && lastFill.moved && lastFill.profileId) {
    await patchProfile(lastFill.profileId, (p) => { if (p.data) p.data.cursor = lastFill.cursor; });
  }
  return undone;
}
