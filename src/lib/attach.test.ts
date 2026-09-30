import { describe, expect, test } from 'vitest';
import { attachTranscript, findBookmark, type AttachClient } from './attach';
import { assetFileName } from './format';
import type { Bookmark } from './karakeep';
import { CAPTURE_SCHEMA, type YoutubeCapture } from './types';

const capture = (text = 'hello world', language: string | null = 'en'): YoutubeCapture => ({
  schema: CAPTURE_SCHEMA,
  provenance: 'browser-dom',
  kind: 'youtube-transcript',
  capturedAt: '2026-09-30T20:00:00.000Z',
  url: 'https://www.youtube.com/watch?v=AbCdEfGhIjK',
  title: 'A video',
  video: { id: 'AbCdEfGhIjK', channel: 'Chan', publishedAt: null, durationSeconds: 60, description: null },
  transcript: {
    language,
    languageLabel: null,
    generated: true,
    segments: text.split(' ').map((t, i) => ({ start: i, text: t })),
    chapters: [],
    text,
    sha256: text === 'hello world' ? 'a'.repeat(64) : 'b'.repeat(64),
  },
});

function fakeClient(assets: Bookmark['assets']) {
  const calls: string[] = [];
  const bookmark = { id: 'bm1', assets, content: { url: 'https://www.youtube.com/watch?v=AbCdEfGhIjK&t=5s' } } as Bookmark;
  const client: AttachClient = {
    getBookmark: async () => bookmark,
    uploadHtmlAsset: async (name) => (calls.push(`upload ${name}`), 'new-asset'),
    attachAsset: async (b, a) => void calls.push(`attach ${b} ${a}`),
    replaceAsset: async (b, o, n) => void calls.push(`replace ${b} ${o} ${n}`),
    attachTags: async (b, t) => void calls.push(`tag ${b} ${t.join(',')}`),
  };
  return { client, calls };
}

describe('attachTranscript', () => {
  test('uploads and attaches when nothing is attached yet, plus the optional tag', async () => {
    const { client, calls } = fakeClient([]);
    expect(await attachTranscript(client, 'bm1', capture(), { tag: 'transcript' })).toEqual({ kind: 'attached' });
    expect(calls).toEqual([`upload ${assetFileName(capture())}`, 'attach bm1 new-asset', 'tag bm1 transcript']);
  });

  test('is a no-op when the identical transcript is already attached (duplicate click)', async () => {
    const { client, calls } = fakeClient([{ id: 'x', assetType: 'userUploaded', fileName: assetFileName(capture()) }]);
    expect(await attachTranscript(client, 'bm1', capture(), {})).toEqual({ kind: 'already' });
    expect(calls).toEqual([]);
  });

  test('asks before replacing a different transcript in the same language', async () => {
    const old = { id: 'old', assetType: 'userUploaded' as const, fileName: assetFileName(capture()) };
    const { client, calls } = fakeClient([old]);
    const next = capture('hello there world');
    expect(await attachTranscript(client, 'bm1', next, {})).toEqual({ kind: 'conflict', existing: old });
    expect(calls).toEqual([]);
    expect(await attachTranscript(client, 'bm1', next, { replaceAssetId: 'old' })).toEqual({ kind: 'replaced' });
    expect(calls).toEqual([`upload ${assetFileName(next)}`, 'replace bm1 old new-asset']);
  });

  test('another language is attached alongside, other attachments are ignored', async () => {
    const { client, calls } = fakeClient([
      { id: 'sk', assetType: 'userUploaded', fileName: assetFileName(capture('hello world', 'sk')) },
      { id: 'pdf', assetType: 'userUploaded', fileName: 'paper.pdf' },
      { id: 'shot', assetType: 'screenshot', fileName: null },
    ]);
    expect(await attachTranscript(client, 'bm1', capture(), {})).toEqual({ kind: 'attached' });
    expect(calls[1]).toBe('attach bm1 new-asset');
  });
});

test('refuses to attach a transcript to another video\'s bookmark (tab navigated meanwhile)', async () => {
  const { client, calls } = fakeClient([]);
  const other = { ...capture(), video: { ...capture().video, id: 'ZzZzZzZzZzZ' } };
  expect(await attachTranscript(client, 'bm1', other, {})).toEqual({ kind: 'mismatch' });
  expect(calls).toEqual([]);
});

describe('findBookmark', () => {
  test('tries the tab URL, then the canonical video URL', async () => {
    const seen: string[] = [];
    const checkUrl = async (u: string) => (seen.push(u), u.endsWith('AbCdEfGhIjK') ? 'bm1' : null);
    expect(await findBookmark(checkUrl, 'https://www.youtube.com/watch?v=AbCdEfGhIjK&t=30s')).toBe('bm1');
    expect(seen).toEqual([
      'https://www.youtube.com/watch?v=AbCdEfGhIjK&t=30s',
      'https://www.youtube.com/watch?v=AbCdEfGhIjK',
    ]);
  });

  test('plain pages are looked up once', async () => {
    const seen: string[] = [];
    expect(await findBookmark(async (u) => (seen.push(u), null), 'https://example.com/a')).toBeNull();
    expect(seen).toEqual(['https://example.com/a']);
  });
});
