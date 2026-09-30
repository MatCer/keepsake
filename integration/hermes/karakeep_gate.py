#!/usr/bin/env python3
"""
karakeep_gate - pre-run wake gate for the brain_janitor Karakeep cron jobs.

Hermes runs this before the agent. If the last stdout line is
{"wakeAgent": false} the LLM run is skipped entirely (the queues are empty on
~95% of ticks). Otherwise the queue summary is injected into the agent prompt.
Any error exits non-zero, and Hermes then wakes the agent as before (fail open).

Queues mirror the job prompts:
  fast   = no janitor-processed and no janitor-skip
  hourly = janitor-processed, no obsidian-processed/obsidian-skip/janitor-skip,
           plus unprocessed Clippings notes and vault notes missing description:
Entry points: karakeep_gate_fast.py, karakeep_gate_hourly.py. `--selftest` checks the queue rules.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

PROFILE_HOME = Path(__file__).resolve().parent.parent
VAULT = Path('/workspace/vaults/ObsidianBrain')
VAULT_FIND = PROFILE_HOME / 'skills/note-taking/brain-vault/scripts/vault_find.py'


def tags(b):
    return {t['name'] for t in b.get('tags', [])}


def in_fast(b):
    return not tags(b) & {'janitor-processed', 'janitor-skip'}


def in_hourly(b):
    t = tags(b)
    return 'janitor-processed' in t and not t & {'obsidian-processed', 'obsidian-skip', 'janitor-skip'}


def karakeep(path):
    cfg = (PROFILE_HOME / 'config.yaml').read_text()
    addr = re.search(r'KARAKEEP_API_ADDR:\s*(\S+)', cfg).group(1).strip('\'"').rstrip('/')
    key = re.search(r'KARAKEEP_API_KEY:\s*(\S+)', cfg).group(1).strip('\'"')
    return json.load(urllib.request.urlopen(urllib.request.Request(f'{addr}/api/v1{path}', headers={'Authorization': f'Bearer {key}'}), timeout=30))


def fetch_bookmarks():
    out, cur = [], None
    for _ in range(100):  # ponytail: full scan (~3 pages today); use Karakeep search API past a few thousand bookmarks
        r = karakeep('/bookmarks?limit=100' + (f'&cursor={cur}' if cur else ''))
        out += r['bookmarks']
        cur = r.get('nextCursor')
        if not cur:
            return out
    raise RuntimeError('bookmark pagination did not end')


def jev_key():
    for f in (Path('/opt/data/.config/jevgraph/credentials.env'), Path.home() / '.config/jevgraph/credentials.env'):
        if f.exists():
            for line in f.read_text().splitlines():
                if line.startswith('OPENJEV_API_KEY='):
                    return line.split('=', 1)[1].strip().strip('\'"')
    return None


def suggest_tags(queue):
    """Jev suggestions from the EXISTING list/tag vocabulary, to stop topic-tag sprawl.
    Sends only public bookmark data (title, URL, description, page text), never the note."""
    key = jev_key()
    if not key:
        return {}
    topics = sorted(t['name'] for t in karakeep('/tags')['tags']
                    if t['name'].startswith('topic-') and (t.get('numBookmarks') or 0) >= 2)[:250]
    questions = {
        'area': {'type': 'choice', 'instructions': 'Which research area does this bookmark belong to?', 'criteria': {
            'Tech': 'software, AI, agents, developer tools, infrastructure, engineering',
            'Business': 'business models, marketing, sales, startups, making money, distribution',
            'Ideas': 'a concrete product or business idea to build', 'none': 'not research material (entertainment, personal)'}},
        'libtype': {'type': 'choice', 'instructions': 'What kind of resource is this bookmark?', 'criteria': {
            'Videos': 'a video', 'Repos': 'a source code repository', 'Tools': 'a product, service, app or website you can use',
            'Articles': 'a blog post, documentation page, paper or news article', 'none': 'none of these'}},
        'topic': {'type': 'choice', 'instructions': 'Which existing topic tag fits this bookmark best?',
                  'criteria': {**{t: None for t in topics}, 'none': 'no listed topic fits'}},
    }
    out = {}
    for b in queue[:10]:
        try:
            c = karakeep(f"/bookmarks/{b['id']}?includeContent=true").get('content') or {}
            text = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', c.get('htmlContent') or ''))[:3000]
            state = {'title': b.get('title') or c.get('title') or '', 'url': c.get('url', ''),
                     'description': (c.get('description') or '')[:600], 'page_text_start': text}
            body = json.dumps({'model': 'openjev', 'state': state, 'questions': questions}).encode()
            a = json.load(urllib.request.urlopen(urllib.request.Request(
                'https://api.openjev.sh/v1/systemone', body,
                {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}), timeout=30))['answers']
        except Exception as e:  # suggestions are optional; the agent still triages without them
            out[b['id']] = f'(no suggestion: {type(e).__name__})'
            continue
        top = [(k, p) for k, p in sorted(a['topic']['probabilities'].items(), key=lambda kv: -kv[1]) if k != 'none' and p >= 0.1][:3]
        lists = [f"Research > {a['area']['choice']}" if a['area']['choice'] != 'none' else None,
                 f"Library > {a['libtype']['choice']}" if a['libtype']['choice'] != 'none' else None]
        out[b['id']] = ('lists: ' + ', '.join(x for x in lists if x) + '; topics: '
                        + (', '.join(f'{k} ({p:.2f})' for k, p in top) or 'none of the existing fit'))
    return out


def clippings_pending():
    root = VAULT / 'Clippings'
    return sorted(str(p.relative_to(VAULT)) for p in root.rglob('*.md')
                  if not any(part.lower().startswith('processed') for part in p.relative_to(root).parts[:-1]))


def missing_descriptions():
    r = subprocess.run([sys.executable, str(VAULT_FIND), '--missing', '--vault', str(VAULT)],
                       capture_output=True, text=True, timeout=60, check=True)
    return [l for l in r.stdout.splitlines() if l.strip()]


def main(mode):
    subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(VAULT), 'pull', '--ff-only', '-q'],
                   capture_output=True, timeout=60)  # best effort; a stale tree only delays work by one tick
    queue = [b for b in fetch_bookmarks() if (in_fast if mode == 'fast' else in_hourly)(b)]
    extra, transcripts = {}, {}
    if mode == 'hourly':
        from yt_transcript import status, video_id
        transcripts = {b['id']: status(b) for b in queue if video_id((b.get('content') or {}).get('url') or '')}
        # videos still waiting for the paced prefetch job are not work yet
        queue = [b for b in queue if transcripts.get(b['id']) != 'pending']
        extra = {'clippings_pending': clippings_pending(), 'notes_missing_description': missing_descriptions()}
    if not queue and not any(extra.values()):
        print(json.dumps({'wakeAgent': False}))
        return
    sugg = suggest_tags(queue) if mode == 'fast' else {}
    print(f'Pre-run gate ({mode}): work found. Bookmarks in this job\'s queue (id, title, tags):')
    for b in queue[:30]:
        print(f"- {b['id']} | {(b.get('title') or '')[:100]} | {', '.join(sorted(tags(b)))}")
        if b['id'] in sugg:
            print(f"  Jev suggestion: {sugg[b['id']]}")
        if b['id'] in transcripts:
            print(f"  YouTube transcript: {transcripts[b['id']]} (read with scripts/yt_transcript.py get <url>)")
    if sugg:
        print('Tag rule: use the suggested lists and existing topic-* tags; create a new topic-* tag only if none of the existing ones fits.')
    for k, v in extra.items():
        if v:
            print(f'{k}: ' + '; '.join(v[:30]))
    print(json.dumps({'wakeAgent': True}))


def selftest():
    b = lambda *t: {'tags': [{'name': x} for x in t]}
    assert in_fast(b()) and in_fast(b('kind-video', 'manual-review'))
    assert not in_fast(b('janitor-processed')) and not in_fast(b('janitor-skip'))
    assert in_hourly(b('janitor-processed', 'manual-review'))
    assert not in_hourly(b()) and not in_hourly(b('janitor-processed', 'obsidian-skip'))
    assert not in_hourly(b('janitor-processed', 'obsidian-processed')) and not in_hourly(b('janitor-processed', 'janitor-skip'))
    print('karakeep_gate selftest: ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else 'fast')
