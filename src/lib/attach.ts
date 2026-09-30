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
  | { kind: 'conflict'; existing: Asset };

/**
 * Attach a captured transcript to a bookmark as a `userUploaded` HTML asset.
 * Identical capture: nothing happens. A different capture in the same language is only
 * replaced when the caller passes that asset's id back after asking the user.
 */
export async function attachTranscript(
  client: AttachClient,
  bookmarkId: string,
  capture: YoutubeCapture,
  opts: { replaceAssetId?: string; tag?: string },
): Promise<AttachOutcome> {
  const bookmark = await client.getBookmark(bookmarkId, false);
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
