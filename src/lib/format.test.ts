import { expect, test } from 'vitest';
import { capture } from './__fixtures__/capture';
import { pageAssetFileName, toPageAssetHtml, assetFileName, parseAssetFileName, toMarkdown, toJson, toTranscriptAssetHtml, parseTranscriptAssetHtml, noteFileName, obsidianUri, escapeMarkdownInline, yamlString } from './format';
import { LIMITS, type PageCapture } from './types';
test('asset filename round trip and language separation', () => {
  const c = capture();
  expect(parseAssetFileName(assetFileName(c))).toEqual({ videoId: c.video.id, language: 'en', hash12: 'aaaaaaaaaaaa' });
  const name = assetFileName(c); c.transcript.language = 'fr'; expect(assetFileName(c)).not.toBe(name);
  c.transcript.language = '../'; expect(assetFileName(c)).toContain('-und-');
  c.transcript.language = null; expect(assetFileName(c)).toContain('-und-');
  for (const bad of ['x.html', name + '.txt', name.replace('aaaaaaaaaaaa', 'zzzzzzzzzzzz')]) expect(parseAssetFileName(bad)).toBeNull();
});
test('YAML scalars stay single-line JSON strings; channel cannot inject wikilinks', () => {
  const c = capture(); c.title = 'Title "quoted"\n---\r\nkey: value\t\u0001'; c.video.channel = '[[Maker]]\n---';
  const frontmatter = toMarkdown(c).split('---\n')[1] ?? '';

  for (const line of frontmatter.trimEnd().split('\n')) {
    expect(line).toMatch(/^(?:[A-Za-z]+: ".*"|[A-Za-z]+:|  - ".*")$/);
    const scalar = line.replace(/^(?:[A-Za-z]+: |  - )/, '');
    if (scalar.startsWith('"')) expect(() => JSON.parse(scalar)).not.toThrow();
  }
  expect(JSON.parse(yamlString(c.title))).not.toMatch(/[\r\n\t\u0001]/);
  expect(frontmatter).toContain('[[Maker'); expect(frontmatter).not.toContain('[[[[Maker');
});
test('Markdown escapes untrusted inline and block syntax and spaces segments', () => {
  const c = capture(); c.video.description = '# Header\n> quote\n- item\n+ item\n1. item\n```code';
  c.transcript.segments.push({ start: 62, text: '<script> ** [link](x) # | & _ ~ ! \\ `\nnext' });
  const md = toMarkdown(c);
  expect(md).toContain('### First folds\n\n**0:01** · Fold the paper.\n\n**1:02**');
  expect(md).toContain('&lt;script&gt; \\*\\* \\[link\\](x) \\# \\| &amp; \\_ \\~ \\! \\\\ \\` next');
  expect(md).toContain('\\# Header\n&gt; quote\n\\- item\n\\+ item\n1\\. item\n\\`\\`\\`code');
  expect(escapeMarkdownInline('<a>&')).toBe('&lt;a&gt;&amp;');
});
test('page output omits absent metadata and preserves body', () => {
  const c: PageCapture = { ...capture(), kind: 'page', page: { markdown: '## A roof\n\nText', author: null, published: null, site: null, description: null, sha256: 'a'.repeat(64) } };
  expect(toMarkdown(c)).toContain('## A roof\n\nText'); expect(toMarkdown(c)).not.toContain('author:'); expect(toMarkdown(c)).not.toContain('published:');
  expect(toJson(c)).toBe(JSON.stringify(c, null, 2) + '\n');
});
test('asset HTML escapes all contexts and round-trips malicious text exactly', () => {
  const c = capture(); const evil = '</script><script>alert(1)</script>&"\'\u2028\u2029';
  c.title = evil; c.transcript.text = evil; c.transcript.segments = [{ start: 1, text: evil }]; c.transcript.chapters = [{ start: 1, title: evil }];
  const html = toTranscriptAssetHtml(c);
  expect(html).not.toContain('</script><script>'); expect(html).toContain('\\u003c'); expect(html).toContain('&amp;t=1s');
  expect(parseTranscriptAssetHtml(html)).toEqual(c);
  const doc = new DOMParser().parseFromString(html, 'text/html'); expect(doc.querySelectorAll('script')).toHaveLength(1);
});
test('asset parser validates complete shape, consistency and limits', () => {
  for (const mutate of [
    (c: ReturnType<typeof capture>) => { c.transcript.text = 'tampered'; },
    (c: ReturnType<typeof capture>) => { c.video.id = 'bad'; },
    (c: ReturnType<typeof capture>) => { c.transcript.text = ''; c.transcript.segments = []; },
    (c: ReturnType<typeof capture>) => { c.transcript.segments = [{ start: -1, text: c.transcript.text }]; },
    (c: ReturnType<typeof capture>) => { c.transcript.text = 'a'.repeat(LIMITS.maxTranscriptChars + 1); c.transcript.segments = [{ start: 1, text: c.transcript.text }]; },
  ]) { const c = capture(); mutate(c); expect(parseTranscriptAssetHtml(toTranscriptAssetHtml(c))).toBeNull(); }
  for (const value of [{}, { ...capture(), video: null }, { ...capture(), transcript: null }, { ...capture(), capturedAt: 42 }, { ...capture(), provenance: 'api' }]) expect(parseTranscriptAssetHtml(`<script id="keepsake-capture" type="application/json">${JSON.stringify(value)}</script>`)).toBeNull();
  expect(parseTranscriptAssetHtml('<script id="keepsake-capture">bad</script>')).toBeNull();
});
test('safe filename truncation and clipboard URI', () => {
  const c = capture(); c.title = '\\ / : * ? " < > | # ^ [ ]\u0000'; expect(noteFileName(c)).toBe('Untitled.md');
  c.title = 'x'.repeat(99) + '🪁'; expect(noteFileName(c)).toBe('x'.repeat(99) + '.md');
  c.title = '  A\n  kite  '; expect(noteFileName(c)).toBe('A kite.md');
  c.title = 'A:B/C'; expect(noteFileName(c)).toBe('ABC.md');
  expect(obsidianUri('My vault', '/Clips/YouTube/', 'A kite.md')).toBe('obsidian://new?vault=My%20vault&file=Clips%2FYouTube%2FA%20kite&clipboard');
});
test('description cannot inject thematic breaks or setext headings', () => {
  const c = capture(); c.video.description = 'A paragraph\n---\n===\n- - -';
  expect(toMarkdown(c)).toContain('A paragraph\n\\---\n\\===\n\\- - -');
});

test('page asset filename uses the first twelve hash digits', () => {
  const c: PageCapture = { ...capture(), kind: 'page', page: { markdown: 'Hello', author: null, published: null, site: null, description: null, sha256: 'abcdef012345' + '0'.repeat(52) } };
  expect(pageAssetFileName(c)).toBe('keepsake-page-abcdef012345.html');
});
test('page asset safely preserves Markdown and the complete JSON record', () => {
  const evil = '</pre></script><script>alert(1)</script>&"\u2028\u2029';
  const c: PageCapture = { ...capture(), title: evil, kind: 'page', page: { markdown: evil, author: null, published: null, site: null, description: null, sha256: 'a'.repeat(64) } };
  const html = toPageAssetHtml(c);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(doc.title).toBe(`Page: ${evil}`);
  expect(doc.querySelector('meta[name="keepsake-schema"]')?.getAttribute('content')).toBe(c.schema);
  expect(doc.querySelector('pre')?.textContent).toBe(toMarkdown(c));
  expect(doc.querySelectorAll('script')).toHaveLength(1);
  expect(JSON.parse(doc.querySelector('#keepsake-capture')?.textContent ?? '')).toEqual(c);
});
