"""Run the patched brain_janitor prefetch and get against the local Karakeep in a throwaway profile.

youtube_transcript_api is replaced by a stub that records every video it is asked for, returns a
fixed transcript and never touches the network. Transcripts live only in Karakeep.
Usage: hermes_e2e.py <karakeep_addr> <api_key> <captured_video_id>; prints a JSON report.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HERMES = REPO / 'integration/hermes'

STUB = '''
import os
from types import SimpleNamespace as NS
class NoTranscriptFound(Exception): pass
class _Track:
    language_code, is_generated = 'en', True
    def fetch(self):
        return [NS(start=0.0, text='Fetched by the fallback.'), NS(start=2.5, text='Second line.')]
class _List:
    def find_transcript(self, langs): return _Track()
    def __iter__(self): return iter([_Track()])
class YouTubeTranscriptApi:
    def list(self, vid):
        with open(os.environ['YT_CALLS'], 'a') as f:
            f.write(vid + '\\n')
        return _List()
'''
ERRORS = '''
class CouldNotRetrieveTranscript(Exception): pass
class RequestBlocked(CouldNotRetrieveTranscript): pass
class YouTubeRequestFailed(CouldNotRetrieveTranscript): pass
'''


def main(addr, key, vid):
    root = Path(tempfile.mkdtemp(prefix='keepsake-hermes-'))
    try:
        scripts = root / 'profile/scripts'
        scripts.mkdir(parents=True)
        (root / 'profile/config.yaml').write_text(f'KARAKEEP_API_ADDR: {addr}\nKARAKEEP_API_KEY: {key}\n')
        for f in ('yt_transcript.py', 'karakeep_transcripts.py', 'karakeep_gate.py'):
            shutil.copy(HERMES / f, scripts / f)
        stubs = root / 'stubs/youtube_transcript_api'
        stubs.mkdir(parents=True)
        (stubs / '__init__.py').write_text(STUB)
        (stubs / '_errors.py').write_text(ERRORS)
        calls = root / 'calls.txt'
        env = {**os.environ, 'PYTHONPATH': str(root / 'stubs'), 'YT_CALLS': str(calls)}

        def run(*args):
            return subprocess.run([sys.executable, *args], cwd=scripts, env=env, capture_output=True, text=True)

        first = run('yt_transcript.py', 'prefetch')
        second = run('yt_transcript.py', 'prefetch')
        got = run('yt_transcript.py', 'get', vid)
        cache = root / 'profile/cache'
        print(json.dumps({
            'prefetch_rc': [first.returncode, second.returncode],
            'prefetch_stderr': (first.stderr + second.stderr)[-2000:],
            'local_files': sorted(str(p.relative_to(cache)) for p in cache.rglob('*') if p.is_file()) if cache.exists() else [],
            'youtube_calls': calls.read_text().split() if calls.exists() else [],
            'get_rc': got.returncode,
            'get_stdout': got.stdout,
        }))
    finally:
        shutil.rmtree(root)


if __name__ == '__main__':
    main(*sys.argv[1:4])
