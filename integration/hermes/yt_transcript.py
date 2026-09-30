#!/usr/bin/env python3
"""
yt_transcript - paced YouTube transcripts stored only in Karakeep attachments.

The cron job fetches at most ONE pending hourly bookmark per tick, capped at
MAX_PER_HOUR. On a block it stops for BLOCK_HOURS. Browser captures are already
attachments; get reads them from Karakeep, never from YouTube.
Only pacing state and optional config stay in cache/yt_transcripts.
_config.json controls api_fallback (default true) and grace_minutes (default 30).

  yt_transcript.py prefetch        # cron: fetch <=1 transcript; stdout (block notice) goes to Discord
  yt_transcript.py get <url|id>    # exit 0 = transcript on stdout, 2 = pending, 3 = unavailable
  yt_transcript.py --selftest
"""
import json
import re
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

import karakeep_transcripts as transcripts

PROFILE_HOME = Path(__file__).resolve().parent.parent
CACHE = PROFILE_HOME / 'cache/yt_transcripts'
STATE = CACHE / '_state.json'
MAX_PER_HOUR = 10
BLOCK_HOURS = 24
LANGS = ['en', 'sk', 'cs']

ID_RE = re.compile(r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/)|youtu\.be/)([\w-]{11})')


def video_id(s):
    if re.fullmatch(r'[\w-]{11}', s):
        return s
    m = ID_RE.search(s or '')
    return m.group(1) if m else None


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


status = transcripts.status


def config():
    out = {'api_fallback': True, 'grace_minutes': 30}
    try:
        d = load(CACHE / '_config.json', {})
    except (OSError, ValueError):
        return out
    if isinstance(d, dict):
        if type(d.get('api_fallback')) is bool:
            out['api_fallback'] = d['api_fallback']
        n = d.get('grace_minutes')
        if type(n) in (int, float) and 0 <= n <= sys.float_info.max / 60:
            out['grace_minutes'] = n
    return out


def in_grace(bookmark, now, minutes):
    try:
        created = datetime.fromisoformat(bookmark['createdAt'])
        if created.tzinfo is None:
            return False
        return minutes > 0 and now - created.timestamp() < minutes * 60
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def may_fetch(state, now):
    """None if a fetch is allowed now, else the reason for waiting."""
    if now < state.get('blocked_until', 0):
        return 'blocked'
    if sum(now - t < 3600 for t in state.get('fetches', [])) >= MAX_PER_HOUR:
        return 'hourly cap'
    return None


def fetch(vid):
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound
    tl = YouTubeTranscriptApi().list(vid)
    try:
        t = tl.find_transcript(LANGS)
    except NoTranscriptFound:
        t = next(iter(tl))
    segments = [{'start': round(s.start, 3), 'text': s.text} for s in t.fetch() if s.text.strip()]
    text = ' '.join(s['text'] for s in segments)
    return {'language': t.language_code, 'generated': t.is_generated,
            'segments': segments, 'text': text, 'sha256': transcripts.digest(text)}


def prefetch():
    from karakeep_gate import fetch_bookmarks, in_hourly
    bookmarks = fetch_bookmarks()
    cfg = config()
    if not cfg['api_fallback']:
        return
    state, now = load(STATE, {}), time.time()
    if may_fetch(state, now):
        return
    todo = [b for b in bookmarks if in_hourly(b)
            and video_id((b.get('content') or {}).get('url') or '')
            and status(b) == 'pending' and not in_grace(b, now, cfg['grace_minutes'])]
    if not todo:
        return
    from youtube_transcript_api._errors import CouldNotRetrieveTranscript, RequestBlocked, YouTubeRequestFailed
    b = todo[0]
    vid = video_id(b['content']['url'])
    # record the attempt before the request, so failures count against the cap too
    state['fetches'] = [t for t in state.get('fetches', []) if now - t < 3600] + [now]
    CACHE.mkdir(parents=True, exist_ok=True)
    save(STATE, state)
    try:
        transcript = fetch(vid)
    except (RequestBlocked, YouTubeRequestFailed) as e:
        state['blocked_until'] = now + BLOCK_HOURS * 3600
        save(STATE, state)
        print(f'YouTube zablokoval transcript requesty ({type(e).__name__}) pri videu {vid}. '
              f'Prefetch prepisov je pozastavený na {BLOCK_HOURS} h, {len(todo)} videí čaká v rade.')
        return
    except CouldNotRetrieveTranscript:
        try:
            transcripts.add_tag(b['id'], transcripts.UNAVAILABLE_TAG)
        except Exception as e:  # retry next tick; exception messages may contain secrets
            print(type(e).__name__, file=sys.stderr)
        return
    # Other fetch errors propagate; the attempt still counts against the cap.
    record = {
        'schema': 'keepsake.capture/v1', 'provenance': 'youtube-api', 'kind': 'youtube-transcript',
        'capturedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'url': f'https://www.youtube.com/watch?v={vid}',
        'title': b.get('title') or (b.get('content') or {}).get('title') or '',
        'video': {'id': vid, 'channel': None, 'publishedAt': None, 'durationSeconds': None, 'description': None},
        'transcript': {**transcript, 'languageLabel': None, 'chapters': []},
    }
    try:
        transcripts.upload(b, record)
    except Exception as e:  # leave pending for a paced retry
        print(type(e).__name__, file=sys.stderr)


def get(arg):
    vid = video_id(arg)
    if not vid:
        print('not a YouTube URL or id')
        return 3
    bookmark = transcripts.find_bookmark(arg)
    if bookmark is None:
        print('PENDING: this video is not in Karakeep yet; bookmark it first.')
        return 2
    state = status(bookmark)
    if state == 'pending':
        print('PENDING: transcript not fetched yet; the paced prefetch job will get it. Leave this bookmark for a later run.')
        return 2
    if state == 'unavailable':
        print('UNAVAILABLE: no captions for this video')
        return 3
    d = transcripts.read(bookmark)
    if d is None:
        print('UNAVAILABLE: the transcript attachment is invalid')
        return 3
    print(f"[transcript language={d.get('language') or 'und'} auto_generated={d.get('generated')}]\n{d['text']}")
    return 0


def selftest():
    from tempfile import TemporaryDirectory
    from unittest.mock import patch
    with TemporaryDirectory() as tmp, patch.object(sys.modules[__name__], 'CACHE', Path(tmp)):
        assert config() == {'api_fallback': True, 'grace_minutes': 30}
    now = datetime(2026, 9, 30, 20, tzinfo=timezone.utc).timestamp()
    assert in_grace({'createdAt': '2026-09-30T19:45:00Z'}, now, 30)
    assert not in_grace({'createdAt': '2026-09-30T19:30:00Z'}, now, 30)
    assert not in_grace({'createdAt': 'invalid'}, now, 30)
    assert video_id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1') == 'dQw4w9WgXcQ'
    assert video_id('https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('https://youtu.be/dQw4w9WgXcQ?si=abc') == 'dQw4w9WgXcQ'
    assert video_id('https://youtube.com/shorts/dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('https://example.com/watch?v=dQw4w9WgXcQ') is None
    assert status({'content': None}) == 'pending'
    assert status({'tags': [{'name': transcripts.UNAVAILABLE_TAG}]}) == 'unavailable'
    record = {'schema': 'keepsake.capture/v1', 'provenance': 'youtube-api', 'kind': 'youtube-transcript',
              'capturedAt': '2026-09-30T20:00:00.000Z', 'title': '', 'video': {'id': 'dQw4w9WgXcQ'},
              'transcript': {'language': 'en', 'generated': False, 'text': 'selftest',
                             'segments': [{'start': 0, 'text': 'selftest'}], 'sha256': transcripts.digest('selftest')}}
    bookmark = {'content': {'type': 'link', 'url': 'https://youtu.be/dQw4w9WgXcQ'},
                'assets': [{'id': 'test', 'assetType': 'userUploaded', 'fileName': transcripts.file_name(record)}]}
    assert status(bookmark) == 'ok'
    assert transcripts.read(bookmark, lambda _: transcripts.to_asset_html(record).encode()) == record['transcript']
    now = 10_000.0
    assert may_fetch({}, now) is None
    assert may_fetch({'blocked_until': now + 1}, now) == 'blocked'
    assert may_fetch({'fetches': [now - 10] * MAX_PER_HOUR}, now) == 'hourly cap'
    assert may_fetch({'fetches': [now - 4000] * MAX_PER_HOUR}, now) is None
    print('yt_transcript selftest: ok')


if __name__ == '__main__':
    cmd = sys.argv[1:]
    if cmd == ['--selftest']:
        selftest()
    elif cmd == ['prefetch']:
        prefetch()
    elif len(cmd) == 2 and cmd[0] == 'get':
        sys.exit(get(cmd[1]))
    else:
        sys.exit(__doc__)
