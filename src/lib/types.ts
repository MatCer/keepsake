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
  /** Chapter headings shown in the panel; `start` is the first segment under it. */
  chapters: { title: string; start: number }[];
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

export interface Settings {
  /** Karakeep base URL, e.g. https://karakeep.example.com (no trailing slash). */
  address: string;
  /** Stored in chrome.storage.local only. Never synced or exported. */
  apiKey: string;
  /** Save the tab to Karakeep as soon as the popup opens. */
  autoSave: boolean;
  /** Attach a captured YouTube transcript to the bookmark without a click. */
  autoAttach: boolean;
  /** Click YouTube's "Show transcript" button when the transcript panel is closed. */
  autoOpenTranscript: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Obsidian vault name for obsidian://new; empty disables the Obsidian button. */
  obsidianVault: string;
  obsidianFolder: string;
  /** Tag added to the bookmark when a transcript is attached; empty = none. */
  transcriptTag: string;
}

export const DEFAULT_SETTINGS: Settings = {
  address: '',
  apiKey: '',
  autoSave: true,
  autoAttach: true,
  autoOpenTranscript: true,
  theme: 'system',
  obsidianVault: '',
  obsidianFolder: 'Clippings',
  transcriptTag: '',
};

export const LIMITS = {
  maxSegments: 20_000,
  maxTranscriptChars: 1_000_000,
  maxPageMarkdownChars: 2_000_000,
} as const;
