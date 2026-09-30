# Keepsake → brain_janitor

**Nothing is deployed. Deployment requires operator approval.**

Karakeep is the only transcript store. Browser and YouTube API transcripts are
`userUploaded` HTML attachments on the video's link bookmark, named
`keepsake-transcript-<videoId>-<lang|und>-<sha256 first 12 hex>.html`.
The attachment contains readable timestamp links and the embedded capture record.
There is no transcript importer, local transcript cache, or provenance directory.
Existing `cache/yt_transcripts/<id>.json` files are ignored and can be deleted.
Only `_state.json` (pacing/block state) and optional `_config.json` stay local.

The hourly gate reads attachment/tag status from each bookmark without downloading
assets. Pending videos wait; attachments take precedence over the
`transcript-unavailable` tag. Language preference is en, sk, cs, then the last
attachment; ties also use the last attachment. `get` downloads and validates the
chosen attachment from Karakeep; it never calls YouTube. Invalid attachments return
exit 3 and need repair in Karakeep.

Prefetch uploads at most one pending hourly video's transcript per tick. Existing
hourly caps and 24-hour blocks remain; each attempt counts before fetching.
No captions adds `transcript-unavailable`. Upload/tag failures log only the error
type and leave the bookmark pending for retry. New bookmarks get a 30-minute
browser-capture grace period; missing/invalid dates do not delay fallback.

## Deploy (operator approval required)

Use Python 3.12. The new helper uses only the standard library; the existing API
fallback still uses the profile's installed `youtube_transcript_api`.
The helper reads profile `config.yaml` using the gate's address/key regexes,
uses Bearer auth with a 30-second timeout, refuses redirects, and caps downloads
at 16 MB. The cron wrapper is unchanged.

After approval, stage this directory inside the container. Pause the prefetch and
gate jobs during installation. From the brain_janitor profile root, replacing
`/staged/hermes` with the actual staging path:

```sh
# Do not overwrite an earlier rollback backup.
cp -n scripts/yt_transcript.py scripts/yt_transcript.py.bak
cp -n scripts/karakeep_gate.py scripts/karakeep_gate.py.bak
cd scripts
patch --dry-run -p1 < /staged/hermes/yt_transcript.patch
patch --dry-run -p1 < /staged/hermes/karakeep_gate.patch
# Continue only if BOTH dry runs succeed.
cp /staged/hermes/karakeep_transcripts.py .
patch -p1 < /staged/hermes/yt_transcript.patch
patch -p1 < /staged/hermes/karakeep_gate.patch
python3 yt_transcript.py --selftest
python3 karakeep_gate.py --selftest
```

Both selftests are offline; run them inside the container before resuming jobs.
The patches target the byte-identical deployed scripts in `upstream/`.
If either dry run fails, stop and compare the deployed version; do not force it.

## Config

Optional `cache/yt_transcripts/_config.json`, relative to the profile root:

```json
{"api_fallback": false, "grace_minutes": 30}
```

Set `api_fallback: false` to never call YouTube. Browser attachments remain readable
through Karakeep. Defaults are true and 30 minutes. Grace accepts a finite
nonnegative number (0 disables it); malformed settings and wrong types use
defaults. Unknown keys are ignored. Preserve `_state.json` across deployment.

Repository checks (Python 3.12; tests stub YouTube and use only 127.0.0.1 HTTP):

```sh
python3 -m unittest discover -s integration/hermes/tests
python3 integration/hermes/yt_transcript.py --selftest
python3 integration/hermes/karakeep_gate.py --selftest
```

## ROLLBACK

Pause the prefetch and gate jobs. From the profile root:

```sh
cp scripts/yt_transcript.py.bak scripts/yt_transcript.py
cp scripts/karakeep_gate.py.bak scripts/karakeep_gate.py
rm scripts/karakeep_transcripts.py
python3 scripts/yt_transcript.py --selftest
python3 scripts/karakeep_gate.py --selftest
```

Uploaded attachments and the `transcript-unavailable` tag remain in Karakeep and
are harmless. They can be removed in the Karakeep UI. Keep `_state.json`; restored
upstream scripts resume local caching and ignore `_config.json`. If old transcript
files were deleted, the restored prefetch will fetch them again under its pacing
limits. Resume jobs after both restored selftests pass.
