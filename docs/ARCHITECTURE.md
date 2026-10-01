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
  player object that is already in memory. No `fetch`, no XHR, no extra tab, no
  timedtext/innertube/API fallback. If the panel is closed and *Open YouTube transcript
  automatically* is on (default), capture clicks YouTube's own **Show transcript** button
  and waits up to 10 s for the segments, then closes the panel it opened with YouTube's
  close button; YouTube's page sends the same single
  `youtubei/v1/get_panel` request a manual click sends. With the setting off, the popup asks
  the user to open the panel and retry.
- Capture runs only after a click (`activeTab` + `scripting`). No content scripts are
  registered, no polling, no host permission at install time.
- Network destinations are the configured Karakeep origin and the optional Jev endpoint
  (default `api.openjev.sh`). Both require runtime host permission. Jev is disabled unless a
  local API key is set. Jev tagging runs in the background worker (`entrypoints/background.ts`),
  which reads keys from storage itself; the popup only sends `{ type: 'jev-tag', bookmarkId, capture }`
  and the worker accepts it only from extension pages.
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
| `POST <Jev endpoint>` (default `https://api.openjev.sh/v1/systemone`) | Optional classification, configurable model (default `openjev`), bearer key, 30 s timeout; title/URL, description ≤600 characters, page text/transcript ≤3,000 characters. |
| `GET /tags`, `GET /lists`, `PUT /lists/{id}/bookmarks/{id}`, `POST /bookmarks/{id}/tags` | Jev uses sorted `topic-*` tags with ≥2 bookmarks (first 250), resolves manual lists by parent/child, and writes topic plus `jev-tagged` before list memberships. |
| `GET /bookmarks/{id}/content` (Markdown) | Not in 0.32.0. The scraped copy is read from `GET /bookmarks/{id}?includeContent=true` → `content.htmlContent`. |

The transcript asset is a small HTML document: readable transcript with timestamp links
for humans, plus the full capture record as
`<script type="application/json" id="keepsake-capture">` (with `<` escaped as `<`)
for machines. File name: `keepsake-transcript-<videoId>-<lang|und>-<sha256[:12]>.html`.

Page assets wrap escaped Defuddle Markdown in `<pre>` plus the full JSON record, named
`keepsake-page-<sha256[:12]>.html`. Jev uploads them before classification, reusing
an exact filename on retry. Classification failures are non-blocking popup warnings.

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
| `format.ts` | `toMarkdown(capture)`, `toJson(capture)`, `toTranscriptAssetHtml(capture)`, `toPageAssetHtml(capture)`, `pageAssetFileName(capture)`, `parseTranscriptAssetHtml(html)`, `assetFileName(capture)`, `noteFileName(capture)`; YAML/Markdown/HTML escaping |
| `jev.ts` | Jev request/answer validation and classification plan; topic threshold 0.5 |
| `jev-tag.ts` | Serialized auto-tagging; skip `jev-tagged`/`janitor-processed`, verify URL, attach page HTML once, apply lists/tags |
| `hash.ts` | `sha256Hex(text)` via `crypto.subtle` |
| `karakeep.ts` | typed REST client with timeouts and bounded retries |
| `settings.ts` | `chrome.storage.local` settings; Karakeep/Jev keys never in `storage.sync` |
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

## Server side: brain_janitor

Karakeep is the only place transcripts live. A video's transcript is the
`keepsake-transcript-*.html` attachment on its link bookmark, whether the browser
extension uploaded it (`provenance: browser-dom`) or brain_janitor's paced API fallback
did (`provenance: youtube-api`). The brain_janitor scripts that read, prefetch and gate on
these attachments live in the private `MatCer/hermes-setup` repo
(`profiles/brain_janitor/scripts`); `e2e/hermes_e2e.py` runs them against the local
Karakeep when that repo is checked out next to this one (or `HERMES_SCRIPTS` points to it).
