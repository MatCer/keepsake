import { CAPTURE_SCHEMA, type YoutubeCapture } from '../types';
export function capture(): YoutubeCapture {
  return { schema: CAPTURE_SCHEMA, kind: 'youtube-transcript', provenance: 'browser-dom', capturedAt: '2026-09-30T12:00:00Z', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Paper workshop', video: { id: 'dQw4w9WgXcQ', channel: 'Maker', publishedAt: '2026-09-01', durationSeconds: 90, description: 'Build a kite. Fly it tomorrow.' }, transcript: { language: 'en', languageLabel: 'English', generated: false, text: 'Fold the paper.', segments: [{ start: 1, text: 'Fold the paper.' }], chapters: [{ start: 1, title: 'First folds' }], sha256: 'a'.repeat(64) } };
}
