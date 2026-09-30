import { browser } from 'wxt/browser';
import { isCapturableVideoUrl, probePlayer } from '../lib/youtube';
import type { CaptureResult, PlayerSnapshot } from '../lib/types';

// Bounded so a hostile page can't hand back megabytes of "metadata".
const str = (v: unknown, max = 10_000) => (typeof v === 'string' ? v.slice(0, max) : null);

/** The MAIN-world snapshot comes from the page's JS, so it is re-checked here before use. */
export function sanitizePlayer(v: unknown): PlayerSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const tracks = Array.isArray(p.captionTracks) ? p.captionTracks.slice(0, 200) : [];
  return {
    videoId: str(p.videoId),
    title: str(p.title),
    channel: str(p.channel),
    lengthSeconds: typeof p.lengthSeconds === 'number' && Number.isFinite(p.lengthSeconds) ? p.lengthSeconds : null,
    publishDate: str(p.publishDate),
    description: str(p.description),
    captionTracks: tracks.flatMap((t: unknown) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return typeof o.languageCode === 'string' && typeof o.name === 'string'
        ? [{ languageCode: o.languageCode.slice(0, 35), name: o.name.slice(0, 200), generated: o.generated === true }]
        : [];
    }),
  };
}

/**
 * Runs only because the user opened the popup (activeTab). Reads the page; never fetches.
 * YouTube: a MAIN-world read of the in-memory player response, then the isolated-world DOM reader.
 */
export async function runCapture(tabId: number, url: string): Promise<CaptureResult> {
  try {
    let player: PlayerSnapshot | null = null;
    if (isCapturableVideoUrl(url)) {
      const [probe] = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probePlayer });
      player = sanitizePlayer(probe?.result);
    }
    await browser.scripting.executeScript({ target: { tabId }, files: ['/capture.js'] });
    const [out] = await browser.scripting.executeScript({
      target: { tabId },
      func: (p: PlayerSnapshot | null) =>
        (globalThis as unknown as { __keepsakeCapture: (p: PlayerSnapshot | null) => Promise<CaptureResult> })
          .__keepsakeCapture(p),
      args: [player],
    });
    return (out?.result as CaptureResult | undefined) ?? { status: 'unsupported', reason: 'The page returned nothing' };
  } catch {
    return { status: 'unsupported', reason: 'The browser does not allow extensions on this page' };
  }
}
