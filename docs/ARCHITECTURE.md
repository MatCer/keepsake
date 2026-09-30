# Keepsake architecture

Keepsake is a Karakeep companion extension (Chrome/Firefox, MV3). One click on the
toolbar button opens the popup, which:

1. saves the current tab to Karakeep (automatically, or after confirmation when
   auto-save is off), then shows its tags, lists, note and the **scraped copy**
   Karakeep stored;
2. captures the page as Markdown (Defuddle, the engine behind Obsidian Web Clipper)
   or, on a YouTube watch/shorts/live page, the **transcript already rendered in the
   page**, and lets you copy it, download it, attach it to the bookmark or open it in
   Obsidian.

## Hard rules

- **Zero YouTube requests from the extension.** YouTube capture reads the DOM and the
  player object that is already in memory. No `fetch`, no XHR, no clicking the
  transcript button, no extra tab, no timedtext/innertube/API fallback. If the panel is
  not open, the popup says so and asks the user to open it and retry.
- Capture runs only after a click (`activeTab` + `scripting`). No content scripts are
  registered, no polling, no host permission at install time.
- The only network destination is the Karakeep origin the user configured. Its host
  permission is requested at runtime for that exact origin.
- Page text, titles and transcripts are untrusted: escaped for Markdown/YAML/HTML,
  size limited (`LIMITS` in `src/lib/types.ts`), never logged.

## Karakeep storage (verified against the deployed v0.32.0)

The deployed server reports `{"version":"0.32.0"}` at `/api/version`. Checked in the
`v0.32.0` tag of `karakeep-app/karakeep`:

| option | verdict |
|---|---|
| `PATCH /bookmarks/{id}` `note`/`text`/`description` | Rejected. Overwrites user- or crawler-owned fields. |
| attach as `linkHtmlContent` | Impossible: `isAllowedToAttachAsset` returns false for it (`packages/trpc/lib/attachments.ts`). The scraped HTML cannot be replaced through the API. |
| `POST /assets` (`text/html`) + `POST /bookmarks/{id}/assets` with `assetType: "userUploaded"` | **Used.** `text/html` is in `SUPPORTED_UPLOAD_ASSET_TYPES`, `userUploaded` is attachable, and the web UI lists it under Attachments with its file name. Nothing else on the bookmark changes. |
| `GET /bookmarks/{id}/content` (Markdown) | Not in 0.32.0. The scraped copy is read from `GET /bookmarks/{id}?includeContent=true` → `content.htmlContent`. |

The transcript asset is a small HTML document: readable transcript with timestamp links
for humans, plus the full capture record as
`<script type="application/json" id="keepsake-capture">` (with `<` escaped as `<`)
for machines. File name: `keepsake-transcript-<videoId>-<lang|und>-<sha256[:12]>.html`.

Idempotency: before uploading, the popup reads `bookmark.assets[].fileName`.
- same video + language + hash already attached → nothing to do ("already attached");
- same video + language, different hash → ask before replacing (`PUT
  /bookmarks/{id}/assets/{assetId}`), showing both lengths; never silent;
- bookmark creation is idempotent in Karakeep itself (`POST /bookmarks` returns the
  existing bookmark with 200 for a known URL).

## Modules (`src/lib`)

| file | responsibility |
|---|---|
| `types.ts` | shared contract (done) |
| `youtube.ts` | `videoIdFromUrl(url)`, `isYoutubeVideoUrl`, `canonicalVideoUrl(id)`, `parseTimestamp("1:02:03")→3723`, `formatTimestamp(3723)→"1:02:03"`, `readTranscript(doc, player, url)→CaptureResult` |
| `page.ts` | `capturePage(doc, url)→CaptureResult` via `defuddle/full` (`useAsync:false`, Markdown) |
| `format.ts` | `toMarkdown(capture)`, `toJson(capture)`, `toTranscriptAssetHtml(capture)`, `parseTranscriptAssetHtml(html)`, `assetFileName(capture)`, `noteFileName(capture)`; YAML/Markdown/HTML escaping |
| `hash.ts` | `sha256Hex(text)` via `crypto.subtle` |
| `karakeep.ts` | typed REST client with timeouts and bounded retries |
| `settings.ts` | `chrome.storage.local` settings; API key never in `storage.sync` |
| `outbox.ts` | captures whose upload failed, persisted until sent or dismissed |

### YouTube transcript reading (`readTranscript`)

Observed live on 2026-09-30: desktop YouTube renders `transcript-segment-view-model`
inside an engagement panel (`div.ytwTranscriptSegmentViewModelTimestamp` for the time,
`span.ytAttributedStringHost` for the text, `timeline-chapter-view-model h3` for chapter
titles). The legacy `ytd-transcript-segment-renderer` (`.segment-timestamp`,
`.segment-text`) is still supported. After an SPA navigation the previous video's
segments linger for ~1.5 s in a panel whose `visibility` is
`ENGAGEMENT_PANEL_VISIBILITY_HIDDEN`, so:

1. URL must be a watch/shorts/live URL; its id must equal `player.videoId` and, when
   present, `ytd-watch-flexy[video-id]`. Otherwise `stale`.
2. Only segments inside a `ytd-engagement-panel-section-list-renderer` whose
   `visibility` ends in `EXPANDED` count.
3. The last segment start must be ≤ `lengthSeconds + 5` when the length is known,
   otherwise `stale`.
4. No segments: `no-captions` when the player lists no caption tracks, otherwise
   `panel-not-loaded`.
5. Language: the only caption track if there is exactly one; else the legacy panel footer
   label matched against track names; else `null`. `generated` follows the matched track.
6. Empty text segments are dropped; zero non-empty segments is never "captured". A video
   description alone never produces a capture.

`player` comes from a MAIN-world probe that calls `#movie_player.getPlayerResponse()`
(already in memory) and returns only the fields in `PlayerSnapshot`.

## Popup flow

```
open popup ─► settings ok? ─no─► "Connect Karakeep" (options)
   │yes
   ├─► auto-save on? POST /bookmarks (idempotent) : GET /bookmarks/check-url → "Save" button
   ├─► bookmark card: title, tags (add/remove, suggestions), lists (toggle), note (explicit save)
   ├─► tab "Capture": run injected capture → state banner → Copy MD / Download MD|JSON / Attach / Obsidian
   └─► tab "Scraped": sandboxed iframe (srcdoc, CSP default-src 'none') of content.htmlContent
```

Failed Karakeep writes retry 3× with backoff (0.5 s, 1.5 s, 4 s; only network errors,
429 and 5xx), then the capture goes to the outbox with a visible "Retry" and is never
dropped silently.

## Server side: brain_janitor integration (proposal, not deployed)

`integration/hermes/` contains:

- `keepsake_import.py`: for bookmarks with a `keepsake-transcript-*.html` attachment,
  downloads the asset (`GET /api/v1/assets/{id}`), validates the embedded record (schema,
  11-char id matching the bookmark URL, non-empty text, size), and writes
  `cache/yt_transcripts/<id>.json` in the existing shape
  `{status, language, generated, text}`. Provenance goes to a separate
  `cache/yt_transcripts_provenance/<id>.json`, so `yt_transcript.py get` and the hourly
  gate keep working unchanged. It never overwrites an existing `ok` cache entry unless
  that entry is its own earlier import (its text hash still matches the provenance
  file), i.e. never an API-fetched or hand-edited transcript.
- `yt_transcript.patch`: in `prefetch()`, run the import first, then skip bookmarks
  younger than `grace_minutes` (default 30: time to clip after bookmarking), and only
  call YouTube when `api_fallback` is true. Settings live in
  `cache/yt_transcripts/_config.json`; the defaults keep today's behaviour apart from the
  grace period.

Because a cache file now exists, the existing `status(vid) == 'pending'` check already
makes the prefetch skip browser-captured videos. No new HTTP endpoint is needed: the
Karakeep attachment is the hand-off, and brain_janitor already holds Karakeep
credentials.
