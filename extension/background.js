import { listProfiles, markUsed } from './lib/store.js';
import { matchesUrl } from './lib/url.js';
import { fillTab } from './lib/runner.js';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function badge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
}

// Keyboard shortcut: fill with the profile for this page that was used most recently.
// The badge shows how many fields were filled, with "!" if some were not.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-page' || !tab?.id) return;
  const matching = (await listProfiles())
    .filter((p) => matchesUrl(p.urlPattern, tab.url))
    .sort((a, b) => (b.lastUsed || b.updatedAt || 0) - (a.lastUsed || a.updatedAt || 0));
  if (!matching.length) return badge(tab.id, '?', '#b45309');
  try {
    const { filled, failed } = await fillTab(tab.id, matching[0].fields);
    await markUsed(matching[0].id);
    badge(tab.id, failed ? `${filled}!` : String(filled), failed ? '#b45309' : '#15803d');
  } catch {
    badge(tab.id, 'ERR', '#b91c1c');
  }
});
