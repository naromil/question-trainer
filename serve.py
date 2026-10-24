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
import urllib.error
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
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; connect-src 'self'; object-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


def is_progress_state(payload: object) -> bool:
    """A progress state is a JSON object with the app marker and version."""
    return (
        isinstance(payload, dict)
        and payload.get("app") == STATE_APP
        and type(payload.get("v")) is int
        and payload.get("v") == STATE_VERSION
    )


def is_progress_bytes(body: bytes) -> bool:
    """True when ``body`` is UTF-8 JSON holding a valid progress state."""
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return is_progress_state(payload)


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

    # Every response, including errors, is uncacheable so a reload always sees
    # the current data and progress, and carries the same security policy. The
    # marker header lets a second launch recognise an instance of its own.
    def end_headers(self) -> None:
        self.server.last_activity = time.monotonic()
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
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

    def _hidden_path(self) -> bool:
        """True for dotfiles and dot-directories, which are never public."""
        path = urllib.parse.unquote(self._route())
        return any(part.startswith(".") for part in path.split("/") if part)

    def _backup_path(self) -> Path:
        return self.progress_path.with_name(self.progress_path.name + ".bak")

    def _serves_progress_file(self) -> bool:
        """True when the request resolves to progress data.

        Everything under the repository's ``progress`` directory is private,
        even when ``--progress`` points elsewhere. The configured progress file
        and its backup are private too, wherever they live.
        """
        candidate = os.path.realpath(self.translate_path(self.path))
        private_directory = os.path.realpath(ROOT / "progress")
        try:
            if os.path.commonpath((candidate, private_directory)) == private_directory:
                return True
        except ValueError:
            pass
        for private in (self.progress_path, self._backup_path()):
            if candidate == os.path.realpath(private):
                return True
            try:
                if os.path.samefile(candidate, private):
                    return True
            except OSError:
                pass
        return False

    def _redirect_to_app(self) -> bool:
        """Send the bare root and /app to the app directory itself."""
        if self._route() not in ("/", "/app"):
            return False
        self.send_response(302)
        self.send_header("Location", APP_PATH)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _send_bytes(
        self, status: int, body: bytes, content_type: str, source: str | None = None
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if self.path.split("?", 1)[0] == API_PATH:
            self.send_header("X-Progress-Path", str(self.progress_path))
        if source is not None:
            self.send_header("X-Progress-Source", source)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def list_directory(self, path: str) -> None:
        """Never expose a directory listing; a listing is a missing page."""
        self._send_bytes(404, b"not found\n", "text/plain; charset=utf-8")

    def _send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _progress_snapshot(self) -> tuple[int, bytes, str | None, str | None]:
        """Resolve the progress bytes to serve, preferring the primary file.

        Returns ``(status, body, source, error)``: 200 with the primary or the
        recovered backup state, 204 when no progress file exists at all, or 500
        when files exist but none holds a valid progress state.
        """
        primary: bytes | None = None
        primary_missing = False
        primary_error: OSError | None = None
        try:
            primary = self.progress_path.read_bytes()
        except FileNotFoundError:
            primary_missing = True
        except OSError as exc:
            primary_error = exc

        if primary is not None and is_progress_bytes(primary):
            return 200, primary, "primary", None

        backup: bytes | None = None
        backup_error: OSError | None = None
        try:
            backup = self._backup_path().read_bytes()
        except FileNotFoundError:
            pass
        except OSError as exc:
            backup_error = exc

        if backup is not None and is_progress_bytes(backup):
            return 200, backup, "backup", None

        if primary_missing and backup is None and backup_error is None:
            return 204, b"", None, None
        if primary_error is not None:
            return 500, b"", None, f"could not read progress: {primary_error}"
        if backup_error is not None:
            return 500, b"", None, f"could not read progress backup: {backup_error}"
        return 500, b"", None, (
            "progress is not a valid progress state and no valid backup exists"
        )

    def _get_progress(self) -> None:
        with self.progress_lock:
            status, body, source, error = self._progress_snapshot()
        if status == 200:
            self._send_bytes(200, body, "application/json; charset=utf-8", source)
        elif status == 204:
            self._send_bytes(204, b"", "application/json; charset=utf-8")
        else:
            self._send_json(500, {"error": error})

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

    def _write_backup(self, body: bytes) -> None:
        """Atomically replace ``<progress>.bak`` with the previous bytes."""
        descriptor, temporary = tempfile.mkstemp(
            prefix=self._backup_path().name + ".",
            suffix=".tmp",
            dir=str(self.progress_path.parent),
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._backup_path())
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

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
            # Preserve the state being replaced; skip it on the first write.
            try:
                previous = self.progress_path.read_bytes()
            except FileNotFoundError:
                previous = None
            if previous is not None:
                self._write_backup(previous)
            os.replace(temporary, self.progress_path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _stored_state(self) -> tuple[int | None, dict | None]:
        """The primary state's parsed object and integer ``updated`` stamp.

        Returns ``(None, None)`` when the file is missing, unreadable, or not a
        valid progress state: such a file is a repair candidate and never
        blocks an incoming write.
        """
        try:
            body = self.progress_path.read_bytes()
        except OSError:
            return None, None
        if not is_progress_bytes(body):
            return None, None
        payload = json.loads(body.decode("utf-8"))
        assert isinstance(payload, dict)
        updated = payload.get("updated")
        return (updated if type(updated) is int else None), payload

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
        conflict: dict[str, object] | None = None
        try:
            with self.progress_lock:
                current_updated, current_payload = self._stored_state()
                incoming_updated = payload.get("updated")
                if type(incoming_updated) is not int:
                    incoming_updated = None
                if (
                    current_updated is not None
                    and incoming_updated is not None
                    and incoming_updated <= current_updated
                ):
                    # An identical state is a redundant no-op; anything else at
                    # or below the stored stamp would roll newer progress back.
                    identical = (
                        incoming_updated == current_updated
                        and payload == current_payload
                    )
                    if not identical:
                        conflict = {
                            "error": "progress state is not newer than the stored state",
                            "current": current_updated,
                        }
                else:
                    self._write_progress(payload)
        except OSError as exc:
            self._send_json(500, {"error": f"could not write progress: {exc}"})
            return
        if conflict is not None:
            self._send_json(409, conflict)
        else:
            self._send_bytes(204, b"", "application/json; charset=utf-8")

    def _reject_static_path(self) -> bool:
        """Answer unsafe, hidden, and private paths before static serving."""
        if self._unsafe_path():
            self._send_json(403, {"error": "path traversal is not allowed"})
            return True
        if self._hidden_path() or self._serves_progress_file():
            self._send_json(404, {"error": "not found"})
            return True
        return False

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self._route() == API_PATH:
            self._get_progress()
            return
        if self._redirect_to_app() or self._reject_static_path():
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        if self._route() != API_PATH:
            self._send_json(404, {"error": "not found"})
            return
        self._post_progress()

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
        if self._route() == API_PATH:
            self._get_progress()
            return
        if self._redirect_to_app() or self._reject_static_path():
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
    except urllib.error.HTTPError as exc:
        # A corrupt progress file answers 500, but the marker and path headers
        # still identify this server; keep the launcher attaching to it.
        try:
            if exc.headers.get("X-Question-Trainer") != "1":
                return None
            return base + APP_PATH, exc.headers.get("X-Progress-Path")
        finally:
            exc.close()
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
