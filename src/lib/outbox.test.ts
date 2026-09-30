import { beforeEach, expect, test, vi } from 'vitest';
import { capture } from './__fixtures__/capture';
const { storage } = vi.hoisted(() => { const storage: Record<string, unknown> = {}; return { storage }; });
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async (key: string) => ({ [key]: storage[key] }),
  set: async (value: Record<string, unknown>) => { Object.assign(storage, value); },
} } } }));
import { listOutbox, addToOutbox, removeFromOutbox, type OutboxItem } from './outbox';
function item(id = 'first'): OutboxItem { return { id, createdAt: '2026-09-30T12:00:00Z', bookmarkUrl: capture().url, capture: capture(), lastError: 'Upload failed', attempts: 1 }; }
beforeEach(() => { for (const key of Object.keys(storage)) delete storage[key]; });
test('persists, deduplicates by video/hash and removes', async () => {
  expect(await listOutbox()).toEqual([]);
  await addToOutbox(item()); await addToOutbox(item('duplicate'));
  expect(await listOutbox()).toEqual([{ ...item(), attempts: 2 }]);
  await removeFromOutbox('first'); expect(await listOutbox()).toEqual([]);
});
test('caps at 20 dropping oldest but keeps newly added old item', async () => {
  for (let i = 0; i < 21; i++) { const entry = item(String(i)); entry.capture.transcript.sha256 = i.toString(16).padStart(64, '0'); entry.createdAt = new Date(Date.UTC(2026, 8, i + 1)).toISOString(); await addToOutbox(entry); }
  expect(await listOutbox()).toHaveLength(20); expect((await listOutbox()).some(i => i.id === '0')).toBe(false);
  const old = item('old'); old.createdAt = '2020-01-01T00:00:00Z'; await addToOutbox(old);
  expect(await listOutbox()).toHaveLength(20); expect((await listOutbox()).some(i => i.id === 'old')).toBe(true);
});
test('concurrent writes survive and corrupt storage is ignored', async () => {
  storage.outbox = [{ capture: null }, null, 'bad']; expect(await listOutbox()).toEqual([]);
  const next = item('second'); next.capture.transcript.sha256 = 'b'.repeat(64);
  await Promise.all([addToOutbox(item()), addToOutbox(next)]); expect(await listOutbox()).toHaveLength(2);
});
