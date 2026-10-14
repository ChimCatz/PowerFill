// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Everything is kept in chrome.storage.local on this PC:
//   profiles  [{ id, name, urlPattern, fields: [{ id, label, selector, kind, value, enabled, ... }],
//               data: { columns, rows, cursor }, answers, updatedAt, lastUsed }]
//   vars      [{ key, value }]   the person's own "My details", used as {{my.key}}
//   settings  { showSelectors }

export const newId = () => crypto.randomUUID();

async function read(key, fallback) {
  const { [key]: value = fallback } = await chrome.storage.local.get(key);
  return value;
}

const write = (key, value) => chrome.storage.local.set({ [key]: value });

export const listProfiles = () => read('profiles', []);

export async function saveProfile(profile) {
  const profiles = await listProfiles();
  const at = profiles.findIndex((p) => p.id === profile.id);
  if (at >= 0) profiles[at] = profile; else profiles.push(profile);
  await write('profiles', profiles);
}

export async function deleteProfile(id) {
  await write('profiles', (await listProfiles()).filter((p) => p.id !== id));
}

// Changes a few properties of a stored profile without touching the rest (cursor, last used...).
export async function patchProfile(id, change) {
  const profiles = await listProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  change(profile);
  await write('profiles', profiles);
}

export const listVars = () => read('vars', []);
export const saveVars = (vars) => write('vars', vars.filter((v) => v.key.trim()));
export const varsMap = async () => Object.fromEntries((await listVars()).map((v) => [v.key.trim(), v.value]));

export const getSettings = async () => ({ showSelectors: true, ...(await read('settings', {})) });
export const saveSettings = (settings) => write('settings', settings);

// Exports carry the field sheet and the column matching, but not the data rows or the answers
// last typed in: those are usually real people's details and should not travel with a profile.
export const exportPayload = (profiles) => ({
  app: 'powerfill',
  version: 2,
  exportedAt: new Date().toISOString(),
  profiles: profiles.map(({ answers, lastUsed, ...p }) => (p.data ? { ...p, data: { columns: p.data.columns, rows: [], cursor: 0 } } : p)),
});

// Accepts an export file or a bare array. A profile with a known id replaces the existing one,
// so re-importing a colleague's updated export updates it rather than duplicating it.
// Data rows already loaded into a profile on this PC are kept.
export async function importProfiles(data) {
  const incoming = (Array.isArray(data) ? data : data?.profiles) || [];
  const valid = incoming.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.fields));
  if (!valid.length) throw new Error('That file has no PowerFill profiles in it.');
  const profiles = await listProfiles();
  for (const p of valid) {
    const profile = { ...p, id: p.id || newId(), fields: p.fields.map((f) => ({ ...f, id: f.id || newId() })) };
    const at = profiles.findIndex((x) => x.id === profile.id);
    if (at < 0) { profiles.push(profile); continue; }
    const mine = profiles[at].data;
    if (mine?.rows.length && !profile.data?.rows.length) profile.data = mine;
    profiles[at] = profile;
  }
  await write('profiles', profiles);
  return valid.length;
}
