import { browser } from 'wxt/browser';
import { isRecord, isYoutubeCapture } from './capture-validation';
import type { YoutubeCapture } from './types';

export interface OutboxItem {
  id: string;
  createdAt: string;
  bookmarkUrl: string;
  capture: YoutubeCapture;
  lastError: string;
  attempts: number;
}
function isItem(value: unknown): value is OutboxItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.bookmarkUrl === 'string' && typeof value.lastError === 'string' && typeof value.attempts === 'number' && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && isYoutubeCapture(value.capture);
}
export async function listOutbox(): Promise<OutboxItem[]> {
  const { outbox } = await browser.storage.local.get('outbox');
  return Array.isArray(outbox) ? outbox.filter(isItem) : [];
}
// Serialize read-modify-write operations in this extension context.
let pending: Promise<void> = Promise.resolve();
function update(change: (items: OutboxItem[]) => OutboxItem[]): Promise<void> {
  const operation = pending.then(async () => {
    await browser.storage.local.set({ outbox: change(await listOutbox()) });
  });
  pending = operation.catch(() => undefined);
  return operation;
}
export function addToOutbox(item: OutboxItem): Promise<void> {
  if (!isItem(item)) return Promise.reject(new Error('Invalid outbox capture'));
  return update(items => {
    const existing = items.find(entry => entry.capture.video.id === item.capture.video.id && entry.capture.transcript.sha256 === item.capture.transcript.sha256);
    const added = existing ? { ...existing, attempts: existing.attempts + 1, lastError: item.lastError } : item;
    const others = items.filter(entry => entry !== existing && entry.id !== added.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return [...others.slice(-19), added];
  });
}
export function removeFromOutbox(id: string): Promise<void> { return update(items => items.filter(item => item.id !== id)); }
