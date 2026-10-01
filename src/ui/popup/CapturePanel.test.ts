import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { capture } from '../../lib/__fixtures__/capture';
import { DEFAULT_SETTINGS } from '../../lib/types';
import { KarakeepClient, type Bookmark } from '../../lib/karakeep';
import { jevPermissions } from '../../lib/jev';
import { CapturePanel } from './CapturePanel';

const mocks = vi.hoisted(() => ({ contains: vi.fn(), request: vi.fn(), tag: vi.fn(), capture: vi.fn() }));
// The popup only messages the background worker; `tag` stands in for its jevTag run.
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: mocks.contains, request: mocks.request }, runtime: {
  sendMessage: async (message: unknown) => {
    try { return { ok: true, outcome: await mocks.tag(message) }; } catch (e) { return { ok: false, message: (e as Error).message }; }
  },
} } }));
const jevEndpoint = 'https://jev.example.com/v1/systemone';
const JEV_PERMISSIONS = jevPermissions(jevEndpoint);
vi.mock('../run-capture', () => ({ runCapture: mocks.capture }));
let root: Root;
let host: HTMLDivElement;
const changed = vi.fn(async () => {});
const client = new KarakeepClient('https://example.com', 'test-key');
const bookmark: Bookmark = { id: 'bm', title: null, note: null, archived: false, favourited: false, createdAt: '', tags: [], assets: [], content: { type: 'link', url: 'https://example.com' } };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  mocks.contains.mockResolvedValue(true); mocks.request.mockResolvedValue(true);
  mocks.tag.mockResolvedValue({ kind: 'tagged', lists: ['Research > Tech', 'Library > Articles'], topic: 'topic-ai' });
  mocks.capture.mockResolvedValue({ status: 'captured', capture: { ...capture(), kind: 'page', url: 'https://example.com', page: { markdown: 'Text', sha256: 'a'.repeat(64), description: null, author: null, published: null, site: null } } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(key = 'test-jev', saved: Bookmark | null = bookmark) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(CapturePanel, { tabId: 1, tabUrl: 'https://example.com', settings: { ...DEFAULT_SETTINGS, jevApiKey: key, jevEndpoint, jevModel: 'jev-model' }, client, bookmark: saved, onBookmarkChanged: changed }))));
}
test('classifies once under StrictMode and refreshes the bookmark', async () => {
  await render();
  expect(mocks.contains).toHaveBeenCalledWith(JEV_PERMISSIONS);
  expect(mocks.tag).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
  expect(mocks.tag.mock.calls[0]?.[0]).toMatchObject({ type: 'jev-tag', bookmarkId: 'bm' });
  expect(JSON.stringify(mocks.tag.mock.calls[0]?.[0])).not.toContain('test-jev'); // keys stay in the background
  expect(host.textContent).toContain('Jev: Research > Tech · Library > Articles · topic-ai');
  await render(); expect(mocks.tag).toHaveBeenCalledTimes(1);
});
test('waits for host permission and requests it from Allow Jev', async () => {
  mocks.contains.mockResolvedValue(false);
  await render(); expect(mocks.tag).not.toHaveBeenCalled();
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Allow Jev');
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(mocks.request).toHaveBeenCalledWith(JEV_PERMISSIONS);
  expect(mocks.tag).toHaveBeenCalledTimes(1);
});
test('empty key and unsaved bookmarks never classify', async () => {
  await render(''); expect(mocks.contains).not.toHaveBeenCalled(); expect(mocks.tag).not.toHaveBeenCalled();
  await render('test-jev', null); expect(mocks.tag).not.toHaveBeenCalled();
  await render(); expect(mocks.tag).toHaveBeenCalledTimes(1);
});
test('classification failures are visible without hiding capture actions', async () => {
  mocks.tag.mockRejectedValue(new Error('Jev request failed: 503'));
  await render();
  expect(host.textContent).toContain('Jev request failed: 503');
  expect(host.textContent).toContain('Copy'); expect(changed).not.toHaveBeenCalled();
});
test('skipped bookmarks have no Jev status and do not refresh', async () => {
  mocks.tag.mockResolvedValue({ kind: 'skipped' });
  await render(); expect(host.textContent).not.toContain('Jev:'); expect(changed).not.toHaveBeenCalled();
});
