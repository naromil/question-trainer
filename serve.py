#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 naromil
"""Question Trainer - static app server with disk-backed progress.

Serves the repository root (the app is at /app/) and exposes a tiny progress
API so a session survives a browser-data wipe or a machine change:

    GET  /api/progress   stored JSON state, or 204 when none exists
    POST /api/progress   validate and atomically write a progress state

Python standard library only. Run ``./qt`` or ``python3 serve.py``.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_PATH = "/api/progress"
MAX_BODY = 2 * 1024 * 1024
STATE_APP = "question-trainer"
STATE_VERSION = 1


def is_progress_state(payload: object) -> bool:
    """A progress state is a JSON object with the app marker and version."""
    return (
        isinstance(payload, dict)
        and payload.get("app") == STATE_APP
        and type(payload.get("v")) is int
        and payload.get("v") == STATE_VERSION
    )


class TrainerHandler(SimpleHTTPRequestHandler):
    """Static files from the repository root, plus /api/progress."""

    progress_path: Path = ROOT / "progress" / "progress.json"
    progress_lock = threading.Lock()

    def __init__(self, *args: object, **kwargs: object) -> None:
        kwargs["directory"] = str(ROOT)
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    # Every response, including errors and generated directory listings, is
    # uncacheable so a reload always sees the current data and progress.
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _route(self) -> str:
        return urllib.parse.urlsplit(self.path).path

    def _unsafe_path(self) -> bool:
        path = urllib.parse.unquote(self._route())
        parts = [part for part in path.split("/") if part]
        return (
            any(part in (".", "..") for part in parts)
            or "\\" in path
            or "\x00" in path
        )

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if self.path.split("?", 1)[0] == API_PATH:
            self.send_header("X-Progress-Path", str(self.progress_path))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _get_progress(self) -> None:
        try:
            with self.progress_lock:
                body = self.progress_path.read_bytes()
        except FileNotFoundError:
            self._send_bytes(204, b"", "application/json; charset=utf-8")
            return
        except OSError as exc:
            self._send_json(500, {"error": f"could not read progress: {exc}"})
            return
        self._send_bytes(200, body, "application/json; charset=utf-8")

    def _read_body(self) -> bytes | None:
        header = self.headers.get("Content-Length")
        if header is None:
            self._send_json(400, {"error": "Content-Length is required"})
            return None
        try:
            length = int(header)
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return None
        if length < 0:
            self._send_json(400, {"error": "invalid Content-Length"})
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._send_json(413, {"error": "progress body is larger than 2 MiB"})
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self._send_json(400, {"error": "incomplete body"})
            return None
        return body

    def _write_progress(self, payload: dict) -> None:
        directory = self.progress_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            prefix=self.progress_path.name + ".", suffix=".tmp", dir=str(directory)
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.progress_path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _post_progress(self) -> None:
        body = self._read_body()
        if body is None:
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "body must be JSON"})
            return
        if not is_progress_state(payload):
            self._send_json(400, {
                "error": 'body must be a progress state with app="question-trainer" and v=1'
            })
            return
        assert isinstance(payload, dict)
        try:
            with self.progress_lock:
                self._write_progress(payload)
        except OSError as exc:
            self._send_json(500, {"error": f"could not write progress: {exc}"})
            return
        self._send_bytes(204, b"", "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        route = self._route()
        if route == API_PATH:
            self._get_progress()
            return
        if self._unsafe_path():
            self._send_json(403, {"error": "path traversal is not allowed"})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        if self._route() != API_PATH:
            self._send_json(404, {"error": "not found"})
            return
        self._post_progress()

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
        if self._route() == API_PATH:
            if self.progress_path.exists():
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(self.progress_path.stat().st_size))
                self.send_header("X-Progress-Path", str(self.progress_path))
                self.end_headers()
            else:
                self._send_bytes(204, b"", "application/json; charset=utf-8")
            return
        if self._unsafe_path():
            self._send_json(403, {"error": "path traversal is not allowed"})
            return
        super().do_HEAD()

    def log_message(self, format: str, *args: object) -> None:
        # Keep the console useful but quiet enough for a launcher.
        print(f"{self.address_string()} - {format % args}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve Question Trainer with disk progress.")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port (default 8765)")
    parser.add_argument(
        "--progress",
        default="progress/progress.json",
        help="progress state path (default progress/progress.json, relative to the repo)",
    )
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    progress_path = Path(args.progress).expanduser()
    if not progress_path.is_absolute():
        progress_path = (ROOT / progress_path).resolve()
    TrainerHandler.progress_path = progress_path

    server = ThreadingHTTPServer((args.host, args.port), TrainerHandler)
    server.daemon_threads = True
    host, port = server.server_address[:2]
    url = f"http://{host}:{port}/app/"
    print(f"Question Trainer: {url}", flush=True)
    print(f"Progress file: {progress_path}", flush=True)

    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
