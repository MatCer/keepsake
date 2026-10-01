import { pageAssetFileName, toPageAssetHtml } from './format';
import { classify, plan, type JevConfig, type JevOptions } from './jev';
import type { KarakeepClient } from './karakeep';
import type { Capture } from './types';
import { videoIdFromUrl } from './youtube';

export type JevClient = Pick<KarakeepClient, 'getBookmark' | 'uploadHtmlAsset' | 'attachAsset' | 'allTags' | 'lists' | 'addToList' | 'attachTags'>;
export type JevOutcome = { kind: 'skipped' | 'mismatch' } | { kind: 'tagged'; lists: string[]; topic: string | null };
/** Background worker's answer to the popup's `{ type: 'jev-tag', bookmarkId, capture }` message. */
export type JevReply = { ok: true; outcome: JevOutcome } | { ok: false; message: string };
let queue: Promise<unknown> = Promise.resolve();
export function jevTag(client: JevClient, bookmarkId: string, capture: Capture, config: JevConfig, opts: JevOptions = {}): Promise<JevOutcome> {
  const run = queue.then(() => tagOnce(client, bookmarkId, capture, config, opts));
  queue = run.catch(() => undefined);
  return run;
}
async function tagOnce(client: JevClient, id: string, capture: Capture, config: JevConfig, opts: JevOptions): Promise<JevOutcome> {
  const bookmark = await client.getBookmark(id, false);
  if (bookmark.tags.some(t => t.name === 'jev-tagged' || t.name === 'janitor-processed')) return { kind: 'skipped' };
  const url = bookmark.content.url ?? '';
  if (capture.kind === 'youtube-transcript' ? videoIdFromUrl(url) !== capture.video.id : url.split('#')[0] !== capture.url.split('#')[0]) return { kind: 'mismatch' };
  if (capture.kind === 'page') {
    const name = pageAssetFileName(capture);
    if (!bookmark.assets.some(a => a.fileName === name)) {
      const asset = await client.uploadHtmlAsset(name, toPageAssetHtml(capture));
      await client.attachAsset(id, asset);
    }
  }
  const topics = (await client.allTags()).filter(t => t.name.startsWith('topic-') && (t.numBookmarks ?? 0) >= 2).map(t => t.name).sort().slice(0, 250);
  const result = plan(await classify(config, {
    title: capture.title, url: capture.url,
    description: capture.kind === 'page' ? capture.page.description : capture.video.description,
    page_text_start: capture.kind === 'page' ? capture.page.markdown : capture.transcript.segments.map(s => s.text).join(' '),
  }, topics, opts));
  // Marker first: a popup closed mid-run must not lead to a second, different classification.
  // Missing list memberships are then filled in by the server triage agent.
  await client.attachTags(id, [...(result.topic ? [result.topic] : []), 'jev-tagged']);
  const available = await client.lists();
  const lists: string[] = [];
  for (const [parent, child] of result.lists) {
    const root = available.find(l => l.name === parent && l.parentId === null && l.type === 'manual');
    const list = root && available.find(l => l.name === child && l.parentId === root.id && l.type === 'manual');
    if (!list) continue;
    await client.addToList(list.id, id);
    lists.push(`${parent} > ${child}`);
  }
  return { kind: 'tagged', lists, topic: result.topic };
}
