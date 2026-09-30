import Defuddle, { createMarkdownContent } from 'defuddle/full';
import { sha256Hex } from './hash';
import { CAPTURE_SCHEMA, LIMITS, type CaptureResult, type PlayerSnapshot } from './types';
import { isCapturableVideoUrl, readTranscript } from './youtube';

export async function capturePage(doc: Document, url: string, now: Date): Promise<CaptureResult> {
  try {
    if (!['https:', 'http:'].includes(new URL(url).protocol)) return { status: 'unsupported', reason: 'Not an HTTP page' };
  } catch { return { status: 'unsupported', reason: 'Not an HTTP page' }; }
  // Keep even direct callers from reaching Defuddle's video extractor.
  if (isCapturableVideoUrl(url)) return readTranscript(doc, url, null, now);
  try {
    // Defuddle clones extraction roots and fallback bodies internally.
    const result = new Defuddle(doc, { url, useAsync: false }).parse();
    const markdown = createMarkdownContent(result.content, url);
    if (!markdown.trim()) return { status: 'unsupported', reason: 'No readable content on this page' };
    if (markdown.length > LIMITS.maxPageMarkdownChars) return { status: 'too-large', bytes: new TextEncoder().encode(markdown).length };
    const nullable = (value: string): string | null => value.trim() || null;
    return { status: 'captured', capture: {
      schema: CAPTURE_SCHEMA, kind: 'page', provenance: 'browser-dom', capturedAt: now.toISOString(), url, title: result.title || doc.title,
      page: { markdown, author: nullable(result.author), published: nullable(result.published), site: nullable(result.site), description: nullable(result.description), sha256: await sha256Hex(markdown) },
    } };
  } catch { return { status: 'unsupported', reason: 'Could not read this page' }; }
}

export function captureDocument(doc: Document, url: string, player: PlayerSnapshot | null, now: Date): Promise<CaptureResult> {
  return isCapturableVideoUrl(url) ? readTranscript(doc, url, player, now) : capturePage(doc, url, now);
}
