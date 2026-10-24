#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 naromil
"""HTTP tests for serve.py: routing, security headers, progress backup.

Every test starts the real server as a subprocess on an ephemeral port and
talks to it over 127.0.0.1 only. Run one of:

    python3 tools/test_server.py
    python3 -m unittest tools/test_server.py

Python standard library only.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from queue import Empty, Queue
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SERVE = ROOT / "serve.py"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import serve  # noqa: E402 - repo module, imported after ROOT is known


API_PATH = "/api/progress"
MAX_BODY = 2 * 1024 * 1024
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; connect-src 'self'; object-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep 3xx responses observable instead of following them."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def http_request(
    method: str, url: str, body: bytes | None = None, timeout: float = 10.0
) -> tuple[int, Any, bytes]:
    """Return (status, headers, body) without following redirects."""
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.headers, exc.read()
        finally:
            exc.close()


def progress_state(updated: int) -> dict[str, object]:
    """A minimal but valid progress state."""
    return {
        "app": "question-trainer",
        "v": 1,
        "updated": updated,
        "q": {},
        "sets": {},
        "local": {},
        "archived": {},
        "days": {},
        "settings": {"length": 10, "practiceAll": True, "theme": "auto", "sound": True},
        "totals": {"a": 0, "c": 0, "sessions": 0},
    }


class ServeProcess:
    """serve.py running on an ephemeral port, terminated by ``stop``."""

    URL_RE = re.compile(r"Question Trainer: (http://\S+)")

    def __init__(self, progress_path: Path) -> None:
        self.proc = subprocess.Popen(
            [
                sys.executable,
                str(SERVE),
                "--port", "0",
                "--no-open",
                "--progress", str(progress_path),
            ],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._lines: Queue[str | None] = Queue()
        self._output: list[str] = []
        self._stopped = False
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        try:
            self.url = self._wait_for_url()
            parsed = urllib.parse.urlsplit(self.url)
            self.base = f"{parsed.scheme}://{parsed.netloc}"
            self._wait_until_ready()
        except BaseException:
            self.stop()
            raise

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self._output.append(line)
                self._lines.put(line)
        except (OSError, ValueError):
            pass
        finally:
            self._lines.put(None)

    def output(self) -> str:
        return "".join(self._output)[-3000:]

    def _wait_for_url(self) -> str:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                line = self._lines.get(timeout=0.2)
            except Empty:
                if self.proc.poll() is not None:
                    break
                continue
            if line is None:
                break
            match = self.URL_RE.search(line)
            if match:
                return match.group(1)
        raise RuntimeError(
            f"serve.py did not print a URL (exit {self.proc.poll()}): {self.output()}"
        )

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                status, _, _ = http_request("GET", self.url, timeout=1)
                if status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise RuntimeError(
            f"server never answered {self.url} (exit {self.proc.poll()}): {self.output()}"
        )

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        if self.proc.stdout is not None:
            try:
                self.proc.stdout.close()
            except OSError:
                pass
        self._reader.join(timeout=2)


class TestServer(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def start_server(self, progress: Path | None = None) -> ServeProcess:
        server = ServeProcess(progress or self.tmp / "progress.json")
        self.addCleanup(server.stop)
        return server

    def post(self, server: ServeProcess, payload: object) -> tuple[int, Any, bytes]:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return http_request("POST", server.base + API_PATH, body)

    def progress_files(self) -> tuple[Path, Path]:
        path = self.tmp / "progress.json"
        return path, Path(str(path) + ".bak")

    # -- routing and static serving -------------------------------------
    def test_root_redirects_to_app(self) -> None:
        server = self.start_server()
        status, headers, _ = http_request("GET", server.base + "/")
        self.assertEqual(302, status)
        self.assertEqual("/app/", headers.get("Location"))

    def test_app_without_slash_redirects(self) -> None:
        server = self.start_server()
        status, headers, _ = http_request("GET", server.base + "/app")
        self.assertEqual(302, status)
        self.assertEqual("/app/", headers.get("Location"))

    def test_app_and_question_data_are_served(self) -> None:
        server = self.start_server()
        status, headers, body = http_request("GET", server.base + "/app/")
        self.assertEqual(200, status)
        self.assertIn(b"Question Trainer", body)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        status, _, body = http_request("GET", server.base + "/questions/index.json")
        self.assertEqual(200, status)
        index = json.loads(body)
        self.assertIsInstance(index, dict)
        self.assertTrue(index)
        units = [
            path for path in (ROOT / "questions").glob("*/*.json")
            if path.name != "index.json"
        ]
        self.assertTrue(units, "no unit files to serve")
        unit = "/" + units[0].relative_to(ROOT).as_posix()
        status, _, _ = http_request("GET", server.base + unit)
        self.assertEqual(200, status, unit)

    def test_directories_have_no_listings(self) -> None:
        server = self.start_server()
        status, headers, body = http_request("GET", server.base + "/questions/")
        self.assertEqual(404, status)
        self.assertNotIn("text/html", headers.get("Content-Type", ""))
        self.assertNotIn(b"everyday-science", body)
        self.assertNotIn(b"index.json", body)

    def test_hidden_paths_are_not_found(self) -> None:
        server = self.start_server()
        for route in ("/.gitignore", "/.supervision/round-1-report.md",
                      "/.supervision/"):
            status, _, _ = http_request("GET", server.base + route)
            self.assertEqual(404, status, route)

    def test_traversal_is_forbidden(self) -> None:
        server = self.start_server()
        status, _, _ = http_request("GET", server.base + "/%2e%2e/README.md")
        self.assertEqual(403, status)

    def test_progress_file_and_backup_are_not_static(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix="qt-test-progress-", dir=ROOT))
        self.addCleanup(shutil.rmtree, directory, True)
        path = directory / "progress.json"
        server = self.start_server(path)
        self.assertEqual(204, self.post(server, progress_state(1))[0])
        self.assertEqual(204, self.post(server, progress_state(2))[0])
        self.assertTrue(Path(str(path) + ".bak").exists())
        route = f"/{directory.name}/progress.json"
        for candidate in (route, route + ".bak"):
            for method in ("GET", "HEAD"):
                status, _, _ = http_request(method, server.base + candidate)
                self.assertEqual(404, status, f"{method} {candidate}")

    def test_repository_progress_directory_is_private_with_custom_path(self) -> None:
        directory = ROOT / "progress"
        directory.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="serve-test-", suffix=".json", dir=str(directory), delete=False
        ) as handle:
            placeholder = Path(handle.name)
        self.addCleanup(placeholder.unlink, missing_ok=True)
        server = self.start_server()  # custom progress path lives in tmp
        route = f"/progress/{placeholder.name}"
        for method in ("GET", "HEAD"):
            status, headers, body = http_request(method, server.base + route)
            self.assertEqual(404, status, f"{method} {route}")
            self.assertIn("application/json", headers.get("Content-Type", ""))
            if method == "HEAD":
                self.assertEqual(b"", body)

    # -- security headers ----------------------------------------------
    def test_security_headers_are_on_every_response(self) -> None:
        server = self.start_server()
        for route in ("/app/", "/api/progress", "/.gitignore", "/app"):
            status, headers, _ = http_request("GET", server.base + route)
            self.assertIn(status, (200, 204, 302, 404), route)
            self.assertEqual(CONTENT_SECURITY_POLICY,
                             headers.get("Content-Security-Policy"), route)
            self.assertEqual("no-referrer", headers.get("Referrer-Policy"), route)
            self.assertEqual("DENY", headers.get("X-Frame-Options"), route)
            self.assertEqual("geolocation=(), microphone=(), camera=()",
                             headers.get("Permissions-Policy"), route)
            self.assertEqual("no-store", headers.get("Cache-Control"), route)
            self.assertEqual("nosniff",
                             headers.get("X-Content-Type-Options"), route)

    # -- progress API ---------------------------------------------------
    def test_get_without_progress_is_204(self) -> None:
        server = self.start_server()
        status, _, body = http_request("GET", server.base + API_PATH)
        self.assertEqual(204, status)
        self.assertEqual(b"", body)

    def test_post_then_get_round_trips(self) -> None:
        server = self.start_server()
        first = progress_state(1)
        status, _, body = self.post(server, first)
        self.assertEqual(204, status)
        self.assertEqual(b"", body)
        status, headers, body = http_request("GET", server.base + API_PATH)
        self.assertEqual(200, status)
        self.assertEqual("primary", headers.get("X-Progress-Source"))
        self.assertEqual(first, json.loads(body))

    def test_second_post_creates_backup_of_first_state(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        first = progress_state(1)
        second = progress_state(2)
        self.assertEqual(204, self.post(server, first)[0])
        self.assertFalse(backup.exists(), "the first write must not create a backup")
        self.assertEqual(204, self.post(server, second)[0])
        self.assertEqual(first, json.loads(backup.read_text(encoding="utf-8")))
        self.assertEqual(second, json.loads(path.read_text(encoding="utf-8")))

    def test_stale_post_is_rejected_without_backup(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        newer = progress_state(2)
        self.assertEqual(204, self.post(server, newer)[0])
        status, headers, body = self.post(server, progress_state(1))
        self.assertEqual(409, status)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertEqual(CONTENT_SECURITY_POLICY,
                         headers.get("Content-Security-Policy"))
        self.assertEqual("nosniff", headers.get("X-Content-Type-Options"))
        conflict = json.loads(body)
        self.assertIn("error", conflict)
        self.assertEqual(2, conflict["current"])
        self.assertEqual(newer, json.loads(path.read_text(encoding="utf-8")))
        self.assertFalse(backup.exists())

    def test_identical_post_is_a_no_op(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        state = progress_state(2)
        self.assertEqual(204, self.post(server, state)[0])
        before = path.read_bytes()
        status, _, body = self.post(server, state)
        self.assertEqual(204, status)
        self.assertEqual(b"", body)
        self.assertEqual(before, path.read_bytes())
        self.assertFalse(backup.exists())

    def test_conflicting_same_updated_is_rejected(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        stored = progress_state(2)
        self.assertEqual(204, self.post(server, stored)[0])
        before = path.read_bytes()
        conflicting = progress_state(2)
        conflicting["q"] = {"other": {"a": 1}}
        status, headers, body = self.post(server, conflicting)
        self.assertEqual(409, status)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertEqual(2, json.loads(body)["current"])
        self.assertEqual(before, path.read_bytes())
        self.assertFalse(backup.exists())

    def test_newer_post_replaces_state_and_backs_up_previous(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        previous = progress_state(2)
        self.assertEqual(204, self.post(server, previous)[0])
        self.assertFalse(backup.exists())
        newer = progress_state(3)
        status, _, body = self.post(server, newer)
        self.assertEqual(204, status)
        self.assertEqual(b"", body)
        self.assertEqual(previous, json.loads(backup.read_text(encoding="utf-8")))
        self.assertEqual(newer, json.loads(path.read_text(encoding="utf-8")))

    def test_corrupt_primary_recovers_from_backup(self) -> None:
        server = self.start_server()
        path, _ = self.progress_files()
        first = progress_state(1)
        self.assertEqual(204, self.post(server, first)[0])
        self.assertEqual(204, self.post(server, progress_state(2))[0])
        path.write_text("{ this is not json", encoding="utf-8")
        status, headers, body = http_request("GET", server.base + API_PATH)
        self.assertEqual(200, status)
        self.assertEqual("backup", headers.get("X-Progress-Source"))
        self.assertEqual(first, json.loads(body))

    def test_primary_with_wrong_marker_recovers_from_backup(self) -> None:
        server = self.start_server()
        path, _ = self.progress_files()
        first = progress_state(1)
        self.assertEqual(204, self.post(server, first)[0])
        self.assertEqual(204, self.post(server, progress_state(2))[0])
        path.write_text(json.dumps({"app": "something-else", "v": 1}), encoding="utf-8")
        status, headers, body = http_request("GET", server.base + API_PATH)
        self.assertEqual(200, status)
        self.assertEqual("backup", headers.get("X-Progress-Source"))
        self.assertEqual(first, json.loads(body))

    def test_corrupt_primary_without_backup_is_a_500(self) -> None:
        server = self.start_server()
        path, _ = self.progress_files()
        path.write_text("{ this is not json", encoding="utf-8")
        status, _, body = http_request("GET", server.base + API_PATH)
        self.assertEqual(500, status)
        self.assertIn("error", json.loads(body))

    def test_invalid_payload_is_rejected_without_writing(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        status, _, body = self.post(server, {"nope": True})
        self.assertEqual(400, status)
        self.assertIn("error", json.loads(body))
        self.assertFalse(path.exists())
        self.assertFalse(backup.exists())

    def test_oversized_payload_is_rejected(self) -> None:
        server = self.start_server()
        path, _ = self.progress_files()
        status, _, _ = self.post(server, b"x" * (MAX_BODY + 1))
        self.assertEqual(413, status)
        self.assertFalse(path.exists())

    def test_head_progress_matches_availability(self) -> None:
        server = self.start_server()
        status, _, body = http_request("HEAD", server.base + API_PATH)
        self.assertEqual(204, status)
        self.assertEqual(b"", body)
        self.assertEqual(204, self.post(server, progress_state(1))[0])
        status, headers, body = http_request("HEAD", server.base + API_PATH)
        self.assertEqual(200, status)
        self.assertEqual(b"", body)
        self.assertGreater(int(headers.get("Content-Length", "0")), 0)

    def test_probe_running_recognises_corrupt_progress(self) -> None:
        server = self.start_server()
        path, backup = self.progress_files()
        path.write_text("{ corrupt", encoding="utf-8")
        self.assertFalse(backup.exists())
        parsed = urllib.parse.urlsplit(server.url)
        assert parsed.hostname is not None and parsed.port is not None
        self.assertEqual(
            (server.base + "/app/", str(path)),
            serve.probe_running(parsed.hostname, parsed.port),
        )


if __name__ == "__main__":
    unittest.main()
