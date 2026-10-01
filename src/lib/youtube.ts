import { sha256Hex } from './hash';
import { CAPTURE_SCHEMA, LIMITS, type CaptureResult, type PlayerSnapshot, type TranscriptSegment } from './types';

const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
function parsedUrl(value: string): URL | null {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url : null; }
  catch { return null; }
}
export function videoIdFromUrl(value: string): string | null {
  const url = parsedUrl(value);
  if (!url) return null;
  let id: string | null = null;
  if (url.hostname === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  else if (hosts.has(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
/** Any YouTube-owned page. Only capturable video pages are read there; the rest never reach Defuddle. */
export function isYoutubeHost(value: string): boolean {
  const host = parsedUrl(value)?.hostname ?? '';
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host);
}
export function isCapturableVideoUrl(value: string): boolean {
  const url = parsedUrl(value);
  return !!url && hosts.has(url.hostname) && !url.pathname.startsWith('/embed/') && videoIdFromUrl(value) !== null;
}
export function canonicalVideoUrl(id: string): string { return `https://www.youtube.com/watch?v=${id}`; }
export function parseTimestamp(value: string): number | null {
  const text = value.trim();
  if (!/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(text)) return null;
  const result = text.split(':').reduce((sum, field) => sum * 60 + Number(field), 0);
  return Number.isSafeInteger(result) ? result : null;
}
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const tail = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
function text(element: Element | null): string { return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''; }

export async function readTranscript(doc: Document, url: string, player: PlayerSnapshot | null, now: Date): Promise<CaptureResult> {
  const id = videoIdFromUrl(url);
  if (!id || !isCapturableVideoUrl(url)) return { status: 'unsupported', reason: 'Not a YouTube video page' };
  const watchId = doc.querySelector('ytd-watch-flexy[video-id]')?.getAttribute('video-id');
  if ((player?.videoId && player.videoId !== id) || (watchId !== undefined && watchId !== id)) return { status: 'stale', videoId: id };
  const panels = [...doc.querySelectorAll('ytd-engagement-panel-section-list-renderer[visibility$="EXPANDED"]')];
  const segments: TranscriptSegment[] = [];
  const chapters: { start: number; title: string }[] = [];
  for (const panel of panels) {
    const pending: string[] = [];
    for (const node of panel.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer, timeline-chapter-view-model, ytd-transcript-section-header-renderer')) {
      if (node.matches('timeline-chapter-view-model, ytd-transcript-section-header-renderer')) {
        const title = text(node.querySelector('h3, #title') ?? node);
        if (title) pending.push(title);
        continue;
      }
      const start = parseTimestamp(text(node.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp')));
      const content = text(node.querySelector('span.ytAttributedStringHost, .segment-text'));
      if (start === null || !content) continue;
      for (const title of pending.splice(0)) chapters.push({ start, title });
      segments.push({ start, text: content });
    }
  }
  const last = segments[segments.length - 1];
  if (!last) return { status: player && player.captionTracks.length === 0 ? 'no-captions' : 'panel-not-loaded', videoId: id };
  // Segments carry no video id; without the player or watch-flexy confirming the current video they could be stale.
  if (!player?.videoId && watchId === undefined) return { status: 'stale', videoId: id };
  if (player?.lengthSeconds != null && last.start > player.lengthSeconds + 5) return { status: 'stale', videoId: id };
  const content = segments.map(segment => segment.text).join(' ');
  if (segments.length > LIMITS.maxSegments || content.length > LIMITS.maxTranscriptChars) return { status: 'too-large', bytes: new TextEncoder().encode(content).length };
  let label: string | null = null;
  for (const panel of panels) {
    const menu = panel.querySelector('#footer yt-sort-filter-sub-menu-renderer');
    if (menu) label = text(menu.querySelector('[aria-selected="true"], [selected], .iron-selected') ?? menu.querySelector('#label, #dropdown-trigger, .dropdown-trigger') ?? menu) || null;
    if (label) break;
  }
  const tracks = player?.captionTracks ?? [];
  const track = tracks.length === 1 ? tracks[0] : tracks.find(track => track.name.trim() === label);
  return { status: 'captured', capture: {
    schema: CAPTURE_SCHEMA, kind: 'youtube-transcript', provenance: 'browser-dom', capturedAt: now.toISOString(), url: canonicalVideoUrl(id),
    title: player?.title ?? (text(doc.querySelector('ytd-watch-metadata h1')) || doc.title.replace(/ - YouTube$/, '')),
    video: { id, channel: player?.channel ?? (text(doc.querySelector('ytd-watch-metadata ytd-channel-name a')) || null), description: player?.description ?? null, publishedAt: player?.publishDate ?? null, durationSeconds: player?.lengthSeconds ?? null },
    transcript: { language: track?.languageCode ?? null, languageLabel: track?.name ?? label, generated: track?.generated ?? (label?.endsWith('(auto-generated)') ? true : null), segments, chapters, text: content, sha256: await sha256Hex(content) },
  } };
}

/** Serialized into MAIN world: all runtime dependencies must stay inside this function. */
/**
 * readTranscript, but when the panel is closed and `open` is set, clicks YouTube's own
 * "Show transcript" button first. YouTube then loads the transcript exactly as after a manual
 * click (one request from the page itself); Keepsake still fetches nothing. Waits up to 10 s.
 */
export async function readOrOpenTranscript(doc: Document, url: string, player: PlayerSnapshot | null, now: Date, open: boolean, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<CaptureResult> {
  let result = await readTranscript(doc, url, player, now);
  if (!open || result.status !== 'panel-not-loaded') return result;
  const button = doc.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button');
  if (!button) return result;
  button.click();
  let seen = -1;
  for (let waited = 0; waited < 10_000; waited += 250) {
    await sleep(250);
    result = await readTranscript(doc, url, player, now);
    if (result.status !== 'panel-not-loaded' && result.status !== 'captured') return result;
    const count = result.status === 'captured' && result.capture.kind === 'youtube-transcript' ? result.capture.transcript.segments.length : -1;
    // A long transcript may render in batches: done once two reads in a row agree.
    if (count > 0 && count === seen) return result;
    seen = count;
  }
  return result;
}

export function probePlayer(): PlayerSnapshot {
  interface PlayerElement extends Element { getPlayerResponse?: unknown }
  interface ResponseFields { videoDetails?: unknown; microformat?: unknown; captions?: unknown }
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
  const result: PlayerSnapshot = { videoId: null, title: null, channel: null, lengthSeconds: null, publishDate: null, description: null, captionTracks: [] };
  try {
    const element = document.querySelector<PlayerElement>('#movie_player');
    if (typeof element?.getPlayerResponse !== 'function') return result;
    const raw: unknown = element.getPlayerResponse();
    if (!record(raw)) return result;
    const response: ResponseFields = raw;
    const details = record(response.videoDetails) ? response.videoDetails : {};
    result.videoId = string(details.videoId); result.title = string(details.title); result.channel = string(details.author); result.description = string(details.shortDescription);
    const duration = typeof details.lengthSeconds === 'string' || typeof details.lengthSeconds === 'number' ? Number(details.lengthSeconds) : NaN;
    result.lengthSeconds = Number.isFinite(duration) && duration >= 0 ? duration : null;
    const microformat = record(response.microformat) ? response.microformat.playerMicroformatRenderer : null;
    if (record(microformat)) result.publishDate = string(microformat.publishDate);
    const captions = record(response.captions) ? response.captions.playerCaptionsTracklistRenderer : null;
    if (record(captions) && Array.isArray(captions.captionTracks)) {
      for (const track of captions.captionTracks) {
        if (!record(track) || typeof track.languageCode !== 'string') continue;
        const name = record(track.name) ? track.name : {};
        const label = string(name.simpleText) ?? (Array.isArray(name.runs) ? name.runs.map((run: unknown) => record(run) ? string(run.text) ?? '' : '').join('') : '');
        result.captionTracks.push({ languageCode: track.languageCode, name: label, generated: track.kind === 'asr' });
      }
    }
    return result;
  } catch { return { videoId: null, title: null, channel: null, lengthSeconds: null, publishDate: null, description: null, captionTracks: [] }; }
}
