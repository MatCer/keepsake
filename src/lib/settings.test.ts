import { beforeEach, expect, test, vi } from 'vitest';
const { storage } = vi.hoisted(() => { const storage: Record<string, unknown> = {}; return { storage }; });
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async (key: string) => ({ [key]: storage[key] }),
  set: async (value: Record<string, unknown>) => { Object.assign(storage, value); },
} } } }));
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
beforeEach(() => { for (const key of Object.keys(storage)) delete storage[key]; });
test('defaults and partial patches preserve valid settings', async () => {
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  await saveSettings({ address: 'https://bookmarks.example', apiKey: 'test-only', autoSave: false, autoAttach: false });
  expect(await saveSettings({ obsidianVault: 'Notes' })).toEqual({ ...DEFAULT_SETTINGS, address: 'https://bookmarks.example', apiKey: 'test-only', autoSave: false, autoAttach: false, obsidianVault: 'Notes' });
});
test('unknown keys and wrong types ignored on load and save', async () => {
  storage.settings = { autoSave: 'yes', autoAttach: 1, apiKey: 42, address: 'https://example.com', unknown: 'omit' };
  expect(await loadSettings()).toEqual({ ...DEFAULT_SETTINGS, address: 'https://example.com' });
  const patch = { obsidianVault: 'Notes', unknown: 'omit' }; await saveSettings(patch);
  expect(storage.settings).not.toHaveProperty('unknown');
});
test('concurrent local patches do not overwrite each other', async () => {
  await Promise.all([saveSettings({ obsidianVault: 'Notes' }), saveSettings({ obsidianFolder: 'Clips' })]);
  expect(await loadSettings()).toMatchObject({ obsidianVault: 'Notes', obsidianFolder: 'Clips' });
});

test('Jev key defaults off and persists only as a valid local setting', async () => {
  expect((await loadSettings()).jevApiKey).toBe('');
  await saveSettings({ jevApiKey: 'test-jev-key' });
  expect((await loadSettings()).jevApiKey).toBe('test-jev-key');
  storage.settings = { jevApiKey: 42 };
  expect((await loadSettings()).jevApiKey).toBe('');
});
