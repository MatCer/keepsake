"""Run the patched brain_janitor prefetch against the local Karakeep in a throwaway profile.

youtube_transcript_api is replaced by a stub that records every video it is asked for and
never touches the network, so the test can assert which videos the prefetch would fetch.
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
class YouTubeTranscriptApi:
    def list(self, vid):
        with open(os.environ['YT_CALLS'], 'a') as f:
            f.write(vid + '\\n')
        from youtube_transcript_api._errors import CouldNotRetrieveTranscript
        raise CouldNotRetrieveTranscript(vid)
class NoTranscriptFound(Exception): pass
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
        for f in ('yt_transcript.py', 'keepsake_import.py'):
            shutil.copy(HERMES / f, scripts / f)
        shutil.copy(HERMES / 'upstream/karakeep_gate.py', scripts / 'karakeep_gate.py')
        stubs = root / 'stubs/youtube_transcript_api'
        stubs.mkdir(parents=True)
        (stubs / '__init__.py').write_text(STUB)
        (stubs / '_errors.py').write_text(ERRORS)
        calls = root / 'calls.txt'
        env = {**os.environ, 'PYTHONPATH': str(root / 'stubs'), 'YT_CALLS': str(calls)}

        def run(*args):
            return subprocess.run([sys.executable, *args], cwd=scripts, env=env, capture_output=True, text=True)

        first = run('yt_transcript.py', 'prefetch')
        cache = root / f'profile/cache/yt_transcripts/{vid}.json'
        mtime = cache.stat().st_mtime_ns if cache.exists() else None
        second = run('yt_transcript.py', 'prefetch')
        got = run('yt_transcript.py', 'get', vid)
        print(json.dumps({
            'prefetch_rc': [first.returncode, second.returncode],
            'prefetch_stderr': (first.stderr + second.stderr)[-2000:],
            'cache': json.loads(cache.read_text()) if cache.exists() else None,
            'provenance': (root / f'profile/cache/yt_transcripts_provenance/{vid}.json').exists(),
            'unchanged_on_second_run': mtime is not None and cache.stat().st_mtime_ns == mtime,
            'youtube_calls': calls.read_text().split() if calls.exists() else [],
            'get_rc': got.returncode,
            'get_stdout': got.stdout,
        }))
    finally:
        shutil.rmtree(root)


if __name__ == '__main__':
    main(*sys.argv[1:4])
