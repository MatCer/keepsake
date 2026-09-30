import { expect, test, vi, afterEach } from 'vitest';
import article from './__fixtures__/article.html?raw';
import { capturePage, captureDocument } from './page';
import { LIMITS } from './types';
const now = new Date('2026-09-30T12:00:00Z');
afterEach(() => vi.unstubAllGlobals());
test('article captures heading and paragraph without mutating live DOM', async () => {
  document.documentElement.innerHTML = article;
  const before = document.documentElement.outerHTML;
  const result = await capturePage(document, 'https://example.com/article', now);
  expect(result.status).toBe('captured');
  if (result.status !== 'captured' || result.capture.kind !== 'page') throw Error('Missing page');
  expect(result.capture.page.markdown).toContain('## Building the roof');
  expect(result.capture.page.markdown).toContain('A folded paper roof');
  expect(document.documentElement.outerHTML).toBe(before);
});
test('empty and non-http pages are unsupported', async () => {
  const doc = new DOMParser().parseFromString('', 'text/html');
  expect(await capturePage(doc, 'https://example.com', now)).toMatchObject({ status: 'unsupported', reason: 'No readable content on this page' });
  for (const url of ['file:///tmp/a', 'chrome://settings', 'bad']) expect(await captureDocument(doc, url, null, now)).toMatchObject({ status: 'unsupported' });
});
test('YouTube videos never use Defuddle or fetch; other pages use article capture', async () => {
  const fetch = vi.fn(() => { throw Error('No requests allowed'); }); vi.stubGlobal('fetch', fetch);
  const doc = new DOMParser().parseFromString(article, 'text/html');
  expect(await captureDocument(doc, 'https://youtube.com/watch?v=dQw4w9WgXcQ', null, now)).toMatchObject({ status: 'panel-not-loaded' });
  for (const u of ['https://youtube.com/', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/results?search_query=x', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'])
    expect(await captureDocument(doc, u, null, now)).toMatchObject({ status: 'unsupported' });
  expect(await captureDocument(doc, 'https://example.com/a', null, now)).toMatchObject({ status: 'captured', capture: { kind: 'page' } });
  expect(fetch).not.toHaveBeenCalled();
});
test('page Markdown size limit uses UTF-8 bytes', async () => {
  const doc = new DOMParser().parseFromString(`<article><p>${'é'.repeat(LIMITS.maxPageMarkdownChars + 1)}</p></article>`, 'text/html');
  const result = await capturePage(doc, 'https://example.com/large', now);
  expect(result.status).toBe('too-large');
  if (result.status === 'too-large') expect(result.bytes).toBeGreaterThan(LIMITS.maxPageMarkdownChars * 2);
});
