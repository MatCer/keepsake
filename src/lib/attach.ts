import { assetFileName, parseAssetFileName, toTranscriptAssetHtml } from './format';
import type { Bookmark, KarakeepClient } from './karakeep';
import type { YoutubeCapture } from './types';
import { canonicalVideoUrl, videoIdFromUrl } from './youtube';

export type AttachClient = Pick<
  KarakeepClient,
  'getBookmark' | 'uploadHtmlAsset' | 'attachAsset' | 'replaceAsset' | 'attachTags'
>;

type Asset = Bookmark['assets'][number];

export type AttachOutcome =
  | { kind: 'attached' }
  | { kind: 'replaced' }
  | { kind: 'already' }
  | { kind: 'mismatch' }
  | { kind: 'conflict'; existing: Asset };

let queue: Promise<unknown> = Promise.resolve();

/**
 * Attach a captured transcript to a bookmark as a `userUploaded` HTML asset.
 * Identical capture: nothing happens. A different capture in the same language is only
 * replaced when the caller passes that asset's id back after asking the user.
 */
export function attachTranscript(
  client: AttachClient,
  bookmarkId: string,
  capture: YoutubeCapture,
  opts: { replaceAssetId?: string; tag?: string },
): Promise<AttachOutcome> {
  // One at a time, so two clicks (or a click and an outbox retry) can't both pass the file-name check.
  const run = queue.then(() => attachOnce(client, bookmarkId, capture, opts));
  queue = run.catch(() => undefined);
  return run;
}

async function attachOnce(
  client: AttachClient,
  bookmarkId: string,
  capture: YoutubeCapture,
  opts: { replaceAssetId?: string; tag?: string },
): Promise<AttachOutcome> {
  const bookmark = await client.getBookmark(bookmarkId, false);
  // The tab may have navigated to another video between opening the popup and clicking Attach.
  if (videoIdFromUrl(bookmark.content.url ?? '') !== capture.video.id) return { kind: 'mismatch' };
  const name = assetFileName(capture);
  const wanted = parseAssetFileName(name);
  const ours = bookmark.assets.filter((a) => a.assetType === 'userUploaded' && a.fileName);
  if (ours.some((a) => a.fileName === name)) return { kind: 'already' };

  const sameLanguage = ours.find((a) => {
    const p = parseAssetFileName(a.fileName ?? '');
    return p?.videoId === wanted?.videoId && p?.language === wanted?.language;
  });
  if (sameLanguage && opts.replaceAssetId !== sameLanguage.id) return { kind: 'conflict', existing: sameLanguage };

  const assetId = await client.uploadHtmlAsset(name, toTranscriptAssetHtml(capture));
  if (sameLanguage) await client.replaceAsset(bookmark.id, sameLanguage.id, assetId);
  else await client.attachAsset(bookmark.id, assetId);
  if (opts.tag) await client.attachTags(bookmark.id, [opts.tag]);
  return { kind: sameLanguage ? 'replaced' : 'attached' };
}

/** The URL a new bookmark is created with: canonical for YouTube videos, else the tab URL. */
export function bookmarkUrl(tabUrl: string): string {
  const id = videoIdFromUrl(tabUrl);
  return id ? canonicalVideoUrl(id) : tabUrl;
}

/** Karakeep matches URLs exactly (minus hash), so a video saved as `watch?v=ID&t=30s` needs both lookups. */
export async function findBookmark(checkUrl: (url: string) => Promise<string | null>, tabUrl: string) {
  const found = await checkUrl(tabUrl);
  const canonical = bookmarkUrl(tabUrl);
  return found ?? (canonical !== tabUrl ? checkUrl(canonical) : null);
}
