// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.

import { listProfiles } from './lib/store.js';
import { matchesUrl } from './lib/url.js';
import { runProfile, undoFill, askOnPage } from './lib/runner.js';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const GREEN = '#15803d', AMBER = '#b45309', RED = '#b91c1c';

function badge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
}

// Alt+Shift+F fills with the profile for this page that was used most recently; any {{ask:...}}
// questions are put on the page itself. The badge then shows how many fields were filled, with
// "!" if something needs a look, "?" if no profile matches, "END" when the data rows are used up.
async function fillWithShortcut(tab) {
  const matching = (await listProfiles())
    .filter((p) => matchesUrl(p.urlPattern, tab.url))
    .sort((a, b) => (b.lastUsed || b.updatedAt || 0) - (a.lastUsed || a.updatedAt || 0));
  if (!matching.length) return badge(tab.id, '?', AMBER);
  const report = await runProfile(tab.id, matching[0], { ask: askOnPage(tab.id) });
  if (report.outcome === 'finished') return badge(tab.id, 'END', AMBER);
  if (report.outcome !== 'filled') return;
  const attention = report.problems.length || report.missing.length;
  badge(tab.id, report.filled + (attention ? '!' : ''), attention ? AMBER : GREEN);
}

// Alt+Shift+U puts the page back the way it was before the last fill.
async function undoWithShortcut(tab) {
  const undone = await undoFill(tab.id);
  badge(tab.id, undone ? '↶' : '–', undone ? GREEN : AMBER);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  try {
    if (command === 'fill-page') await fillWithShortcut(tab);
    if (command === 'undo-fill') await undoWithShortcut(tab);
  } catch {
    badge(tab.id, 'ERR', RED);
  }
});
