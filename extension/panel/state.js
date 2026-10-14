// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// What the panel currently knows, and which tab it is working on.

export const state = {
  tab: null,
  view: 'home',        // 'home' | 'editor' | 'details'
  profiles: [],
  vars: [],            // My details: [{ key, value }]
  settings: { showSelectors: true, scrollScan: false },
  recents: {},         // values last chosen per field of a site, see lib/store.js
  includeHidden: false,
  scanning: false,     // a scrolling scan is under way
  runs: {},            // last fill report per profile id, shown on the home cards
  busy: false,         // a fill or undo started from the home view is in progress
  othersOpen: false,   // the "Other profiles" list on the home view is expanded

  draft: null,         // the profile open in the editor
  dirty: false,
  pane: 'fields',      // editor tab: 'fields' | 'data'
  results: {},         // last fill result per field id, shown on the rows
  report: null,        // last fill report in the editor
  picking: null,       // id of the row waiting for a click on the page
  filter: '',
};

// Each view registers how to show itself here, so views can open one another without importing each other.
export const nav = {};

// panel.html?tabId=123 binds the panel to one tab, so it can also be opened as an ordinary page.
const boundTab = Number(new URLSearchParams(location.search).get('tabId'));

export const canRun = (tab) => /^(https?|file):/.test(tab?.url || '');

export async function currentTab() {
  state.tab = boundTab ? await chrome.tabs.get(boundTab) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return state.tab;
}

// Called when the user switches tab or the page navigates.
export async function syncTab() {
  const before = state.tab?.url;
  const tab = await currentTab().catch(() => null);
  if (tab?.url !== before) state.runs = {};
  if (state.view === 'home') nav.home?.({ reload: false });
}
