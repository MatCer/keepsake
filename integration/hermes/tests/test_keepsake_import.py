"""Browser asset validation and cache reader compatibility; no live services."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
api = types.ModuleType("youtube_transcript_api")
errors = types.ModuleType("youtube_transcript_api._errors")
for name in ("CouldNotRetrieveTranscript", "RequestBlocked", "YouTubeRequestFailed"):
    setattr(errors, name, type(name, (Exception,), {}))
sys.modules[api.__name__] = api
sys.modules[errors.__name__] = errors

import keepsake_import as imp
import yt_transcript as yt

VID = "AbCdEfGhIjK"
NOW = 1790798400.0


def capture(text="hello world", language="en"):
    return {"schema": "keepsake.capture/v1", "provenance": "browser-dom",
            "kind": "youtube-transcript", "capturedAt": "2026-09-30T20:00:00.000Z",
            "url": f"https://www.youtube.com/watch?v={VID}", "title": "Example",
            "video": {"id": VID}, "transcript": {
                "language": language, "languageLabel": "English", "generated": True,
                "segments": [{"start": 0, "text": text}], "chapters": [], "text": text,
                "sha256": hashlib.sha256(text.encode()).hexdigest()}}


def html(c):
    data = json.dumps(c, ensure_ascii=False)
    for char in "<>&\u2028\u2029":
        data = data.replace(char, "\\u%04x" % ord(char))
    return ("<!doctype html><script type=\"application/json\" id=\"keepsake-capture\">"
            + data + "</script>").encode()


def bookmark(c=None, asset_id="asset"):
    c = c or capture()
    t = c["transcript"]
    return {"id": "bookmark", "createdAt": "2020-01-01T00:00:00Z",
            "content": {"type": "link", "url": c["url"]}, "assets": [{
                "id": asset_id, "assetType": "userUploaded",
                "fileName": f"keepsake-transcript-{VID}-{t['language'] or 'und'}-{t['sha256'][:12]}.html"}]}


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / "yt_transcripts"
        self.prov = Path(self.tmp.name) / "yt_transcripts_provenance"
        self.path = self.cache / f"{VID}.json"
        self.provpath = self.prov / f"{VID}.json"
        self.addCleanup(patch.stopall)
        patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")).start()

    def run_import(self, c=None, b=None, raw=None):
        c = c or capture()
        return imp.import_captures([b or bookmark(c)], lambda _: html(c) if raw is None else raw,
                                   self.cache, self.prov, NOW)

    def test_valid_and_reader(self):
        c = capture()
        self.assertEqual(self.run_import(c), [VID])
        self.assertEqual(json.loads(self.path.read_text()), {
            "status": "ok", "language": "en", "generated": True, "text": "hello world"})
        t = c["transcript"]
        self.assertEqual(json.loads(self.provpath.read_text()), {
            "provenance": "browser-dom", "capturedAt": c["capturedAt"],
            "importedAt": "2026-09-30T20:00:00+00:00", "bookmarkId": "bookmark",
            "assetId": "asset", "fileName": bookmark(c)["assets"][0]["fileName"],
            "sha256": t["sha256"], "cacheTextSha256": t["sha256"],
            **{k: t[k] for k in ("language", "languageLabel", "generated", "segments", "chapters")},
            "title": c["title"], "url": c["url"]})
        out = io.StringIO()
        with patch.object(yt, "CACHE", self.cache), contextlib.redirect_stdout(out):
            self.assertEqual(yt.get(VID), 0)
        self.assertIn(c["transcript"]["text"], out.getvalue())

    def test_invalid(self):
        variants = []
        for section, key, value in (("video", "id", "XXXXXXXXXXX"),
                                    ("transcript", "text", "tampered"),
                                    ("transcript", "sha256", "0" * 64),
                                    ("transcript", "generated", "true"),
                                    ("transcript", "language", 42),
                                    ("transcript", "segments", [{"start": float("nan"), "text": "hello world"}]),
                                    ("transcript", "segments", [{"start": 0, "text": ""}]),
                                    ("transcript", "segments", [{"start": -1, "text": "hello world"}]),
                                    ("transcript", "segments", [{"start": True, "text": "hello world"}])):
            c = capture()
            c[section][key] = value
            variants.append(html(c))
        for key in ("schema", "kind", "provenance"):
            c = capture()
            c[key] = "invalid"
            variants.append(html(c))
        variants += [b"x" * (5 * 1024 * 1024 + 1), b"\xff", b"<html></html>", html(capture("")),
                     html(capture("x" * 2_000_001)), b"<script id=\"keepsake-capture\" type=\"application/json\">[]</script>"]
        c = capture()
        c["transcript"]["segments"] *= 20_001
        variants.append(html(c))
        for raw in variants:
            with self.subTest(size=len(raw)):
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertEqual(self.run_import(raw=raw), [])
                self.assertFalse(self.path.exists())
                self.assertEqual(len(err.getvalue().splitlines()), 1)
                self.assertTrue(err.getvalue().startswith(f"keepsake_import: rejected {VID}: "))
                self.assertNotIn("hello world", err.getvalue())

    def test_filename_hash(self):
        b = bookmark()
        b["assets"][0]["fileName"] = f"keepsake-transcript-{VID}-en-000000000000.html"
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_import(b=b), [])

    def test_idempotent(self):
        self.run_import()
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in (self.path, self.provpath)]
        self.assertEqual(self.run_import(), [])
        self.assertEqual(before, [(p.read_bytes(), p.stat().st_mtime_ns) for p in (self.path, self.provpath)])

    def test_no_download_when_nothing_could_change(self):
        # runs every 6 minutes: an imported attachment or an API-fetched entry must not be re-downloaded
        c = capture()
        self.run_import(c)
        calls = []
        count = lambda asset_id: calls.append(asset_id) or html(c)
        imp.import_captures([bookmark(c)], count, self.cache, self.prov, NOW)
        self.provpath.unlink()
        imp.import_captures([bookmark(c)], count, self.cache, self.prov, NOW)
        self.assertEqual(calls, [])

    def test_ownership(self):
        for mode in ("api", "edited", "own", "unavailable"):
            with self.subTest(mode=mode):
                self.run_import()
                if mode == "api":
                    self.provpath.unlink(missing_ok=True)
                if mode in ("edited", "unavailable"):
                    data = json.loads(self.path.read_text())
                    data["text"] = "hand edited"
                    if mode == "unavailable":
                        data = {"status": "unavailable", "reason": "disabled"}
                    self.path.write_text(json.dumps(data))
                before = self.path.read_bytes()
                result = self.run_import(capture("new capture"))
                self.assertEqual(result, [VID] if mode in ("own", "unavailable") else [])
                if not result:
                    self.assertEqual(self.path.read_bytes(), before)
                self.path.unlink()
                self.provpath.unlink(missing_ok=True)

    def test_languages(self):
        for langs, winner in ((["cs", "sk", "en", "fr"], "en"), (["cs", "sk"], "sk"),
                              (["fr", "de"], "de")):
            with self.subTest(langs=langs):
                captures = {lang: capture(lang, lang) for lang in langs}
                b = bookmark()
                b["assets"] = [bookmark(captures[lang], lang)["assets"][0] for lang in langs]
                imp.import_captures([b], lambda key: html(captures[key]), self.cache, self.prov, NOW)
                self.assertEqual(json.loads(self.path.read_text())["language"], winner)
                self.path.unlink()

    def test_escaped_roundtrip_and_unknown_language(self):
        c = capture("</script><>&\u2028\u2029", None)
        c["transcript"]["generated"] = None
        self.run_import(c)
        data = json.loads(self.path.read_text())
        self.assertEqual(data["text"], c["transcript"]["text"])
        self.assertEqual(data["language"], "und")
        self.assertIsNone(data["generated"])

    def test_non_candidates_never_downloaded(self):
        for change in ("type", "assetType", "fileName", "video"):
            b = bookmark()
            if change == "type":
                b["content"]["type"] = "text"
            elif change == "video":
                b["content"]["url"] = "https://youtu.be/XXXXXXXXXXX"
            else:
                b["assets"][0][change] = "invalid"
            def fail(_):
                self.fail("unexpected asset download")
            self.assertEqual(imp.import_captures([b], fail, self.cache, self.prov, NOW), [])

    def test_download_failure_is_redacted(self):
        def fail(_):
            raise RuntimeError("secret transcript https://example.com/?token=secret")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(imp.import_captures([bookmark()], fail, self.cache, self.prov, NOW), [])
        self.assertNotIn("secret", err.getvalue())

    def test_asset_http(self):
        root = Path(self.tmp.name)
        (root / "config.yaml").write_text('KARAKEEP_API_ADDR: "https://example.test/"\nKARAKEEP_API_KEY: "test-key"\n')
        with patch.object(imp, "PROFILE_HOME", root), patch("urllib.request.urlopen") as open_url:
            open_url.return_value.__enter__.return_value.read.return_value = b"asset"
            self.assertEqual(imp.karakeep_asset("an/id"), b"asset")
            request = open_url.call_args.args[0]
            self.assertEqual(request.full_url, "https://example.test/api/v1/assets/an%2Fid")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
            self.assertEqual(open_url.call_args.kwargs, {"timeout": 30})
            open_url.return_value.__enter__.return_value.read.assert_called_once_with(5 * 1024 * 1024 + 1)


if __name__ == "__main__":
    unittest.main()
