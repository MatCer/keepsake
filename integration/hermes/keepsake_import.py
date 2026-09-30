#!/usr/bin/env python3
"""Import validated browser transcript attachments into the existing Hermes cache.

Ownership hashes live separately; API-fetched and hand-edited entries stay intact.
Run --selftest for offline unittest checks. No transcript content is logged.
"""
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

from yt_transcript import LANGS, load, save, video_id

PROFILE_HOME = Path(__file__).resolve().parent.parent
MAX_BYTES = 5 * 1024 * 1024
NAME = re.compile(r'^keepsake-transcript-([\w-]{11})-([A-Za-z0-9-]{1,35})-([0-9a-f]{12})\.html$')


class CaptureHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = False
        self.records = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('id') == 'keepsake-capture' and attrs.get('type') == 'application/json':
            self.active = True
            self.records.append('')

    def handle_data(self, data):
        if self.active:
            self.records[-1] += data

    def handle_endtag(self, tag):
        if tag == 'script':
            self.active = False


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def validate(raw, vid, short_hash):
    if len(raw) > MAX_BYTES:
        raise ValueError('asset size')
    parser = CaptureHTML()
    parser.feed(raw.decode('utf-8', errors='strict'))
    parser.close()
    if len(parser.records) != 1 or parser.active:
        raise ValueError('capture script')
    c = json.loads(parser.records[0])
    if (c['schema'] != 'keepsake.capture/v1' or c['kind'] != 'youtube-transcript'
            or c['provenance'] != 'browser-dom' or c['video']['id'] != vid):
        raise ValueError('capture identity')
    t = c['transcript']
    text, segments = t['text'], t['segments']
    if not isinstance(text, str) or not text.strip() or len(text) > 2_000_000:
        raise ValueError('text size')
    if not isinstance(segments, list) or not 0 < len(segments) <= 20_000:
        raise ValueError('segment count')
    for s in segments:
        if (type(s['start']) not in (int, float) or not math.isfinite(s['start']) or s['start'] < 0
                or not isinstance(s['text'], str) or not s['text'].strip()):
            raise ValueError('segment shape')
    if text != ' '.join(s['text'] for s in segments):
        raise ValueError('segment text')
    sha = digest(text)
    if sha != t['sha256'] or sha[:12] != short_hash:
        raise ValueError('text hash')
    if t.get('generated') is not None and type(t['generated']) is not bool:
        raise ValueError('generated type')
    if t.get('language') is not None and not isinstance(t['language'], str):
        raise ValueError('language type')
    return c


def karakeep_asset(asset_id):
    cfg = (PROFILE_HOME / 'config.yaml').read_text()
    addr = re.search(r'KARAKEEP_API_ADDR:\s*(\S+)', cfg).group(1).strip('\'"').rstrip('/')
    key = re.search(r'KARAKEEP_API_KEY:\s*(\S+)', cfg).group(1).strip('\'"')
    path = urllib.parse.quote(asset_id, safe='')
    request = urllib.request.Request(f'{addr}/api/v1/assets/{path}', headers={'Authorization': f'Bearer {key}'})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('asset size')
    return raw


def import_captures(bookmarks, fetch_asset, cache_dir: Path, prov_dir: Path, now: float) -> list[str]:
    imported = []
    for b in bookmarks:
        content = b.get('content') or {}
        if content.get('type') != 'link':
            continue
        vid = video_id(content.get('url') or '')
        if not vid:
            continue
        candidates = [(a, m) for a in b.get('assets', [])
                      if a.get('assetType') == 'userUploaded'
                      for m in [NAME.fullmatch(a.get('fileName') or '')] if m and m[1] == vid]
        if not candidates:
            continue
        # ponytail: ties use the last attachment; no extra metadata request.
        a, match = min(reversed(candidates), key=lambda pair:
                       LANGS.index(pair[1][2]) if pair[1][2] in LANGS else len(LANGS))
        path, prov_path = cache_dir / f'{vid}.json', prov_dir / f'{vid}.json'
        try:
            old = load(path, None)
            if old is not None and old.get('status') != 'unavailable':
                prov = load(prov_path, None)
                if prov is None or prov.get('fileName') == a['fileName']:
                    continue  # API-fetched/hand-made entry we never replace, or this exact attachment is imported
            c = validate(fetch_asset(a['id']), vid, match[3])
            t = c['transcript']
            if old is not None and old.get('status') != 'unavailable':
                prov = load(prov_path, {})
                if (old.get('status') != 'ok' or not isinstance(old.get('text'), str)
                        or prov.get('cacheTextSha256') != digest(old['text'])
                        or t['sha256'] == digest(old['text'])):
                    continue
            cache = {'status': 'ok', 'language': t.get('language') or 'und',
                     'generated': t.get('generated'), 'text': t['text']}
            provenance = {'provenance': 'browser-dom', 'capturedAt': c.get('capturedAt'),
                          'importedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(),
                          'bookmarkId': b['id'], 'assetId': a['id'], 'fileName': a['fileName'],
                          'sha256': t['sha256'], 'cacheTextSha256': t['sha256'],
                          **{k: t.get(k) for k in ('language', 'languageLabel', 'generated', 'segments', 'chapters')},
                          'title': c.get('title'), 'url': c.get('url')}
            cache_dir.mkdir(parents=True, exist_ok=True)
            prov_dir.mkdir(parents=True, exist_ok=True)
            save(path, cache)
            save(prov_path, provenance)
            imported.append(vid)
        except Exception as e:  # one bad attachment must not stop the queue; exception text may contain secrets
            print(f'keepsake_import: rejected {vid}: {type(e).__name__}', file=sys.stderr)
    return imported


def selftest():
    import unittest
    tests = Path(__file__).resolve().parent / 'tests'
    if tests.is_dir():
        result = unittest.TextTestRunner().run(unittest.defaultTestLoader.discover(str(tests)))
        if not result.wasSuccessful():
            raise SystemExit(1)
    else:
        # ponytail: deployment only needs the two scripts, so retain an offline smoke check.
        text, vid = 'selftest', 'AbCdEfGhIjK'
        c = {'schema': 'keepsake.capture/v1', 'kind': 'youtube-transcript', 'provenance': 'browser-dom',
             'video': {'id': vid}, 'transcript': {'text': text, 'sha256': digest(text),
                                               'segments': [{'start': 0, 'text': text}]}}
        raw = ('<script type="application/json" id="keepsake-capture">' + json.dumps(c) + '</script>').encode()
        assert validate(raw, vid, digest(text)[:12]) == c
    print('keepsake_import selftest: ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    else:
        sys.exit(__doc__)
