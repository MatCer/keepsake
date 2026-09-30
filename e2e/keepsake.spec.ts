import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHAPTERS, SEGMENTS, TEXT, watchPage } from './fixture';

const EXT = path.resolve('.output-e2e/chrome-mv3');
const EXT_ID = 'hllnpofcacphnggifnlhkikkedipacjk';
type ChromeApi = {
  tabs: { query: (q: object) => Promise<{ id?: number; url?: string }[]> };
  storage: { local: { set: (v: object) => Promise<void> } };
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
    { address: KK, apiKey: KEY, autoSave: true, theme: 'system', obsidianVault: '', obsidianFolder: 'Clippings', transcriptTag: '' },
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

test('end to end: attach to Karakeep, prefetch skips it and uploads the API fallback there, get reads Karakeep; retries keep data intact', async () => {
  const url = 'https://www.youtube.com/watch?v=KsTestOpen1';
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  // A bookmark that existed before clipping, with user data that must survive.
  // (The earlier test's auto-save may already have created it; POST then returns it unchanged.)
  const pre = await api('POST', '/bookmarks', { type: 'link', url });
  await api('PATCH', `/bookmarks/${pre.id}`, { note: 'my own note', createdAt: old });
  await api('POST', `/bookmarks/${pre.id}/tags`, { tags: [{ tagName: 'janitor-processed' }, { tagName: 'mine' }] });
  // An uncaptured video that the opt-in API fallback should still pick up.
  const other = await api('POST', '/bookmarks', { type: 'link', url: 'https://www.youtube.com/watch?v=KsTestNoCap', createdAt: old });
  await api('POST', `/bookmarks/${other.id}/tags`, { tags: [{ tagName: 'janitor-processed' }] });

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
  expect(b.tags.map((t: { name: string }) => t.name).sort()).toEqual(['janitor-processed', 'mine']);
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

  const report = JSON.parse(
    execFileSync('python3', ['e2e/hermes_e2e.py', KK, KEY, 'KsTestOpen1'], { encoding: 'utf8' }) as string,
  );
  expect(report.prefetch_rc).toEqual([0, 0]);
  // The browser-captured video is never fetched; the uncaptured one is fetched once and uploaded.
  expect(report.youtube_calls).toEqual(['KsTestNoCap']);
  expect(report.local_files).toEqual(['yt_transcripts/_state.json']);
  expect(report.get_rc).toBe(0);
  expect(report.get_stdout).toBe(`[transcript language=en auto_generated=True]\n${TEXT}\n`);
  const fetched = await api('GET', `/bookmarks/${other.id}`);
  expect(fetched.assets).toHaveLength(1);
  expect(fetched.assets[0].fileName).toMatch(/^keepsake-transcript-KsTestNoCap-en-[0-9a-f]{12}\.html$/);
  const fallback = await (await fetch(`${KK}/api/v1/assets/${fetched.assets[0].id}`, { headers: { authorization: `Bearer ${KEY}` } })).text();
  const fallbackRecord = JSON.parse(fallback.match(/id="keepsake-capture">([\s\S]*?)<\/script>/)?.[1] ?? '');
  expect(fallbackRecord.provenance).toBe('youtube-api');
  expect(fallbackRecord.transcript.segments).toEqual([{ start: 0, text: 'Fetched by the fallback.' }, { start: 2.5, text: 'Second line.' }]);
  expect((await api('GET', `/bookmarks/${pre.id}`)).assets).toHaveLength(1);
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
