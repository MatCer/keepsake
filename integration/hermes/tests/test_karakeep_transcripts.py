"""Karakeep attachment contract; no live services."""
import contextlib
import copy
import hashlib
import io
import http.server
import json
import socket
import threading
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import karakeep_transcripts as kt

# Fail closed: even a accidentally unmocked request cannot reach the internet.
_connect = socket.socket.connect
def local_connect(sock, address):
    if not isinstance(address, tuple) or address[0] != "127.0.0.1":
        raise AssertionError("network forbidden")
    return _connect(sock, address)
def setUpModule():
    socket.socket.connect = local_connect


def tearDownModule():
    socket.socket.connect = _connect

api = types.ModuleType("youtube_transcript_api")
errors = types.ModuleType("youtube_transcript_api._errors")
errors.CouldNotRetrieveTranscript = type("CouldNotRetrieveTranscript", (Exception,), {})
for name in ("RequestBlocked", "YouTubeRequestFailed"):
    setattr(errors, name, type(name, (errors.CouldNotRetrieveTranscript,), {}))
api.NoTranscriptFound = type("NoTranscriptFound", (errors.CouldNotRetrieveTranscript,), {})
api.YouTubeTranscriptApi = Mock()
sys.modules[api.__name__] = api
sys.modules[errors.__name__] = errors

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



class AssetTests(unittest.TestCase):
    def test_selection_pure(self):
        with patch.object(kt, "asset_bytes", side_effect=AssertionError("download")):
            for langs, expected in ((["cs", "sk", "en", "fr"], "en"),
                                    (["cs", "sk"], "sk"), (["fr", "de"], "de"),
                                    (["en", "en"], "1")):
                b = bookmark()
                b["assets"] = [bookmark(capture(language=l), str(i) if langs == ["en", "en"] else l)["assets"][0]
                               for i, l in enumerate(langs)]
                self.assertEqual(kt.attachment(b)["id"], expected)
                self.assertEqual(kt.status(b), "ok")
            for b in (None, [], {}, {"content": []}, {"content": {"url": 42}},
                      {"content": {"url": capture()["url"]}, "assets": [None, 1, {}]}):
                self.assertIsNone(kt.attachment(b))
                self.assertEqual(kt.status(b), "pending")
            b = bookmark()
            b["tags"] = [None, {"name": kt.UNAVAILABLE_TAG}]
            self.assertEqual(kt.status(b), "ok")
            b["assets"] = []
            self.assertEqual(kt.status(b), "unavailable")

    def test_non_candidates(self):
        for field, value in (("assetType", "screenshot"), ("fileName", "wrong"), ("id", None)):
            b = bookmark()
            b["assets"][0][field] = value
            self.assertIsNone(kt.attachment(b))
        b = bookmark()
        b["content"]["url"] = "https://youtu.be/XXXXXXXXXXX"
        self.assertIsNone(kt.attachment(b))
        b["content"]["type"] = "text"
        self.assertIsNone(kt.attachment(b))

    def test_roundtrip(self):
        for provenance in ("browser-dom", "youtube-api"):
            c = capture("</script><>&\u2028\u2029", None)
            c["provenance"] = provenance
            raw = kt.to_asset_html(c)
            self.assertEqual(kt.file_name(c), bookmark(c)["assets"][0]["fileName"])
            self.assertEqual(kt.read(bookmark(c), lambda _: raw.encode()), c["transcript"])
            self.assertIn("&lt;/script&gt;", raw)
            self.assertIn("&amp;t=0s", raw)
            self.assertIn("\\u003c/script\\u003e", raw)
            self.assertEqual(raw.count("</script>"), 1)

    def test_extension_asset(self):
        c = capture("</script><>&\u2028\u2029")
        # Literal document layout from toTranscriptAssetHtml in src/lib/format.ts.
        data = json.dumps(c, ensure_ascii=False, separators=(",", ":"))
        for char in "<>&\u2028\u2029":
            data = data.replace(char, "\\u%04x" % ord(char))
        source = f"https://www.youtube.com/watch?v={VID}"
        raw = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
               '<meta name="keepsake-schema" content="keepsake.capture/v1">'
               '<title>Transcript: Example</title></head><body><h1>Example</h1>'
               f'<p>Source: <a href="{source}">{source}</a> · captured '
               '2026-09-30T20:00:00.000Z from the open YouTube page (browser-dom)</p>'
               f'<p><a href="{source}&amp;t=0s">0:00</a> &lt;/script&gt;&lt;&gt;&amp;\u2028\u2029</p>'
               f'<script type="application/json" id="keepsake-capture">{data}</script></body></html>')
        self.assertEqual(kt.read(bookmark(c), lambda _: raw.encode()), c["transcript"])
        self.assertEqual(kt.to_asset_html(c), raw)

    def test_human_html(self):
        c = capture('a < b & "quoted"')
        c["title"] = "<title>"
        c["transcript"]["segments"][0]["start"] = 3661.125
        c["transcript"]["chapters"] = [{"start": 0, "title": "<chapter>"}]
        raw = kt.to_asset_html(c)
        self.assertIn("<h1>&lt;title&gt;</h1>", raw)
        self.assertIn('<h2>&lt;chapter&gt;</h2><p>', raw)
        self.assertIn('&amp;t=3661.125s">1:01:01</a> a &lt; b &amp; &quot;quoted&quot;', raw)
        c["transcript"]["language"] = "e_n!"
        self.assertIn("-en-", kt.file_name(c))

    def test_invalid(self):
        variants = []
        for section, key, value in (
                ("video", "id", "XXXXXXXXXXX"), ("transcript", "text", "tampered"),
                ("transcript", "sha256", "0" * 64), ("transcript", "generated", "true"),
                ("transcript", "language", 42), ("transcript", "segments", [])):
            c = capture()
            c[section][key] = value
            variants.append(html(c))
        for start in (-1, True, float("nan"), float("inf"), 10 ** 400):
            c = capture()
            c["transcript"]["segments"][0]["start"] = start
            variants.append(html(c))
        for key in ("schema", "kind", "provenance"):
            c = capture()
            c[key] = "wrong"
            variants.append(html(c))
        c = capture()
        c["transcript"]["segments"] *= 20_001
        variants += [html(c), html(capture("x" * 1_000_001)), html(capture("")),
                     b"x" * (kt.MAX_BYTES + 1), b"\xff", b"<html></html>",
                     html(capture()) * 2, html(capture()).replace(b"</script>", b"")]
        for raw in variants:
            with self.subTest(size=len(raw)):
                self.assertIsNone(kt.read(bookmark(), lambda _: raw))
        b = bookmark()
        b["assets"][0]["fileName"] = f"keepsake-transcript-{VID}-en-000000000000.html"
        self.assertIsNone(kt.read(b, lambda _: html(capture())))
        self.assertIsNone(kt.read(bookmark(), Mock(side_effect=OSError("secret"))))

    def test_upload_order_and_failure(self):
        c, b = capture(), bookmark()
        with patch.object(kt, "upload_asset", return_value="new") as upload, patch.object(kt, "attach") as attach:
            kt.upload(b, c)
            upload.assert_called_once_with(kt.file_name(c), kt.to_asset_html(c))
            attach.assert_called_once_with(b["id"], "new")
            attach.side_effect = OSError("secret")
            with self.assertRaises(OSError):
                kt.upload(b, c)


class RequestTests(unittest.TestCase):
    def test_timeout_auth_cap_and_empty_response(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(kt, "PROFILE_HOME", Path(tmp)):
            (Path(tmp) / "config.yaml").write_text(
                'KARAKEEP_API_ADDR: "http://127.0.0.1:1/"\nKARAKEEP_API_KEY: "test-key"\n')
            response = Mock()
            response.read.return_value = b""
            opener = Mock()
            opener.open.return_value.__enter__ = Mock(return_value=response)
            opener.open.return_value.__exit__ = Mock(return_value=False)
            with patch.object(kt, "_OPENER", opener):
                self.assertIsNone(kt.api_json("POST", "/bookmarks/b/tags", {"tags": []}))
            req = opener.open.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
            self.assertEqual(opener.open.call_args.kwargs, {"timeout": 30})
            response.read.assert_called_once_with(kt.MAX_BYTES + 1)



class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.seen = []
        seen = self.seen
        self.reply = b'{}'
        self.code = 200
        self.location = None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.command, self.path, self.headers,
                             self.rfile.read(int(self.headers.get("Content-Length", 0)))))
                self.send_response(owner.code)
                if owner.location:
                    self.send_header("Location", owner.location)
                self.end_headers()
                self.wfile.write(owner.reply)
            do_POST = do_GET
            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.addr = f"http://127.0.0.1:{server.server_port}"
        (self.root / "config.yaml").write_text(
            f'KARAKEEP_API_ADDR: "{self.addr}/"\nKARAKEEP_API_KEY: "test-key"\n')
        self.addCleanup(patch.stopall)
        patch.object(kt, "PROFILE_HOME", self.root).start()

    def test_helpers(self):
        self.reply = b'{"assetId":"new"}'
        self.assertEqual(kt.upload_asset("test.html", "<html>safe</html>"), "new")
        method, path, headers, body = self.seen[-1]
        self.assertEqual((method, path), ("POST", "/api/v1/assets"))
        self.assertIn("multipart/form-data; boundary=", headers["Content-Type"])
        self.assertIn(b'name="file"; filename="test.html"', body)
        self.assertIn(b"Content-Type: text/html", body)
        self.assertIn(b"<html>safe</html>", body)
        kt.attach("b/id ?", "a/id")
        self.assertEqual(self.seen[-1][1], "/api/v1/bookmarks/b%2Fid%20%3F/assets")
        self.assertEqual(json.loads(self.seen[-1][3]), {"id": "a/id", "assetType": "userUploaded"})
        kt.add_tag("b/id ?", kt.UNAVAILABLE_TAG)
        self.assertEqual(self.seen[-1][1], "/api/v1/bookmarks/b%2Fid%20%3F/tags")
        self.assertEqual(json.loads(self.seen[-1][3]), {"tags": [{"tagName": kt.UNAVAILABLE_TAG}]})
        self.reply = b"asset"
        self.assertEqual(kt.asset_bytes("a/id ?"), b"asset")
        self.assertEqual(self.seen[-1][1], "/api/v1/assets/a%2Fid%20%3F")
        self.assertTrue(all(r[2]["Authorization"] == "Bearer test-key" for r in self.seen))

    def test_find(self):
        url = f"https://youtu.be/{VID}?x=1&y=2"
        with patch.object(kt, "api_json", side_effect=[{"bookmarkId": None}, {"bookmarkId": "b/id"}, bookmark()]) as api_json:
            self.assertEqual(kt.find_bookmark(url), bookmark())
            self.assertEqual(api_json.call_args_list[0].args,
                             ("GET", f"/bookmarks/check-url?url=https%3A%2F%2Fyoutu.be%2F{VID}%3Fx%3D1%26y%3D2"))
            self.assertEqual(api_json.call_args_list[1].args,
                             ("GET", f"/bookmarks/check-url?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{VID}"))
            self.assertEqual(api_json.call_args_list[2].args, ("GET", "/bookmarks/b%2Fid"))
        with patch.object(kt, "api_json", return_value={"bookmarkId": None}):
            self.assertIsNone(kt.find_bookmark(VID))
        self.reply = b'{"bookmarkId":null}'
        self.assertIsNone(kt.find_bookmark(url))
        self.assertIn("%26y%3D2", self.seen[0][1])

    def test_redirect_refused(self):
        self.code, self.location = 302, self.addr + "/steal"
        with self.assertRaises(Exception):
            kt.asset_bytes("redirect")
        self.assertEqual(len(self.seen), 1)
        self.assertNotEqual(self.seen[0][1], "/steal")

    def test_cap(self):
        self.reply = b"x" * kt.MAX_BYTES
        self.assertEqual(len(kt.asset_bytes("limit")), kt.MAX_BYTES)
        self.reply += b"x"
        with self.assertRaises(ValueError):
            kt.asset_bytes("over")
