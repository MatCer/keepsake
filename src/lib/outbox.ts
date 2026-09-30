import { browser } from 'wxt/browser';
import { isRecord, isYoutubeCapture } from './capture-validation';
import type { YoutubeCapture } from './types';

export interface OutboxItem {
  id: string;
  createdAt: string;
  /** Karakeep origin the upload was meant for; retried only against that server. */
  address: string;
  bookmarkUrl: string;
  capture: YoutubeCapture;
  lastError: string;
  attempts: number;
}
function isItem(value: unknown): value is OutboxItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.createdAt === 'string' && typeof value.address === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.bookmarkUrl === 'string' && typeof value.lastError === 'string' && typeof value.attempts === 'number' && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && isYoutubeCapture(value.capture);
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
export const OUTBOX_LIMIT = 20;
/** Queues a failed upload. Never evicts: when full it returns false and the caller must tell the user. */
export async function addToOutbox(item: OutboxItem): Promise<boolean> {
  if (!isItem(item)) throw new Error('Invalid outbox capture');
  let added = false;
  await update(items => {
    const existing = items.find(entry => entry.id === item.id || (entry.capture.video.id === item.capture.video.id && entry.capture.transcript.sha256 === item.capture.transcript.sha256));
    if (existing) { added = true; return items.map(entry => entry === existing ? { ...existing, attempts: existing.attempts + 1, lastError: item.lastError } : entry); }
    if (items.length >= OUTBOX_LIMIT) return items;
    added = true;
    return [...items, item];
  });
  return added;
}
export function removeFromOutbox(id: string): Promise<void> { return update(items => items.filter(item => item.id !== id)); }
