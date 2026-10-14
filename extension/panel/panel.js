// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Entry point of the side panel: loads the views and keeps the panel in step with the active tab.

import './home.js';
import './details.js';
import { endPick } from './editor.js';
import { $, icon, guard } from './dom.js';
import { state, nav, syncTab } from './state.js';
import { listVars, getSettings, listRecents } from '../lib/store.js';

$('#detailsBtn').append(icon('user', 16));
$('#detailsBtn').onclick = guard(() => nav.details());

chrome.tabs.onActivated.addListener(() => syncTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== state.tab?.id) return;
  // A page that is loading again has lost what was filled, so the last report (and its Undo) no longer applies.
  if (info.status === 'loading') state.runs = {};
  if (info.url || info.title || info.status) syncTab();
});
// Profiles change behind the panel's back when a fill is run with the keyboard shortcut.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.recents) state.recents = changes.recents.newValue || {};
  if (changes.profiles && state.view === 'home' && !state.busy) nav.home();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) endPick();
});

guard(async () => {
  [state.vars, state.settings, state.recents] = await Promise.all([listVars(), getSettings(), listRecents()]);
  await nav.home();
})();
