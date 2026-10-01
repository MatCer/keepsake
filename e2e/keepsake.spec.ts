import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHAPTERS, SEGMENTS, TEXT, watchPage } from './fixture';

const EXT = path.resolve('.output-e2e/chrome-mv3');
const EXT_ID = 'hllnpofcacphnggifnlhkikkedipacjk';
type ChromeApi = {
  tabs: { query: (q: object) => Promise<{ id?: number; url?: string }[]> };
  storage: { local: { set: (v: object) => Promise<void>; get: (k: string) => Promise<Record<string, unknown>> } };
};
declare const chrome: ChromeApi;

const env: Record<string, string> = Object.fromEntries(
  readFileSync('.karakeep-local/env', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('=', 2) as [string, string]),
);
const KK = env.KARAKEEP_ADDR!;
const KEY = env.KARAKEEP_API_KEY!;
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${KK}/api/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
  return r.status === 204 ? null : r.json();
};

/** Anything a transcript fetch could hit: YouTube hosts and CDNs, or caption/innertube paths anywhere. */
const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|googleapis\.com)$/;
const isYoutube = (raw: string) => {
  const u = new URL(raw);
  return YOUTUBE_HOST.test(u.hostname) || /timedtext|youtubei|get_transcript/.test(u.pathname);
};

let ctx: BrowserContext;
const blocked: string[] = [];
const cdpLog: { tab: string; url: string }[] = [];

async function watchNetwork(page: Page, tab: string) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => cdpLog.push({ tab, url: e.request.url }));
}

async function openVideo(id: string, panel: 'open' | 'closed') {
  const yt = await ctx.newPage();
  await watchNetwork(yt, 'youtube');
  await yt.goto(`https://www.youtube.com/watch?v=${id}`);
  await expect(yt.locator('ytd-watch-flexy')).toHaveAttribute('video-id', id);
  cdpLog.length = 0; // the user's own page load is not the extension's doing
  blocked.length = 0;
  return yt;
}

async function openPopup(id: string) {
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${EXT_ID}/options.html`);
  const tabId = await helper.evaluate(
    async (vid) => (await chrome.tabs.query({})).find((t) => t.url?.includes(vid))?.id,
    id,
  );
  await helper.close();
  const popup = await ctx.newPage();
  await watchNetwork(popup, 'popup');
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tabId=${tabId}`);
  return popup;
}

const SETTINGS = { address: KK, apiKey: KEY, autoSave: true, autoAttach: false, autoOpenTranscript: false, theme: 'system', obsidianVault: '', obsidianFolder: 'Clippings', transcriptTag: '' };

function youtubeTraffic() {
  return [...cdpLog.filter((r) => isYoutube(r.url)).map((r) => `${r.tab}: ${r.url}`), ...blocked.filter(isYoutube)];
}

test.beforeAll(async () => {
  // Fresh Karakeep state for the local test user only.
  for (;;) {
    const { bookmarks } = await api('GET', '/bookmarks?limit=100');
    if (!bookmarks.length) break;
    for (const b of bookmarks) await api('DELETE', `/bookmarks/${b.id}`);
  }
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    const m = url.match(/^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/);
    if (m && route.request().resourceType() === 'document') {
      return route.fulfill({ contentType: 'text/html', body: watchPage(m[1]!, m[1]!.includes('Shut') ? 'closed' : 'open') });
    }
    if (url.startsWith('https://example.org/article')) {
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><head><title>Fixture article</title></head><body><article><h1>Fixture article</h1><p>First paragraph with <b>bold</b> text, long enough to count as readable content for the extractor to keep.</p><p>Second paragraph that adds some more words so the page is not considered empty.</p></article></body></html>',
      });
    }
    if (url.startsWith(KK) || url.startsWith('chrome-extension://')) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${EXT_ID}/options.html`);
  await opts.evaluate(
    (s) => chrome.storage.local.set({ settings: s }),
    SETTINGS,
  );
  await opts.close();
});

test.afterAll(async () => ctx?.close());

test('rendered transcript panel: captured with zero YouTube requests', async () => {
  const yt = await openVideo('KsTestOpen1', 'open');
  const popup = await openPopup('KsTestOpen1');
  await expect(popup.getByText('Transcript captured')).toBeVisible();
  await expect(popup.getByText(`${SEGMENTS.length} segments`)).toBeVisible();
  await expect(popup.getByText('**0:31** ·', { exact: false })).toBeVisible();
  await popup.waitForTimeout(1000); // let any late request surface
  expect(youtubeTraffic()).toEqual([]);
  expect(cdpLog.filter((r) => r.tab === 'youtube')).toEqual([]);
  expect(cdpLog.filter((r) => r.tab === 'popup' && !r.url.startsWith(KK) && !r.url.startsWith('chrome-extension://') && !r.url.startsWith('data:') && !r.url.startsWith('blob:'))).toEqual([]);
  await popup.close();
  await yt.close();
});

test('transcript panel not opened: instruction, no transcript, zero YouTube requests', async () => {
  const yt = await openVideo('KsTestShut1', 'closed');
  const popup = await openPopup('KsTestShut1');
  await expect(popup.getByText('Open the transcript first')).toBeVisible();
  await expect(popup.getByRole('button', { name: /Attach transcript/ })).toHaveCount(0);
  await popup.waitForTimeout(1000);
  expect(youtubeTraffic()).toEqual([]);
  const { bookmarkId } = await api('GET', `/bookmarks/check-url?url=${encodeURIComponent('https://www.youtube.com/watch?v=KsTestShut1')}`);
  if (bookmarkId) expect((await api('GET', `/bookmarks/${bookmarkId}`)).assets).toEqual([]);
  await popup.close();
  await yt.close();
});

test('end to end: attach to Karakeep; retries keep data intact', async () => {
  const url = 'https://www.youtube.com/watch?v=KsTestOpen1';
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  // A bookmark that existed before clipping, with user data that must survive.
  // (The earlier test's auto-save may already have created it; POST then returns it unchanged.)
  const pre = await api('POST', '/bookmarks', { type: 'link', url });
  await api('PATCH', `/bookmarks/${pre.id}`, { note: 'my own note', createdAt: old });
  await api('POST', `/bookmarks/${pre.id}/tags`, { tags: [{ tagName: 'read-later' }, { tagName: 'mine' }] });

  const yt = await openVideo('KsTestOpen1', 'open');
  for (const expected of ['Transcript attached to the bookmark', 'This exact transcript is already attached']) {
    const popup = await openPopup('KsTestOpen1');
    await expect(popup.getByText('Already in Karakeep')).toBeVisible();
    await popup.getByRole('button', { name: /Attach transcript/ }).click();
    await expect(popup.getByText(expected)).toBeVisible();
    await popup.close();
  }
  expect(youtubeTraffic()).toEqual([]);

  const { bookmarkId } = await api('GET', `/bookmarks/check-url?url=${encodeURIComponent(url)}`);
  expect(bookmarkId).toBe(pre.id);
  const all = (await api('GET', '/bookmarks?limit=100')).bookmarks.filter((b: { content: { url?: string } }) => b.content.url === url);
  expect(all).toHaveLength(1);
  const b = await api('GET', `/bookmarks/${pre.id}`);
  expect(b.note).toBe('my own note');
  expect(b.tags.map((t: { name: string }) => t.name).sort()).toEqual(['mine', 'read-later']);
  expect(b.assets).toHaveLength(1);
  expect(b.assets[0].assetType).toBe('userUploaded');
  expect(b.assets[0].fileName).toMatch(/^keepsake-transcript-KsTestOpen1-en-[0-9a-f]{12}\.html$/);

  const html = await (await fetch(`${KK}/api/v1/assets/${b.assets[0].id}`, { headers: { authorization: `Bearer ${KEY}` } })).text();
  const json = html.match(/<script type="application\/json" id="keepsake-capture">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const record = JSON.parse(json);
  expect(record.provenance).toBe('browser-dom');
  expect(record.transcript.segments).toEqual(SEGMENTS.map(({ start, text }) => ({ start, text })));
  expect(record.transcript.chapters).toEqual(CHAPTERS);
  expect(record.transcript.text).toBe(TEXT);
  expect(record.transcript.language).toBe('en');

  await yt.close();
});

test('any page: Markdown capture', async () => {
  const page = await ctx.newPage();
  await page.goto('https://example.org/article');
  const popup = await openPopup('example.org/article');
  await expect(popup.getByText('Page captured')).toBeVisible();
  await expect(popup.locator('pre')).toContainText('First paragraph with **bold** text');
  await popup.close();
  await page.close();
});

test('auto-attach: opening the popup attaches the transcript once, no click', async () => {
  const setAuto = async (autoAttach: boolean) => {
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${EXT_ID}/options.html`);
    await opts.evaluate((s) => chrome.storage.local.set({ settings: s }), { ...SETTINGS, autoAttach });
    await opts.close();
  };
  await setAuto(true);
  const yt = await openVideo('KsTestAuto1', 'open');
  for (const expected of ['Transcript attached to the bookmark', 'This exact transcript is already attached']) {
    const popup = await openPopup('KsTestAuto1');
    await expect(popup.getByText(expected)).toBeVisible();
    await popup.close();
  }
  expect(youtubeTraffic()).toEqual([]);
  const { bookmarkId } = await api('GET', `/bookmarks/check-url?url=${encodeURIComponent('https://www.youtube.com/watch?v=KsTestAuto1')}`);
  const b = await api('GET', `/bookmarks/${bookmarkId}`);
  expect(b.assets).toHaveLength(1);
  expect(b.assets[0].fileName).toMatch(/^keepsake-transcript-KsTestAuto1-en-[0-9a-f]{12}\.html$/);
  await setAuto(false);
  await yt.close();
});

test('list picker and tag suggestions float over the content instead of pushing it down', async () => {
  const names = ['Research', 'Library', 'Entertainment', 'Tech', 'Business', 'Ideas', 'Reading', 'Later'];
  const existing = new Set(((await api('GET', '/lists')).lists as { name: string }[]).map((l) => l.name));
  for (const name of names) if (!existing.has(name)) await api('POST', '/lists', { name, icon: '📁' });
  // Tags exist in Karakeep once any bookmark carries them.
  const holder = await api('POST', '/bookmarks', { type: 'link', url: 'https://example.org/tag-holder' });
  await api('POST', `/bookmarks/${holder.id}/tags`, { tags: ['reading', 'react', 'research'].map((tagName) => ({ tagName })) });

  const page = await ctx.newPage();
  await page.goto('https://example.org/article');
  const popup = await openPopup('example.org/article');
  const note = popup.getByLabel('Note');
  await expect(note).toBeVisible();
  const before = await note.boundingBox();
  const shell = popup.locator('div.w-\\[400px\\]');
  await popup.evaluate(() => document.documentElement.classList.add('dark'));

  await popup.getByRole('button', { name: 'Add to list…' }).click();
  const lists = popup.getByRole('dialog', { name: 'Lists' });
  await expect(lists).toBeVisible();
  expect(await note.boundingBox()).toEqual(before);
  await shell.screenshot({ path: 'test-results/popup-lists.png' });
  await lists.getByLabel('Library').check();
  await popup.keyboard.press('Escape');
  await expect(lists).toBeHidden();
  await expect(popup.getByRole('button', { name: /Library/ })).toBeVisible();

  const input = popup.getByRole('combobox', { name: 'Add tag' });
  await input.fill('rea');
  const options = popup.getByRole('listbox', { name: 'Tag suggestions' }).getByRole('option');
  await expect(options).toHaveText(['react', 'reading', 'Createrea']);
  expect(await note.boundingBox()).toEqual(before);
  await shell.screenshot({ path: 'test-results/popup-tags.png' });
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(popup.getByRole('button', { name: 'Remove tag reading' })).toBeVisible();
  await input.fill('brand-new');
  await input.press(',');
  await expect(popup.getByRole('button', { name: 'Remove tag brand-new' })).toBeVisible();

  const { bookmarkId } = await api('GET', `/bookmarks/check-url?url=${encodeURIComponent('https://example.org/article')}`);
  expect(((await api('GET', `/bookmarks/${bookmarkId}/lists`)).lists as { name: string }[]).map((l) => l.name)).toEqual(['Library']);
  await popup.close();
  await page.close();
});

test('settings open inside the popup, show the version, and save', async () => {
  const page = await ctx.newPage();
  await page.goto('https://example.org/article');
  const popup = await openPopup('example.org/article');
  await popup.getByRole('button', { name: 'Settings' }).click();
  await expect(popup.getByText(/^Version \d+\.\d+\.\d+$/)).toBeVisible();
  await expect(popup.getByText('Logged in as')).toBeVisible();
  await popup.evaluate(() => document.documentElement.classList.add('dark'));
  await popup.locator('div.w-\\[400px\\]').screenshot({ path: 'test-results/popup-settings.png' });
  const toggle = popup.getByRole('switch', { name: /Auto-attach transcripts/ });
  await toggle.click(); // saved asynchronously, so check() would see the old state
  await expect(toggle).toBeChecked();
  await popup.getByRole('button', { name: 'Back' }).click();
  await expect(popup.getByText('Page captured')).toBeVisible();
  const saved = await popup.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  expect(saved).toMatchObject({ autoAttach: true });
  await popup.evaluate((s) => chrome.storage.local.set({ settings: s }), SETTINGS);
  await popup.close();
  await page.close();
});

test('closed transcript panel: Keepsake clicks Show transcript itself when the setting is on', async () => {
  const yt = await openVideo('KsTestShut2', 'closed');
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${EXT_ID}/options.html`);
  await opts.evaluate((s) => chrome.storage.local.set({ settings: s }), { ...SETTINGS, autoOpenTranscript: true });
  await opts.close();
  const popup = await openPopup('KsTestShut2');
  await expect(popup.getByText('Transcript captured')).toBeVisible();
  await expect(popup.getByText(`${SEGMENTS.length} segments`)).toBeVisible();
  // Opened for the capture, then closed again: the page looks as before.
  await expect(yt.locator('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]')).toHaveCount(0);
  // The fixture's button makes no request; the extension itself must not either.
  expect(youtubeTraffic()).toEqual([]);
  const opts2 = await ctx.newPage();
  await opts2.goto(`chrome-extension://${EXT_ID}/options.html`);
  await opts2.evaluate((s) => chrome.storage.local.set({ settings: s }), SETTINGS);
  await opts2.close();
  await popup.close();
  await yt.close();
});
