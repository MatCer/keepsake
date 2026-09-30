#!/usr/bin/env python3
"""Karakeep transcript attachments: selection, validation and authenticated HTTP."""
import hashlib
from html import escape
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.error
import urllib.request
import uuid

PROFILE_HOME = Path(__file__).resolve().parent.parent
MAX_BYTES = 16 * 1024 * 1024
LANGS = ['en', 'sk', 'cs']
UNAVAILABLE_TAG = 'transcript-unavailable'
NAME = re.compile(r'^keepsake-transcript-([A-Za-z0-9_-]{11})-([A-Za-z0-9-]+)-([0-9a-f]{12})\.html$')


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
            or c['provenance'] not in {'browser-dom', 'youtube-api'} or c['video']['id'] != vid):
        raise ValueError('capture identity')
    t = c['transcript']
    text, segments = t['text'], t['segments']
    if not isinstance(text, str) or not text.strip() or len(text) > 1_000_000:
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):  # urllib would forward the Bearer header to the new location
        raise urllib.error.HTTPError(args[0].full_url, args[2], 'redirect refused', args[4], None)


_OPENER = urllib.request.build_opener(_NoRedirect)


def request(method, path, body=None, content_type=None):
    cfg = (PROFILE_HOME / 'config.yaml').read_text()
    addr = re.search(r'KARAKEEP_API_ADDR:\s*(\S+)', cfg).group(1).strip('\'"').rstrip('/')
    key = re.search(r'KARAKEEP_API_KEY:\s*(\S+)', cfg).group(1).strip('\'"')
    headers = {'Authorization': f'Bearer {key}'}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(f'{addr}/api/v1{path}', body, headers, method=method)
    with _OPENER.open(req, timeout=30) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('response size')
    return raw


def api_json(method, path, body=None):
    raw = request(method, path, json.dumps(body).encode() if body is not None else None,
                  'application/json' if body is not None else None)
    return json.loads(raw) if raw else None


def asset_bytes(asset_id):
    return request('GET', '/assets/' + urllib.parse.quote(asset_id, safe=''))


def upload_asset(file_name, html):
    # Keep the multipart header a single quoted filename, never caller-supplied headers.
    if any(c in file_name for c in '\r\n"\\'):
        raise ValueError('file name')
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
            f'Content-Type: text/html\r\n\r\n{html}\r\n--{boundary}--\r\n').encode()
    return json.loads(request('POST', '/assets', body,
                             f'multipart/form-data; boundary={boundary}'))['assetId']


def attach(bookmark_id, asset_id):
    return api_json('POST', '/bookmarks/' + urllib.parse.quote(bookmark_id, safe='') + '/assets',
                    {'id': asset_id, 'assetType': 'userUploaded'})


def add_tag(bookmark_id, name):
    return api_json('POST', '/bookmarks/' + urllib.parse.quote(bookmark_id, safe='') + '/tags',
                    {'tags': [{'tagName': name}]})


def find_bookmark(url_or_id):
    from yt_transcript import video_id
    vid = video_id(url_or_id)
    if not vid:
        return None
    canonical = f'https://www.youtube.com/watch?v={vid}'
    urls = [url_or_id, canonical] if url_or_id != vid else [canonical]
    for url in dict.fromkeys(urls):
        result = api_json('GET', '/bookmarks/check-url?url=' + urllib.parse.quote(url, safe=''))
        if result.get('bookmarkId'):
            return api_json('GET', '/bookmarks/' + urllib.parse.quote(result['bookmarkId'], safe=''))
    return None


def attachment(bookmark):
    from yt_transcript import video_id
    if not isinstance(bookmark, dict):
        return None
    content = bookmark.get('content')
    if not isinstance(content, dict) or content.get('type') != 'link':
        return None
    url = content.get('url')
    vid = video_id(url) if isinstance(url, str) else None
    assets = bookmark.get('assets')
    if not vid or not isinstance(assets, list):
        return None
    candidates = []
    for a in assets:
        if not isinstance(a, dict) or a.get('assetType') != 'userUploaded' or not isinstance(a.get('id'), str) or not a['id']:
            continue
        name = a.get('fileName')
        m = NAME.fullmatch(name) if isinstance(name, str) else None
        if m and m[1] == vid:
            candidates.append((a, m[2]))
    if not candidates:
        return None
    return min(reversed(candidates), key=lambda pair:
               LANGS.index(pair[1]) if pair[1] in LANGS else len(LANGS))[0]


def status(bookmark):
    if attachment(bookmark):
        return 'ok'
    tags = bookmark.get('tags') if isinstance(bookmark, dict) else None
    if isinstance(tags, list) and any(isinstance(t, dict) and t.get('name') == UNAVAILABLE_TAG for t in tags):
        return 'unavailable'
    return 'pending'


def read(bookmark, fetch=asset_bytes):
    a = attachment(bookmark)
    if not a:
        return None
    m = NAME.fullmatch(a['fileName'])
    try:
        return validate(fetch(a['id']), m[1], m[3])['transcript']
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        return None


def file_name(record):
    t = record['transcript']
    language = re.sub(r'[^A-Za-z0-9-]', '', t.get('language') or '') or 'und'
    return f"keepsake-transcript-{record['video']['id']}-{language}-{t['sha256'][:12]}.html"


def html(value):
    return escape(value, quote=True).replace('&#x27;', '&#39;')


def timestamp(start):
    total = math.floor(start)
    hours, minutes, seconds = total // 3600, total // 60 % 60, total % 60
    return f'{hours}:{minutes:02}:{seconds:02}' if hours else f'{minutes}:{seconds:02}'


def to_asset_html(record):
    t = record['transcript']
    source = html(f"https://www.youtube.com/watch?v={record['video']['id']}")
    data = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
    for char in '<>&\u2028\u2029':
        data = data.replace(char, '\\u%04x' % ord(char))
    lines, index = [], 0
    chapters = sorted(t.get('chapters') or [], key=lambda c: c['start'])
    for segment in t['segments']:
        start = segment['start']
        while index < len(chapters) and chapters[index]['start'] <= start:
            lines.append(f"<h2>{html(chapters[index]['title'])}</h2>")
            index += 1
        seconds = str(int(start)) if start == int(start) else str(start)
        lines.append(f'<p><a href="{source}&amp;t={seconds}s">{timestamp(start)}</a> {html(segment["text"])}</p>')
    title = html(record['title'])
    origin = ('the open YouTube page (browser-dom)' if record['provenance'] == 'browser-dom'
              else 'YouTube captions (youtube-api)')
    language = t.get('language')
    return (f'<!doctype html><html lang="{html(language if language is not None else "und")}">'
            '<head><meta charset="utf-8"><meta name="keepsake-schema" content="keepsake.capture/v1">'
            f'<title>Transcript: {title}</title></head><body><h1>{title}</h1>'
            f'<p>Source: <a href="{source}">{source}</a> · captured {html(record["capturedAt"])} from {origin}</p>'
            + ''.join(lines) + f'<script type="application/json" id="keepsake-capture">{data}</script></body></html>')


def upload(bookmark, record):
    asset_id = upload_asset(file_name(record), to_asset_html(record))
    attach(bookmark['id'], asset_id)
