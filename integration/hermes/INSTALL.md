# Keepsake → brain_janitor

**Nothing here has been deployed. Deployment requires operator approval.**

The prefetch tick imports browser transcript attachments from Karakeep before any
YouTube fallback. Imports keep the existing cache shape; ownership and capture
metadata live in `cache/yt_transcripts_provenance/`. API-fetched and hand-edited
transcripts are preserved. Re-importing identical text does nothing.

All link bookmarks are considered for imports. YouTube fallback remains limited
to one pending hourly-queue video per tick, with the existing cap/block handling.
New bookmarks get a 30-minute browser-capture grace period. Invalid/missing dates
do not delay fallback. Language preference is en, sk, cs, then the last attachment;
ties also use the last attachment. A rejected chosen asset skips that bookmark.

## Deploy (operator-approved only)

After approval, stage these files in the container. From the brain_janitor profile
directory (replace `/staged/hermes` below with their actual staging path):

```sh
cp scripts/yt_transcript.py "scripts/yt_transcript.py.bak-$(date +%Y%m%d-%H%M%S)"
cp /staged/hermes/keepsake_import.py scripts/
cd scripts
patch --dry-run -p1 < /staged/hermes/yt_transcript.patch
patch -p1 < /staged/hermes/yt_transcript.patch
# Alternatively, copy /staged/hermes/yt_transcript.py over yt_transcript.py.
python3 yt_transcript.py --selftest
python3 keepsake_import.py --selftest
```

Use Python 3.12. The importer uses only the standard library; existing YouTube
fallback still needs the profile's existing `youtube_transcript_api` installation.
No cron or gate changes are needed. The sibling importer reads `config.yaml` in
the profile root using the same address/key rules as the gate, with a 30s timeout.
Tests/selftests are offline and never print capture text or credentials.

Optional `cache/yt_transcripts/_config.json` (relative to the profile root):

```json
{"api_fallback": false, "grace_minutes": 30}
```

Defaults: fallback true, grace 30 minutes. Grace accepts a finite nonnegative
number (0 disables it); malformed settings and wrong types use defaults. Unknown
keys are ignored. Disabling fallback still allows browser imports, including
during an existing API block.

Repository verification:

```sh
python3 -m unittest discover -s integration/hermes/tests
```

## ROLLBACK

Pause the prefetch cron while rolling back. From the profile root, restore the
chosen backup and remove the importer:

```sh
cp scripts/yt_transcript.py.bak-<date> scripts/yt_transcript.py
rm scripts/keepsake_import.py
```

Browser-imported cache entries are identified by matching files in
`cache/yt_transcripts_provenance/`. They remain compatible with the original
readers and may be kept. Preview them with:

```sh
find cache/yt_transcripts_provenance -maxdepth 1 -name '*.json' -print
```

If removal is wanted, review/back up those files and their matching
`cache/yt_transcripts/<videoId>.json` files, then delete each reviewed pair. Check
`cacheTextSha256` against the current text hash first if retaining later manual
edits matters. Do not delete `_state.json` or unrelated cache entries. Removing
an imported cache file makes that video **pending** again; restored prefetch may
fetch it through YouTube. The old script ignores `_config.json`; remove it if
desired. Resume the cron after rollback.
