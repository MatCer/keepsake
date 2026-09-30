import { expect, test, vi } from 'vitest';
import { KarakeepClient, KarakeepError, normalizeAddress, originPattern, exchangeApiKey, type List, type Tag } from './karakeep';
const bookmark = { id: 'b', title: null, note: null, archived: false, favourited: false, createdAt: '2026-09-30T12:00:00Z', tags: [{ id: 't', name: 'Kites', attachedBy: 'human' }], content: { type: 'link', url: 'https://example.com', htmlContent: '<p>kite</p>' }, assets: [{ id: 'a', assetType: 'userUploaded', fileName: 'kite.html' }] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function setup(responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { const next = responses.shift(); if (!next) throw Error('Unexpected request'); return next; });
  const sleep = vi.fn(async (_ms: number) => {});
  return { fetch, sleep, client: new KarakeepClient('https://kk.example/base', 'test-secret', { fetch, sleep, timeoutMs: 1000 }) };
}
test.each(['https://example.com/path?q=1#x', 'http://localhost:3000/path', 'http://127.0.0.1', 'http://[::1]:3000', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.4', 'http://kk.local', 'http://kk.lan', 'http://kk.home.arpa'])('accepts safe address %s', input => {
  expect(normalizeAddress(input)).toBe(new URL(input).origin);
  expect(originPattern(input)).toBe(`${new URL(input).origin}/*`);
});
test.each(['bad', 'ftp://example.com', 'http://example.com', 'http://172.15.1.1', 'http://172.32.1.1', 'http://192.169.1.1', 'http://10.evil.com', 'http://localhost.evil.com', 'https://user:pass@example.com'])('rejects unsafe address %s', input => expect(() => normalizeAddress(input)).toThrow(KarakeepError));
test('me/check-url auth, encoded query, signals and normalized origin', async () => {
  const { client, fetch } = setup([response({ id: 'u', name: null, email: null }), response({ bookmarkId: 'b' }), response({ bookmarkId: null })]);
  expect(await client.me()).toEqual({ id: 'u', name: null, email: null }); expect(await client.checkUrl('https://x.com/?a=1&b=2')).toBe('b'); expect(await client.checkUrl('https://none.com')).toBeNull();
  expect(fetch.mock.calls[0]?.[0]).toBe('https://kk.example/api/v1/users/me');
  const init = fetch.mock.calls[0]?.[1]; expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret'); expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(fetch.mock.calls[1]?.[0]).toBe('https://kk.example/api/v1/bookmarks/check-url?url=https%3A%2F%2Fx.com%2F%3Fa%3D1%26b%3D2');
});
test.each([200, 201])('createLink preserves created status %i', async status => {
  const { client, fetch } = setup([response(bookmark, status)]);
  expect(await client.createLink('https://example.com')).toMatchObject({ bookmark: { id: 'b' }, created: status === 201 });
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ type: 'link', url: 'https://example.com', source: 'extension' }));
});
test('bookmark paths, note-only patch, flags and deletion', async () => {
  const { client, fetch } = setup([response(bookmark), response({}), response({}), new Response(null, { status: 204 })]);
  expect(await client.getBookmark('b/id', true)).toMatchObject({ id: 'b', content: { htmlContent: '<p>kite</p>' } });
  await client.updateNote('b', 'My note'); await client.setFlags('b', { archived: true }); await client.deleteBookmark('b');
  expect(fetch.mock.calls[0]?.[0]).toBe('https://kk.example/api/v1/bookmarks/b%2Fid?includeContent=true');
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', body: '{"note":"My note"}' });
  expect(fetch.mock.calls[2]?.[1]?.body).toBe('{"archived":true}'); expect(fetch.mock.calls[3]?.[1]?.method).toBe('DELETE');
});
test('tags paginate and attach/detach use tagName and tagId', async () => {
  const { client, fetch } = setup([response({ tags: [{ id: 't', name: 'Kites' }], nextCursor: 'next' }), response({ tags: [{ id: 'u', name: 'Paper' }], nextCursor: null }), response({ attached: ['t'] }), response({ detached: ['t'] })]);
  expect(await client.allTags()).toEqual([{ id: 't', name: 'Kites' }, { id: 'u', name: 'Paper' }]);
  await client.attachTags('b', ['Kites']); await client.detachTags('b', ['t']);
  expect(fetch.mock.calls[1]?.[0]).toBe('https://kk.example/api/v1/tags?cursor=next');
  expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: '{"tags":[{"tagName":"Kites"}]}' });
  expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE', body: '{"tags":[{"tagId":"t"}]}' });
});
test('list wrappers and membership endpoints', async () => {
  const list: List = { id: 'l', name: 'Workshop', icon: '🪁', parentId: null, type: 'manual' };
  const { client, fetch } = setup([response({ lists: [list] }), response({ lists: [list] }), new Response(null, { status: 204 }), new Response(null, { status: 204 })]);
  expect(await client.lists()).toEqual([list]); expect(await client.bookmarkLists('b')).toEqual([list]); await client.addToList('l', 'b'); await client.removeFromList('l', 'b');
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://kk.example/api/v1/lists', 'https://kk.example/api/v1/bookmarks/b/lists', 'https://kk.example/api/v1/lists/l/bookmarks/b', 'https://kk.example/api/v1/lists/l/bookmarks/b']);
  expect(fetch.mock.calls[2]?.[1]?.method).toBe('PUT'); expect(fetch.mock.calls[3]?.[1]?.method).toBe('DELETE');
});
test('multipart HTML upload, attach and replace match spec', async () => {
  const { client, fetch } = setup([response({ assetId: 'a', contentType: 'text/html', size: 10, fileName: 'kite.html' }), response({ id: 'a', assetType: 'userUploaded' }, 201), new Response(null, { status: 204 })]);
  expect(await client.uploadHtmlAsset('kite.html', '<p>kite</p>')).toBe('a'); await client.attachAsset('b', 'a'); await client.replaceAsset('b', 'a', 'new');
  const body = fetch.mock.calls[0]?.[1]?.body; expect(body).toBeInstanceOf(FormData);
  if (!(body instanceof FormData)) throw Error('Expected multipart');
  const file = body.get('file'); expect(file).toBeInstanceOf(File); if (!(file instanceof File)) throw Error('Expected file'); expect(file.name).toBe('kite.html'); expect(file.type).toBe('text/html');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Content-Type')).toBe(false);
  expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"id":"a","assetType":"userUploaded"}');
  expect(fetch.mock.calls[2]?.[0]).toBe('https://kk.example/api/v1/bookmarks/b/assets/a'); expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', body: '{"assetId":"new"}' });
});
test('retries 503/429 with 500 and 1500ms backoff', async () => {
  const { client, fetch, sleep } = setup([response({}, 503), response({}, 429), response({ id: 'u' })]); expect(await client.me()).toEqual({ id: 'u', name: null, email: null });
  expect(fetch).toHaveBeenCalledTimes(3); expect(sleep.mock.calls).toEqual([[500], [1500]]);
});
test('does not retry 401 or leak secrets and queries', async () => {
  const { client, fetch, sleep } = setup([response({ error: 'test-secret' }, 401)]);
  await expect(client.checkUrl('https://private.example/?token=secret')).rejects.toMatchObject({ status: 401, retryable: false, message: 'GET /bookmarks/check-url failed: 401' }); expect(fetch).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});
test('gives up after three attempts with retryable error', async () => {
  const { client, fetch } = setup([response({}, 503), response({}, 503), response({}, 503)]);
  await expect(client.setFlags('private-id', { archived: true })).rejects.toMatchObject({ retryable: true, status: 503, message: 'PATCH /bookmarks/{id} failed: 503' }); expect(fetch).toHaveBeenCalledTimes(3);
});
test.each([new TypeError('secret URL'), new DOMException('secret URL', 'AbortError'), new DOMException('secret URL', 'TimeoutError')])('retries network/abort errors safely', async error => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(error).mockResolvedValue(response({ id: 'u' })); const sleep = vi.fn(async () => {});
  expect(await new KarakeepClient('https://kk.example', 'secret', { fetch, sleep }).me()).toMatchObject({ id: 'u' }); expect(sleep).toHaveBeenCalledWith(500);
});
test('validates malformed boundary responses without leaking values', async () => {
  for (const value of [null, {}, { ...bookmark, tags: [42] }, { ...bookmark, content: { type: 'link', url: 42 } }, { ...bookmark, assets: [{ id: 5 }] }]) {
    const { client } = setup([response(value)]); await expect(client.getBookmark('b', false)).rejects.toBeInstanceOf(KarakeepError);
  }
});
test('exchange uses non-batched SuperJSON request and reads key envelope', async () => {
  const { fetch, sleep } = setup([response({ result: { data: { json: { key: 'issued-key', createdAt: '2026-09-30' }, meta: { values: { createdAt: ['Date'] } } } } })]);
  expect(await exchangeApiKey('https://kk.example/base', 'user@example.com', 'password', { fetch, sleep })).toBe('issued-key');
  expect(fetch.mock.calls[0]?.[0]).toBe('https://kk.example/api/trpc/apiKeys.exchange');
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ json: { keyName: 'Keepsake extension', email: 'user@example.com', password: 'password' } }) });
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
});
test('upload, attach and replace are sent once: a lost response must not create duplicates', async () => {
  for (const call of [
    (c: KarakeepClient) => c.uploadHtmlAsset('kite.html', 'kite'),
    (c: KarakeepClient) => c.attachAsset('b', 'a'),
    (c: KarakeepClient) => c.replaceAsset('b', 'a', 'n'),
  ]) {
    const { client, fetch, sleep } = setup([response({}, 503), response({ assetId: 'a' })]);
    await expect(call(client)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  }
});
test('validates wrappers, exchange errors and malformed JSON', async () => {
  for (const action of [
    (client: KarakeepClient) => client.me(), (client: KarakeepClient) => client.checkUrl('https://example.com'),
    (client: KarakeepClient) => client.allTags(), (client: KarakeepClient) => client.lists(),
    (client: KarakeepClient) => client.uploadHtmlAsset('test.html', 'kite'),
  ]) { const { client } = setup([response({ unexpected: 'secret' })]); await expect(action(client)).rejects.toMatchObject({ message: 'Unexpected server response', retryable: false }); }
  const bad = setup([new Response('invalid-json')]); await expect(bad.client.me()).rejects.toBeInstanceOf(KarakeepError);
  const exchange = setup([response({ error: { message: 'password' } })]); await expect(exchangeApiKey('https://kk.example', 'email', 'password', { fetch: exchange.fetch })).rejects.toMatchObject({ message: 'Unexpected server response' });
});
test('aborts hanging requests at the configured timeout', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')), { once: true });
  }));
  const client = new KarakeepClient('https://kk.example', 'secret', { fetch, timeoutMs: 5, sleep: async () => {} });
  await expect(client.me()).rejects.toMatchObject({ retryable: true, status: null }); expect(fetch).toHaveBeenCalledTimes(3);
});
test('retries network errors while reading a response body', async () => {
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection lost')); } }));
  const { client, fetch } = setup([broken, response({ id: 'u' })]);
  expect(await client.me()).toMatchObject({ id: 'u' }); expect(fetch).toHaveBeenCalledTimes(2);
});

test('lists preserve hierarchy and icons, with the spec default for omitted type', async () => {
  const manual: List = { id: 'root', name: 'Workshop', icon: '🪁', parentId: null, type: 'manual' };
  const smart: List = { id: 'child', name: 'Unread', icon: '📚', parentId: 'root', type: 'smart' };
  const { type: _type, ...withoutType } = manual;
  const { client } = setup([response({ lists: [withoutType, smart] }), response({ lists: [smart] })]);
  expect(await client.lists()).toEqual([manual, smart]);
  expect(await client.bookmarkLists('b')).toEqual([smart]);
  const tag: Tag = { id: 't', name: 'Kites' };
  await expect(setup([response({ tags: [tag], nextCursor: null })]).client.allTags()).resolves.toEqual([tag]);
});

test.each([
  { id: 'l', name: 'List', parentId: null, type: 'manual' },
  { id: 'l', name: 'List', icon: 'x', type: 'manual' },
  { id: 'l', name: 'List', icon: null, parentId: null, type: 'manual' },
  { id: 'l', name: 'List', icon: 'x', parentId: 42, type: 'manual' },
  { id: 'l', name: 'List', icon: 'x', parentId: null, type: 'invalid' },
  { id: 'l', name: 'List', icon: 'x', parentId: null, type: null },
])('rejects malformed list fields %#', async list => {
  const { client } = setup([response({ lists: [list] }), response({ lists: [list] })]);
  await expect(client.lists()).rejects.toBeInstanceOf(KarakeepError);
  await expect(client.bookmarkLists('b')).rejects.toBeInstanceOf(KarakeepError);
});
