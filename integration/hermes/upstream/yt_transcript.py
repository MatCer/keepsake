#!/usr/bin/env python3
"""
yt_transcript - paced YouTube transcript cache for the brain_janitor jobs.

A burst of ~100 transcript requests got the home IP `IpBlocked` (2026-09-28), so
agents never fetch transcripts themselves. The no-agent cron job `yt-transcript-prefetch`
runs `prefetch` every 6 minutes and fetches at most ONE transcript per tick for YouTube
bookmarks in the hourly queue, capped at MAX_PER_HOUR. On a block it stops for BLOCK_HOURS.
Agents read the cache with `get`, which never touches the network.

  yt_transcript.py prefetch        # cron: fetch <=1 transcript; stdout (block notice) goes to Discord
  yt_transcript.py get <url|id>    # exit 0 = transcript on stdout, 2 = pending, 3 = unavailable
  yt_transcript.py --selftest
"""
import json
import re
import sys
import time
from pathlib import Path

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


def status(vid):
    """'ok' | 'unavailable' | 'pending'"""
    return load(CACHE / f'{vid}.json', {'status': 'pending'})['status']


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
    text = ' '.join(s.text for s in t.fetch())
    return {'status': 'ok', 'language': t.language_code, 'generated': t.is_generated, 'text': text}


def prefetch():
    from youtube_transcript_api._errors import CouldNotRetrieveTranscript, RequestBlocked, YouTubeRequestFailed
    from karakeep_gate import fetch_bookmarks, in_hourly
    CACHE.mkdir(parents=True, exist_ok=True)
    state, now = load(STATE, {}), time.time()
    if may_fetch(state, now):
        return
    todo = [v for b in fetch_bookmarks() if in_hourly(b)
            for v in [video_id((b.get('content') or {}).get('url') or '')] if v and status(v) == 'pending']
    if not todo:
        return
    vid = todo[0]
    # record the attempt before the request, so failures count against the cap too
    state['fetches'] = [t for t in state.get('fetches', []) if now - t < 3600] + [now]
    save(STATE, state)
    try:
        save(CACHE / f'{vid}.json', fetch(vid))
    except (RequestBlocked, YouTubeRequestFailed) as e:
        state['blocked_until'] = now + BLOCK_HOURS * 3600
        save(STATE, state)
        print(f'YouTube zablokoval transcript requesty ({type(e).__name__}) pri videu {vid}. '
              f'Prefetch prepisov je pozastavený na {BLOCK_HOURS} h, {len(todo)} videí čaká v rade.')
    except CouldNotRetrieveTranscript as e:  # disabled, no captions, private, age-restricted: permanent
        save(CACHE / f'{vid}.json', {'status': 'unavailable', 'reason': type(e).__name__})
    # other errors (network) propagate: the job run fails and the video is retried next tick


def get(arg):
    vid = video_id(arg)
    if not vid:
        print(f'not a YouTube URL or id: {arg}')
        return 3
    d = load(CACHE / f'{vid}.json', None)
    if d is None:
        print('PENDING: transcript not fetched yet; the paced prefetch job will get it. Leave this bookmark for a later run.')
        return 2
    if d['status'] != 'ok':
        print(f"UNAVAILABLE: {d['reason']} (no transcript can be fetched for this video)")
        return 3
    print(f"[transcript language={d['language']} auto_generated={d['generated']}]\n{d['text']}")
    return 0


def selftest():
    assert video_id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1') == 'dQw4w9WgXcQ'
    assert video_id('https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('https://youtu.be/dQw4w9WgXcQ?si=abc') == 'dQw4w9WgXcQ'
    assert video_id('https://youtube.com/shorts/dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('dQw4w9WgXcQ') == 'dQw4w9WgXcQ'
    assert video_id('https://example.com/watch?v=dQw4w9WgXcQ') is None
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
