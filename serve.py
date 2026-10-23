#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 naromil
"""Question Trainer - static app server with disk-backed progress.

Serves the repository root (the app is at /app/) and exposes a tiny progress
API so a session survives a browser-data wipe or a machine change:

    GET  /api/progress   stored JSON state, or 204 when none exists
    POST /api/progress   validate and atomically write a progress state

Python standard library only. Run ``./qt`` or ``python3 serve.py``. The server
stops itself after five minutes without requests (``--idle-timeout`` changes it).
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_PATH = "/api/progress"
APP_PATH = "/app/"
MAX_BODY = 2 * 1024 * 1024
STATE_APP = "question-trainer"
STATE_VERSION = 1
IDLE_TIMEOUT = 300.0


def is_progress_state(payload: object) -> bool:
    """A progress state is a JSON object with the app marker and version."""
    return (
        isinstance(payload, dict)
        and payload.get("app") == STATE_APP
        and type(payload.get("v")) is int
        and payload.get("v") == STATE_VERSION
    )


class TrainerServer(ThreadingHTTPServer):
    """Threaded server that records when it last answered a request."""

    daemon_threads = True
    last_activity: float = 0.0


class TrainerHandler(SimpleHTTPRequestHandler):
    """Static files from the repository root, plus /api/progress."""

    progress_path: Path = ROOT / "progress" / "progress.json"
    progress_lock = threading.Lock()

    def __init__(self, *args: object, **kwargs: object) -> None:
        kwargs["directory"] = str(ROOT)
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    # Every response, including errors and generated directory listings, is
    # uncacheable so a reload always sees the current data and progress. The
    # marker header lets a second launch recognise an instance of its own.
    def end_headers(self) -> None:
        self.server.last_activity = time.monotonic()
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Question-Trainer", "1")
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
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=IDLE_TIMEOUT,
        metavar="SECONDS",
        help="stop after this long without requests (default 300, 0 disables)",
    )
    return parser.parse_args()


def probe_running(host: str, port: int) -> tuple[str, str | None] | None:
    """Return (app URL, progress path) when Question Trainer already serves the port."""
    connect = "127.0.0.1" if host in ("", "0.0.0.0") else host
    base = f"http://{connect}:{port}"
    request = urllib.request.Request(base + API_PATH, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.headers.get("X-Question-Trainer") != "1":
                return None
            return base + APP_PATH, response.headers.get("X-Progress-Path")
    except OSError:
        return None


def reopen_running(args: argparse.Namespace, progress_path: Path) -> int:
    """The port is taken: if our own server holds it, open that one instead."""
    running = probe_running(args.host, args.port)
    if running is None:
        print(
            f"Port {args.host}:{args.port} is already in use by another program.",
            file=sys.stderr,
        )
        return 1
    url, served_progress = running
    print(f"Question Trainer is already running: {url}", flush=True)
    if served_progress and Path(served_progress).resolve() != progress_path:
        print(f"Note: it keeps progress in {served_progress}.", flush=True)
    if not args.no_open:
        webbrowser.open(url)
    return 0


def watch_idle(server: TrainerServer, timeout: float) -> None:
    """Stop the server once it has answered no request for ``timeout`` seconds."""
    interval = max(0.05, min(1.0, timeout / 4.0))
    while True:
        time.sleep(interval)
        if time.monotonic() - server.last_activity >= timeout:
            print(f"\nNo requests for {timeout:g}s; stopping.", flush=True)
            server.shutdown()
            return


def main() -> int:
    args = parse_args()
    progress_path = Path(args.progress).expanduser()
    if not progress_path.is_absolute():
        progress_path = (ROOT / progress_path).resolve()
    TrainerHandler.progress_path = progress_path

    try:
        server = TrainerServer((args.host, args.port), TrainerHandler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            return reopen_running(args, progress_path)
        raise

    server.last_activity = time.monotonic()
    host, port = server.server_address[:2]
    url = f"http://{host}:{port}{APP_PATH}"
    print(f"Question Trainer: {url}", flush=True)
    print(f"Progress file: {progress_path}", flush=True)

    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    if args.idle_timeout > 0:
        threading.Thread(
            target=watch_idle,
            args=(server, args.idle_timeout),
            name="idle-watchdog",
            daemon=True,
        ).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
