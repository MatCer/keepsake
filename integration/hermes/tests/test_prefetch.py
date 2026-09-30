"""Prefetch, CLI and hourly gate with offline boundaries."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, Mock, patch

from test_karakeep_transcripts import VID, NOW, bookmark, capture, api, errors, setUpModule, tearDownModule
import karakeep_transcripts as kt
import yt_transcript as yt
import karakeep_gate as gate


class PrefetchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / "yt_transcripts"
        self.cache.mkdir()
        self.b = bookmark()
        self.b["assets"] = []
        self.b["tags"] = [{"name": "janitor-processed"}]
        self.addCleanup(patch.stopall)
        self.bookmarks = patch.object(gate, "fetch_bookmarks", return_value=[self.b]).start()
        patch.object(yt, "CACHE", self.cache).start()
        patch.object(yt, "STATE", self.cache / "_state.json").start()
        patch.object(yt.time, "time", return_value=NOW).start()
        self.upload = patch.object(kt, "upload").start()
        self.tag = patch.object(kt, "add_tag").start()
        api.YouTubeTranscriptApi.reset_mock()
        api.YouTubeTranscriptApi.side_effect = None
        self.track = Mock(language_code="en", is_generated=True)
        self.track.fetch.return_value = [types.SimpleNamespace(start=1.23456, text="hello"),
                                        types.SimpleNamespace(start=2, text=""),
                                        types.SimpleNamespace(start=3, text="  "),
                                        types.SimpleNamespace(start=4, text="world")]
        api.YouTubeTranscriptApi.return_value.list.return_value = MagicMock()
        self.tracks = api.YouTubeTranscriptApi.return_value.list.return_value
        self.tracks.find_transcript.side_effect = None
        self.tracks.find_transcript.return_value = self.track

    def test_browser_attachment_never_fetched(self):
        self.b["assets"] = bookmark()["assets"]
        yt.prefetch()
        api.YouTubeTranscriptApi.assert_not_called()
        self.upload.assert_not_called()
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_grace(self):
        self.b["createdAt"] = "2026-09-30T19:45:00Z"
        yt.prefetch()
        api.YouTubeTranscriptApi.assert_not_called()

    def test_old_fetches_one(self):
        self.bookmarks.return_value.append(dict(self.b, id="other"))
        yt.prefetch()
        api.YouTubeTranscriptApi.return_value.list.assert_called_once_with(VID)
        self.tracks.find_transcript.assert_called_once_with(["en", "sk", "cs"])
        self.upload.assert_called_once()
        b, c = self.upload.call_args.args
        self.assertIs(b, self.b)
        self.assertEqual(c["provenance"], "youtube-api")
        self.assertEqual(c["title"], "")
        self.assertEqual(c["capturedAt"], "2026-09-30T20:00:00.000Z")
        self.assertEqual(c["video"], {"id": VID, "channel": None, "publishedAt": None,
                                     "durationSeconds": None, "description": None})
        self.assertEqual(c["transcript"]["segments"], [{"start": 1.235, "text": "hello"},
                                                       {"start": 4, "text": "world"}])
        self.assertEqual(kt.file_name(c), bookmark()["assets"][0]["fileName"])
        self.assertEqual(yt.load(yt.STATE, {})["fetches"], [NOW])
        self.assertEqual([p.name for p in self.cache.iterdir()], ["_state.json"])

    def test_track_fallback(self):
        self.tracks.find_transcript.side_effect = api.NoTranscriptFound()
        self.tracks.__iter__.return_value = iter([self.track])
        self.assertEqual(yt.fetch(VID)["text"], "hello world")

    def test_disabled(self):
        yt.save(self.cache / "_config.json", {"api_fallback": False})
        yt.prefetch()
        api.YouTubeTranscriptApi.assert_not_called()
        self.upload.assert_not_called()

    def test_pacing(self):
        for state in ({"blocked_until": NOW + 100}, {"fetches": [NOW - 1] * yt.MAX_PER_HOUR}):
            yt.save(yt.STATE, state)
            yt.prefetch()
            api.YouTubeTranscriptApi.assert_not_called()

    def test_no_captions(self):
        self.track.fetch.side_effect = errors.CouldNotRetrieveTranscript()
        yt.prefetch()
        self.tag.assert_called_once_with(self.b["id"], kt.UNAVAILABLE_TAG)
        self.upload.assert_not_called()

    def test_blocked(self):
        for error in (errors.RequestBlocked, errors.YouTubeRequestFailed):
            yt.save(yt.STATE, {})
            self.track.fetch.side_effect = error()
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                yt.prefetch()
            self.assertEqual(out.getvalue(),
                f"YouTube zablokoval transcript requesty ({error.__name__}) pri videu {VID}. "
                f"Prefetch prepisov je pozastavený na {yt.BLOCK_HOURS} h, 1 videí čaká v rade.\n")
            self.assertEqual(yt.load(yt.STATE, {})["blocked_until"], NOW + yt.BLOCK_HOURS * 3600)
        self.tag.assert_not_called()
        self.upload.assert_not_called()

    def test_upload_and_tag_failures_retry(self):
        for boundary in (self.upload, self.tag):
            yt.save(yt.STATE, {})
            if boundary is self.tag:
                self.track.fetch.side_effect = errors.CouldNotRetrieveTranscript()
            boundary.side_effect = OSError("secret")
            out = io.StringIO()
            with contextlib.redirect_stderr(out):
                yt.prefetch()
                yt.prefetch()
            self.assertEqual(out.getvalue(), "OSError\nOSError\n")
            self.assertEqual(yt.load(yt.STATE, {})["fetches"], [NOW, NOW])

    def test_attempt_precedes_request(self):
        def check():
            self.assertEqual(yt.load(yt.STATE, {})["fetches"], [NOW])
            raise RuntimeError("network failed")
        self.track.fetch.side_effect = check
        with self.assertRaises(RuntimeError):
            yt.prefetch()

    def test_not_hourly(self):
        self.b["tags"] = []
        yt.prefetch()
        api.YouTubeTranscriptApi.assert_not_called()

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


class GetTests(unittest.TestCase):
    def test_outputs(self):
        b = bookmark()
        cases = [
            (b, capture()["transcript"], 0, "[transcript language=en auto_generated=True]\nhello world\n"),
            (b, None, 3, "UNAVAILABLE: the transcript attachment is invalid\n"),
            (dict(b, assets=[]), None, 2, "PENDING: transcript not fetched yet; the paced prefetch job will get it. Leave this bookmark for a later run.\n"),
            (dict(b, assets=[], tags=[{"name": kt.UNAVAILABLE_TAG}]), None, 3, "UNAVAILABLE: no captions for this video\n"),
            (None, None, 2, "PENDING: this video is not in Karakeep yet; bookmark it first.\n")]
        for book, transcript, code, expected in cases:
            with patch.object(kt, "find_bookmark", return_value=book), patch.object(kt, "read", return_value=transcript):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(yt.get(VID), code)
                self.assertEqual(out.getvalue(), expected)

    def test_invalid_argument_redacted(self):
        out = io.StringIO()
        with patch.object(kt, "find_bookmark") as find, contextlib.redirect_stdout(out):
            self.assertEqual(yt.get("https://example.com/?token=secret"), 3)
        find.assert_not_called()
        self.assertNotIn("secret", out.getvalue())


class GateTests(unittest.TestCase):
    def test_hourly(self):
        ok = dict(bookmark(), id="ok", tags=[{"name": "janitor-processed"}])
        pending = dict(ok, id="pending", assets=[])
        with patch.object(gate, "fetch_bookmarks", return_value=[pending, ok]), \
             patch.object(gate.subprocess, "run"), \
             patch.object(gate, "clippings_pending", return_value=[]), \
             patch.object(gate, "missing_descriptions", return_value=[]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                gate.main("hourly")
            self.assertIn("- ok |", out.getvalue())
            self.assertNotIn("- pending |", out.getvalue())
            self.assertIn("YouTube transcript: ok", out.getvalue())
