import { isRecord, isNullableString } from './capture-validation';
import { invalid } from './karakeep-http';

export interface Tag { id: string; name: string }
export interface List { id: string; name: string; type?: 'manual' | 'smart' }
export interface Bookmark {
  id: string;
  title: string | null;
  note: string | null;
  archived: boolean;
  favourited: boolean;
  createdAt: string;
  tags: (Tag & { attachedBy: 'ai' | 'human' })[];
  content: {
    type: 'link' | 'text' | 'asset' | 'unknown';
    url?: string;
    title?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    favicon?: string | null;
    htmlContent?: string | null;
    crawlStatus?: 'success' | 'failure' | 'pending' | null;
  };
  assets: { id: string; assetType: string; fileName?: string | null }[];
}
export function tag(value: unknown): Tag {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return invalid();
  return { id: value.id, name: value.name };
}
export function list(value: unknown): List {
  const base = tag(value);
  if (!isRecord(value) || (value.type !== undefined && value.type !== 'manual' && value.type !== 'smart')) return invalid();
  return value.type === undefined ? base : { ...base, type: value.type };
}
function content(value: unknown): Bookmark['content'] {
  if (!isRecord(value) || !['link', 'text', 'asset', 'unknown'].includes(String(value.type))) return invalid();
  const type = value.type;
  if (type !== 'link' && type !== 'text' && type !== 'asset' && type !== 'unknown') return invalid();
  if (type === 'link' && typeof value.url !== 'string') return invalid();
  if (type === 'text' && typeof value.text !== 'string') return invalid();
  if (type === 'asset' && (typeof value.assetId !== 'string' || !['image', 'pdf'].includes(String(value.assetType)))) return invalid();
  const result: Bookmark['content'] = { type };
  if (typeof value.url === 'string') result.url = value.url;
  for (const key of ['title', 'description', 'imageUrl', 'favicon', 'htmlContent'] as const) {
    const field = value[key];
    if (field !== undefined) { if (!isNullableString(field)) return invalid(); result[key] = field; }
  }
  if (value.crawlStatus !== undefined) {
    if (value.crawlStatus !== null && value.crawlStatus !== 'success' && value.crawlStatus !== 'failure' && value.crawlStatus !== 'pending') return invalid();
    result.crawlStatus = value.crawlStatus;
  }
  return result;
}
export function bookmark(value: unknown): Bookmark {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.createdAt !== 'string' || typeof value.archived !== 'boolean' || typeof value.favourited !== 'boolean' || !isNullableString(value.title ?? null) || !isNullableString(value.note ?? null) || !Array.isArray(value.tags) || !Array.isArray(value.assets)) return invalid();
  const tags = value.tags.map((entry: unknown): Bookmark['tags'][number] => {
    const base = tag(entry);
    if (!isRecord(entry) || (entry.attachedBy !== 'ai' && entry.attachedBy !== 'human')) return invalid();
    return { ...base, attachedBy: entry.attachedBy };
  });
  const assets = value.assets.map((entry: unknown): Bookmark['assets'][number] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.assetType !== 'string' || !isNullableString(entry.fileName ?? null)) return invalid();
    return { id: entry.id, assetType: entry.assetType, fileName: typeof entry.fileName === 'string' ? entry.fileName : null };
  });
  return { id: value.id, title: typeof value.title === 'string' ? value.title : null, note: typeof value.note === 'string' ? value.note : null, archived: value.archived, favourited: value.favourited, createdAt: value.createdAt, tags, content: content(value.content), assets };
}
