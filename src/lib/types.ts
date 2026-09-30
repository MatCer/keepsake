// Shared contract between the injected capture script, the popup and the adapters.

export const CAPTURE_SCHEMA = 'keepsake.capture/v1';

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

export interface Transcript {
  /** BCP-47-ish code from the caption track, or null when it cannot be told from the page. */
  language: string | null;
  /** Human label as YouTube shows it, e.g. "English (auto-generated)". */
  languageLabel: string | null;
  /** true for ASR tracks, null when unknown. */
  generated: boolean | null;
  segments: TranscriptSegment[];
  /** Segments joined with single spaces: the exact shape yt_transcript.py stores. */
  text: string;
  /** sha256 hex of `text`. Idempotency key together with video id and language. */
  sha256: string;
}

export interface VideoInfo {
  id: string;
  channel: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  description: string | null;
}

interface CaptureBase {
  schema: typeof CAPTURE_SCHEMA;
  provenance: 'browser-dom';
  capturedAt: string;
  /** Canonical URL: https://www.youtube.com/watch?v=<id> for videos. */
  url: string;
  title: string;
}

export interface YoutubeCapture extends CaptureBase {
  kind: 'youtube-transcript';
  video: VideoInfo;
  transcript: Transcript;
}

export interface PageCapture extends CaptureBase {
  kind: 'page';
  page: {
    markdown: string;
    author: string | null;
    published: string | null;
    site: string | null;
    description: string | null;
    sha256: string;
  };
}

export type Capture = YoutubeCapture | PageCapture;

/** Every outcome the popup must render distinctly. */
export type CaptureResult =
  | { status: 'captured'; capture: Capture }
  | { status: 'panel-not-loaded'; videoId: string }
  | { status: 'no-captions'; videoId: string }
  | { status: 'stale'; videoId: string }
  | { status: 'too-large'; bytes: number }
  | { status: 'unsupported'; reason: string };

/** What the MAIN-world probe reads from YouTube's player object. No network. */
export interface PlayerSnapshot {
  videoId: string | null;
  title: string | null;
  channel: string | null;
  lengthSeconds: number | null;
  publishDate: string | null;
  description: string | null;
  captionTracks: { languageCode: string; name: string; generated: boolean }[];
}

export const LIMITS = {
  maxSegments: 20_000,
  maxTranscriptChars: 2_000_000,
  maxPageMarkdownChars: 2_000_000,
} as const;
