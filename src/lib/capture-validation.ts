import { CAPTURE_SCHEMA, LIMITS, type YoutubeCapture } from './types';
import { canonicalVideoUrl } from './youtube';

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function isNullableString(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function isYoutubeCapture(value: unknown): value is YoutubeCapture {
  if (!isRecord(value) || value.schema !== CAPTURE_SCHEMA || value.kind !== 'youtube-transcript' || value.provenance !== 'browser-dom' || typeof value.title !== 'string' || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) return false;
  const v = value.video; const t = value.transcript;
  if (!isRecord(v) || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(v.id) || value.url !== canonicalVideoUrl(v.id) || !isNullableString(v.channel) || !isNullableString(v.description) || !isNullableString(v.publishedAt) || !(v.durationSeconds === null || nonnegative(v.durationSeconds))) return false;
  if (!isRecord(t) || !isNullableString(t.language) || !isNullableString(t.languageLabel) || !(t.generated === null || typeof t.generated === 'boolean') || typeof t.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(t.sha256) || typeof t.text !== 'string' || !t.text.trim() || t.text.length > LIMITS.maxTranscriptChars || !Array.isArray(t.segments) || !t.segments.length || t.segments.length > LIMITS.maxSegments) return false;
  const texts: string[] = [];
  for (const segment of t.segments) {
    if (!isRecord(segment) || !nonnegative(segment.start) || typeof segment.text !== 'string' || !segment.text.trim()) return false;
    texts.push(segment.text);
  }
  if (t.text !== texts.join(' ')) return false;
  if (t.chapters !== undefined && (!Array.isArray(t.chapters) || t.chapters.length > LIMITS.maxSegments || !t.chapters.every((chapter: unknown) => isRecord(chapter) && nonnegative(chapter.start) && typeof chapter.title === 'string' && !!chapter.title.trim()))) return false;
  return true;
}
