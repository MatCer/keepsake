"""Prefetch integration with stubbed Karakeep and YouTube boundaries."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_keepsake_import import VID, NOW, bookmark, capture, html, errors
import keepsake_import as imp
import yt_transcript as yt


class PrefetchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / "yt_transcripts"
        self.cache.mkdir()
        self.gate = types.ModuleType("karakeep_gate")
        self.b = bookmark()
        self.b["assets"] = []
        self.gate.fetch_bookmarks = Mock(return_value=[self.b])
        self.gate.in_hourly = Mock(return_value=True)
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {"karakeep_gate": self.gate}).start()
        patch.object(yt, "CACHE", self.cache).start()
        patch.object(yt, "STATE", self.cache / "_state.json").start()
        patch.object(yt.time, "time", return_value=NOW).start()
        self.fetch = patch.object(yt, "fetch", return_value={
            "status": "ok", "language": "en", "generated": True, "text": "api"}).start()
        patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")).start()
        patch.object(imp, "karakeep_asset", return_value=html(capture())).start()

    def test_browser_import(self):
        self.gate.fetch_bookmarks.return_value = [bookmark()]
        yt.prefetch()
        self.fetch.assert_not_called()
        self.gate.fetch_bookmarks.assert_called_once_with()
        self.assertEqual(yt.status(VID), "ok")
        self.assertTrue((self.cache.parent / "yt_transcripts_provenance" / f"{VID}.json").exists())

    def test_grace(self):
        self.b["createdAt"] = "2026-09-30T19:45:00Z"
        yt.prefetch()
        self.fetch.assert_not_called()

    def test_old_fetches_one(self):
        other = bookmark()
        other["content"]["url"] = "https://youtu.be/XXXXXXXXXXX"
        other["assets"] = []
        self.gate.fetch_bookmarks.return_value.append(other)
        yt.prefetch()
        self.fetch.assert_called_once_with(VID)
        self.assertEqual(yt.load(yt.STATE, {})["fetches"], [NOW])

    def test_disabled_still_imports(self):
        yt.save(self.cache / "_config.json", {"api_fallback": False})
        yt.prefetch()
        self.fetch.assert_not_called()
        self.gate.fetch_bookmarks.return_value = [bookmark()]
        yt.prefetch()
        self.assertEqual(yt.status(VID), "ok")

    def test_import_exception_continues(self):
        err = io.StringIO()
        with patch.object(imp, "import_captures", side_effect=RuntimeError("secret")), contextlib.redirect_stderr(err):
            yt.prefetch()
        self.fetch.assert_called_once_with(VID)
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        self.assertNotIn("secret", err.getvalue())

    def test_pacing_and_import_during_block(self):
        for state in ({"blocked_until": NOW + 100}, {"fetches": [NOW - 1] * yt.MAX_PER_HOUR}):
            yt.save(yt.STATE, state)
            yt.prefetch()
            self.fetch.assert_not_called()
        self.gate.fetch_bookmarks.return_value = [bookmark()]
        yt.prefetch()
        self.assertEqual(yt.status(VID), "ok")

    def test_request_block_and_unavailable(self):
        self.fetch.side_effect = errors.RequestBlocked()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            yt.prefetch()
        self.assertIn("YouTube zablokoval", out.getvalue())
        self.assertEqual(yt.load(yt.STATE, {})["blocked_until"], NOW + yt.BLOCK_HOURS * 3600)
        yt.save(yt.STATE, {})
        self.fetch.side_effect = errors.CouldNotRetrieveTranscript()
        yt.prefetch()
        self.assertEqual(yt.status(VID), "unavailable")

    def test_not_hourly(self):
        self.gate.in_hourly.return_value = False
        yt.prefetch()
        self.fetch.assert_not_called()

    def test_config(self):
        defaults = {"api_fallback": True, "grace_minutes": 30}
        self.assertEqual(yt.config(), defaults)
        for value in ({"api_fallback": "false", "grace_minutes": True}, [],
                      {"grace_minutes": -1}, {"grace_minutes": float("inf")},
                      {"grace_minutes": 10 ** 400}):
            yt.save(self.cache / "_config.json", value)
            self.assertEqual(yt.config(), defaults)
        (self.cache / "_config.json").write_text("{")
        self.assertEqual(yt.config(), defaults)
        yt.save(self.cache / "_config.json", {"api_fallback": False, "grace_minutes": 0, "other": 1})
        self.assertEqual(yt.config(), {"api_fallback": False, "grace_minutes": 0})

    def test_grace_boundaries(self):
        for date, expected in (("2026-09-30T19:30:01Z", True), ("2026-09-30T19:30:00Z", False),
                               ("2026-09-30T21:45:00+02:00", True), ("bad", False), (None, False)):
            self.assertEqual(yt.in_grace({"createdAt": date}, NOW, 30), expected)


if __name__ == "__main__":
    unittest.main()
