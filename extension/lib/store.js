// Profiles live in chrome.storage.local as one array. A profile is
// { id, name, urlPattern, fields: [{ id, label, selector, kind, value, enabled, ... }], updatedAt, lastUsed }.
const KEY = 'profiles';

export const newId = () => crypto.randomUUID();

export async function listProfiles() {
  const { [KEY]: profiles = [] } = await chrome.storage.local.get(KEY);
  return profiles;
}

const write = (profiles) => chrome.storage.local.set({ [KEY]: profiles });

export async function saveProfile(profile) {
  const profiles = await listProfiles();
  const at = profiles.findIndex((p) => p.id === profile.id);
  if (at >= 0) profiles[at] = profile; else profiles.push(profile);
  await write(profiles);
}

export async function deleteProfile(id) {
  await write((await listProfiles()).filter((p) => p.id !== id));
}

export async function markUsed(id) {
  const profiles = await listProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  profile.lastUsed = Date.now();
  await write(profiles);
}

export const exportPayload = (profiles) => ({ app: 'powerfill', version: 1, exportedAt: new Date().toISOString(), profiles });

// Accepts an export file or a bare array. A profile with a known id replaces the existing one,
// so re-importing a colleague's updated export updates it rather than duplicating it.
export async function importProfiles(data) {
  const incoming = (Array.isArray(data) ? data : data?.profiles) || [];
  const valid = incoming.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.fields));
  if (!valid.length) throw new Error('No PowerFill profiles found in that file.');
  const profiles = await listProfiles();
  for (const p of valid) {
    const profile = { ...p, id: p.id || newId(), fields: p.fields.map((f) => ({ ...f, id: f.id || newId() })) };
    const at = profiles.findIndex((x) => x.id === profile.id);
    if (at >= 0) profiles[at] = profile; else profiles.push(profile);
  }
  await write(profiles);
  return valid.length;
}
