import { browser } from 'wxt/browser';
import { isRecord } from './capture-validation';
import { DEFAULT_SETTINGS, type Settings } from './types';

export { DEFAULT_SETTINGS };


function validPatch(value: unknown): Partial<Settings> {
  if (!isRecord(value)) return {};
  const patch: Partial<Settings> = {};
  for (const key of ['address', 'apiKey', 'jevApiKey', 'obsidianVault', 'obsidianFolder', 'transcriptTag'] as const) if (typeof value[key] === 'string') patch[key] = value[key];
  if (typeof value.autoSave === 'boolean') patch.autoSave = value.autoSave;
  if (typeof value.autoAttach === 'boolean') patch.autoAttach = value.autoAttach;
  if (typeof value.autoOpenTranscript === 'boolean') patch.autoOpenTranscript = value.autoOpenTranscript;
  if (value.theme === 'system' || value.theme === 'light' || value.theme === 'dark') patch.theme = value.theme;
  return patch;
}
export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...validPatch(stored.settings) };
}
let pending: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const save = pending.then(async () => {
    const settings = { ...await loadSettings(), ...validPatch(patch) };
    await browser.storage.local.set({ settings });
    return settings;
  });
  pending = save.catch(() => undefined);
  return save;
}
