import { expect, test, vi } from 'vitest';
import { capture as video } from './__fixtures__/capture';
import { pageAssetFileName } from './format';
import { jevTag, type JevClient } from './jev-tag';
import type { Bookmark, List, Tag } from './karakeep';
import type { PageCapture } from './types';

const config = { apiKey: 'key', endpoint: 'https://jev.example.com/v1/systemone', model: 'jev-model' };

const capture = (): PageCapture => ({ ...video(), kind: 'page', title: 'Title', url: 'https://example.com/page#section', page: { markdown: 'Page text', description: 'Description', author: null, published: null, site: null, sha256: 'a'.repeat(64) } });
function setup() {
  const bookmark: Bookmark = { id: 'bm', title: null, note: null, archived: false, favourited: false, createdAt: '', tags: [], assets: [], content: { type: 'link', url: 'https://example.com/page#other' } };
  const calls: string[] = [];
  const tags: Tag[] = [{ id: 't', name: 'topic-ai', numBookmarks: 2 }];
  const lists: List[] = [
    { id: 'r', name: 'Research', parentId: null, type: 'manual', icon: '' },
    { id: 'l', name: 'Library', parentId: null, type: 'manual', icon: '' },
    { id: 'wrong', name: 'Tech', parentId: 'l', type: 'manual', icon: '' },
    { id: 'tech', name: 'Tech', parentId: 'r', type: 'manual', icon: '' },
    { id: 'articles', name: 'Articles', parentId: 'l', type: 'manual', icon: '' },
  ];
  let fileName = '';
  const client: JevClient = {
    getBookmark: vi.fn(async () => bookmark),
    uploadHtmlAsset: async name => { fileName = name; calls.push(`upload ${name}`); return 'asset'; },
    attachAsset: async (id, asset) => { calls.push(`asset ${id} ${asset}`); bookmark.assets.push({ id: asset, fileName, assetType: 'userUploaded' }); },
    allTags: async () => tags,
    lists: async () => lists,
    addToList: async (list, id) => { calls.push(`list ${list} ${id}`); },
    attachTags: async (id, names) => { calls.push(`tags ${id} ${names.join(',')}`); bookmark.tags.push(...names.map(name => ({ id: name, name, attachedBy: 'human' as const }))); },
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: {
    area: { choice: 'Tech', probabilities: { Tech: 1 } },
    libtype: { choice: 'Articles', probabilities: { Articles: 1 } },
    topic: { choice: 'topic-ai', probabilities: { 'topic-ai': 0.8, none: 0.2 } },
  } }));
  return { bookmark, calls, client, tags, lists, fetcher, opts: { fetch: fetcher } };
}
test.each(['jev-tagged', 'janitor-processed'])('skips %s without writes or classification', async name => {
  const f = setup(); f.bookmark.tags.push({ id: 'tag', name, attachedBy: 'human' });
  expect(await jevTag(f.client, 'bm', capture(), config, f.opts)).toEqual({ kind: 'skipped' });
  expect(f.calls).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.client.getBookmark).toHaveBeenCalledWith('bm', false);
});
test('rejects mismatched page and video URLs without writes', async () => {
  const f = setup(); f.bookmark.content.url = 'https://other.example.com/page';
  for (const c of [capture(), video()]) expect(await jevTag(f.client, 'bm', c, config, f.opts)).toEqual({ kind: 'mismatch' });
  expect(f.calls).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
});
test('serializes runs, attaches page once, applies marker before lists', async () => {
  const f = setup();
  expect(await Promise.all([jevTag(f.client, 'bm', capture(), config, f.opts), jevTag(f.client, 'bm', capture(), config, f.opts)])).toEqual([
    { kind: 'tagged', lists: ['Research > Tech', 'Library > Articles'], topic: 'topic-ai' }, { kind: 'skipped' },
  ]);
  expect(f.calls).toEqual([`upload ${pageAssetFileName(capture())}`, 'asset bm asset', 'tags bm topic-ai,jev-tagged', 'list tech bm', 'list articles bm']);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body)).state).toEqual({ title: 'Title', url: capture().url, description: 'Description', page_text_start: 'Page text' });
});
test('retry after Jev failure reuses page asset and queue recovers', async () => {
  const f = setup();
  await expect(jevTag(f.client, 'bm', capture(), config, { fetch: async () => new Response(null, { status: 503 }) })).rejects.toThrow('503');
  expect(f.bookmark.tags).toEqual([]);
  await jevTag(f.client, 'bm', capture(), config, f.opts);
  expect(f.calls.filter(c => c.startsWith('upload'))).toHaveLength(1);
});
test('YouTube compares video IDs and sends joined segment texts without page upload', async () => {
  const f = setup(); const c = video(); f.bookmark.content.url = c.url + '&t=30s';
  await jevTag(f.client, 'bm', c, config, f.opts);
  expect(f.calls.some(c => c.startsWith('upload'))).toBe(false);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body)).state.page_text_start).toBe(c.transcript.segments.map(s => s.text).join(' '));
});
test('topics are frequent topic tags, sorted and capped at 250; missing lists are skipped', async () => {
  const f = setup(); f.lists.length = 0;
  f.tags.push({ id: 'x', name: 'topic-rare', numBookmarks: 1 }, { id: 'y', name: 'topic-unknown' }, { id: 'z', name: 'other', numBookmarks: 20 });
  f.tags.push(...Array.from({ length: 260 }, (_, i) => ({ id: String(i), name: `topic-z${String(260 - i).padStart(3, '0')}`, numBookmarks: 3 })));
  expect(await jevTag(f.client, 'bm', capture(), config, f.opts)).toEqual({ kind: 'tagged', lists: [], topic: 'topic-ai' });
  const criteria = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body)).questions.topic.criteria;
  expect(Object.keys(criteria)).toEqual([...f.tags.filter(t => t.name.startsWith('topic-') && (t.numBookmarks ?? 0) >= 2).map(t => t.name).sort().slice(0, 250), 'none']);
});
test('none answers still mark classification complete', async () => {
  const f = setup();
  const fetcher: typeof fetch = async () => Response.json({ answers: Object.fromEntries(['area', 'libtype', 'topic'].map(k => [k, { choice: 'none', probabilities: { none: 1 } }])) });
  expect(await jevTag(f.client, 'bm', capture(), config, { fetch: fetcher })).toEqual({ kind: 'tagged', lists: [], topic: null });
  expect(f.calls.at(-1)).toBe('tags bm jev-tagged');
});
test('failed list write keeps the marker, so a retry never classifies twice', async () => {
  const f = setup(); f.client.addToList = async () => { throw new Error('list failed'); };
  await expect(jevTag(f.client, 'bm', capture(), config, f.opts)).rejects.toThrow('list failed');
  expect(f.bookmark.tags.map(t => t.name)).toEqual(['topic-ai', 'jev-tagged']);
  expect(await jevTag(f.client, 'bm', capture(), config, f.opts)).toEqual({ kind: 'skipped' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
