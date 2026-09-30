import { isRecord, isNullableString } from './capture-validation';
import { request, json, invalid, normalizeAddress, type ClientOptions } from './karakeep-http';
import { bookmark, tag, type Bookmark, type Tag } from './karakeep-types';
export { KarakeepError, normalizeAddress, originPattern } from './karakeep-http';
export type { ClientOptions } from './karakeep-http';
export type { Bookmark, Tag } from './karakeep-types';

export interface List {
  id: string;
  name: string;
  icon: string;
  parentId: string | null;
  type: 'manual' | 'smart';
}

function list(value: unknown): List {
  const base = tag(value);
  if (!isRecord(value) || typeof value.icon !== 'string' || !isNullableString(value.parentId)) return invalid();
  // The 0.32.0 schema permits an omitted type and defaults it to manual.
  const type = value.type === undefined ? 'manual' : value.type;
  if (type !== 'manual' && type !== 'smart') return invalid();
  return { ...base, icon: value.icon, parentId: value.parentId, type };
}

const enc = encodeURIComponent;

export class KarakeepClient {
  private readonly origin: string;
  constructor(address: string, private readonly apiKey: string, private readonly opts: ClientOptions = {}) { this.origin = normalizeAddress(address); }
  private send(method: string, path: string, template: string, body?: unknown, attempts?: number): Promise<Response> {
    return request(this.origin, `/api/v1${path}`, template, method, body === undefined ? undefined : JSON.stringify(body), this.apiKey, { ...this.opts, attempts });
  }
  async me(): Promise<{ id: string; name: string | null; email: string | null }> {
    const value = await json(await this.send('GET', '/users/me', '/users/me'));
    if (!isRecord(value) || typeof value.id !== 'string' || !isNullableString(value.name ?? null) || !isNullableString(value.email ?? null)) return invalid();
    return { id: value.id, name: typeof value.name === 'string' ? value.name : null, email: typeof value.email === 'string' ? value.email : null };
  }
  async checkUrl(url: string): Promise<string | null> {
    const value = await json(await this.send('GET', `/bookmarks/check-url?url=${enc(url)}`, '/bookmarks/check-url'));
    if (!isRecord(value) || !isNullableString(value.bookmarkId)) return invalid();
    return value.bookmarkId;
  }
  async createLink(url: string): Promise<{ bookmark: Bookmark; created: boolean }> {
    const response = await this.send('POST', '/bookmarks', '/bookmarks', { type: 'link', url, source: 'extension' });
    return { bookmark: bookmark(await json(response)), created: response.status === 201 };
  }
  async getBookmark(id: string, includeContent: boolean): Promise<Bookmark> {
    return bookmark(await json(await this.send('GET', `/bookmarks/${enc(id)}?includeContent=${includeContent}`, '/bookmarks/{id}')));
  }
  async updateNote(id: string, note: string): Promise<void> { await this.send('PATCH', `/bookmarks/${enc(id)}`, '/bookmarks/{id}', { note }); }
  async setFlags(id: string, flags: { archived?: boolean; favourited?: boolean }): Promise<void> {
    await this.send('PATCH', `/bookmarks/${enc(id)}`, '/bookmarks/{id}', { archived: flags.archived, favourited: flags.favourited });
  }
  async deleteBookmark(id: string): Promise<void> { await this.send('DELETE', `/bookmarks/${enc(id)}`, '/bookmarks/{id}'); }
  async allTags(): Promise<Tag[]> {
    const tags: Tag[] = []; let cursor: string | null = null; const seen = new Set<string>();
    do {
      const value = await json(await this.send('GET', `/tags${cursor ? `?cursor=${enc(cursor)}` : ''}`, '/tags'));
      if (!isRecord(value) || !Array.isArray(value.tags) || !isNullableString(value.nextCursor)) return invalid();
      tags.push(...value.tags.map(tag)); cursor = value.nextCursor;
      if (cursor !== null) { if (seen.has(cursor)) return invalid(); seen.add(cursor); }
    } while (cursor !== null);
    return tags;
  }
  async attachTags(id: string, names: string[]): Promise<void> {
    await this.send('POST', `/bookmarks/${enc(id)}/tags`, '/bookmarks/{id}/tags', { tags: names.map(tagName => ({ tagName })) });
  }
  async detachTags(id: string, tagIds: string[]): Promise<void> {
    await this.send('DELETE', `/bookmarks/${enc(id)}/tags`, '/bookmarks/{id}/tags', { tags: tagIds.map(tagId => ({ tagId })) });
  }
  private async readLists(path: string, template: string): Promise<List[]> {
    const value = await json(await this.send('GET', path, template));
    if (!isRecord(value) || !Array.isArray(value.lists)) return invalid();
    return value.lists.map(list);
  }
  lists(): Promise<List[]> { return this.readLists('/lists', '/lists'); }
  bookmarkLists(id: string): Promise<List[]> { return this.readLists(`/bookmarks/${enc(id)}/lists`, '/bookmarks/{id}/lists'); }
  async addToList(listId: string, id: string): Promise<void> { await this.send('PUT', `/lists/${enc(listId)}/bookmarks/${enc(id)}`, '/lists/{listId}/bookmarks/{id}'); }
  async removeFromList(listId: string, id: string): Promise<void> { await this.send('DELETE', `/lists/${enc(listId)}/bookmarks/${enc(id)}`, '/lists/{listId}/bookmarks/{id}'); }
  async uploadHtmlAsset(fileName: string, html: string): Promise<string> {
    const body = new FormData(); body.append('file', new Blob([html], { type: 'text/html' }), fileName);
    const value = await json(await request(this.origin, '/api/v1/assets', '/assets', 'POST', body, this.apiKey, { ...this.opts, attempts: 1 }));
    if (!isRecord(value) || typeof value.assetId !== 'string') return invalid();
    return value.assetId;
  }
  async attachAsset(bookmarkId: string, assetId: string): Promise<void> { await this.send('POST', `/bookmarks/${enc(bookmarkId)}/assets`, '/bookmarks/{id}/assets', { id: assetId, assetType: 'userUploaded' }, 1); }
  async replaceAsset(bookmarkId: string, oldAssetId: string, newAssetId: string): Promise<void> { await this.send('PUT', `/bookmarks/${enc(bookmarkId)}/assets/${enc(oldAssetId)}`, '/bookmarks/{id}/assets/{assetId}', { assetId: newAssetId }, 1); }
}

export async function exchangeApiKey(address: string, email: string, password: string, opts: ClientOptions = {}): Promise<string> {
  // Non-batched tRPC with SuperJSON: only the JSON branch is needed for string input/output.
  const body = JSON.stringify({ json: { keyName: 'Keepsake extension', email, password } });
  const value = await json(await request(normalizeAddress(address), '/api/trpc/apiKeys.exchange', '/api/trpc/apiKeys.exchange', 'POST', body, null, opts));
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.data) || !isRecord(value.result.data.json) || typeof value.result.data.json.key !== 'string' || !value.result.data.json.key) return invalid();
  return value.result.data.json.key;
}
