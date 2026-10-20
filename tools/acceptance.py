#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 naromil
"""Acceptance gate for the Question Trainer improvement round.

The gate is the supervisor's, not the implementer's. It is hash-locked against
``tools/acceptance.sha256`` so a green run also proves its checks were not
edited. Every check reads an artifact (a rendered DOM, a file on disk, the HTTP
API, the process exit code) rather than trusting the app's own report.

Run:  python3 tools/acceptance.py
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = Path(__file__).resolve()
DIGEST_FILE = ROOT / "tools" / "acceptance.sha256"
INDEX = ROOT / "questions" / "index.json"
QUESTIONS_README = ROOT / "questions" / "README.md"
README = ROOT / "README.md"
SERVE = ROOT / "serve.py"
LAUNCHER = ROOT / "qt"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str):
    def wrap(fn):
        try:
            detail = fn() or ""
            RESULTS.append((name, True, str(detail)))
        except Exception as exc:  # noqa: BLE001 - a failing check is data, not a crash
            RESULTS.append((name, False, f"{type(exc).__name__}: {exc}"))
        return fn

    return wrap


def need(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------
# Gate integrity
# --------------------------------------------------------------------------
@check("gate is unmodified (sha256 sidecar)")
def gate_integrity() -> str:
    need(DIGEST_FILE.exists(), "tools/acceptance.sha256 is missing")
    stored = DIGEST_FILE.read_text().split()[0].strip()
    actual = sha256(GATE)
    need(stored == actual, f"gate digest {actual[:12]} != stored {stored[:12]}")
    return actual[:12]


# --------------------------------------------------------------------------
# The project's own suite (necessary, not sufficient)
# --------------------------------------------------------------------------
@check("node --test tools/test_core.js: 0 failures, >= 28 passes")
def node_tests() -> str:
    proc = subprocess.run(
        ["node", "--test", "tools/test_core.js"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
    )
    out = proc.stdout + proc.stderr
    passes = re.search(r"^# pass (\d+)$", out, re.M)
    fails = re.search(r"^# fail (\d+)$", out, re.M)
    need(proc.returncode == 0, f"node --test exited {proc.returncode}\n{out[-1500:]}")
    need(passes is not None and int(passes.group(1)) >= 28,
         "fewer than 28 passing tests: " + out[-800:])
    need(fails is not None and int(fails.group(1)) == 0, "test failures reported")
    assert passes is not None and fails is not None
    return f"{passes.group(1)} pass / {fails.group(1)} fail"


# --------------------------------------------------------------------------
# Core contract, called directly (independent of the project's own tests)
# --------------------------------------------------------------------------
CORE_PROBE = r"""
const C = require(process.argv[1]);
const fails = [];
function eq(name, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want))
    fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const fresh = C.emptyState(1000);
eq('default length', fresh.settings.length, 10);
eq('default practiceAll', fresh.settings.practiceAll, true);
eq('SESSION_LENGTHS contains 10', C.SESSION_LENGTHS.indexOf(10) >= 0, true);
eq('30 questions, practiceAll on', C.sessionLength({ length: 10, practiceAll: true }, 30), 30);
eq('31 questions, practiceAll on', C.sessionLength({ length: 10, practiceAll: true }, 31), 10);
eq('12 questions, practiceAll on', C.sessionLength({ length: 10, practiceAll: true }, 12), 12);
eq('12 questions, practiceAll off', C.sessionLength({ length: 10, practiceAll: false }, 12), 10);
eq('missing practiceAll defaults on', C.sessionLength({ length: 10 }, 7), 7);
eq('length choice honoured above the cap', C.sessionLength({ length: 20, practiceAll: true }, 40), 20);
const old = C.sanitizeState({
  app: 'question-trainer', v: 1,
  settings: { length: 4, theme: 'dark', sound: false },
  q: {}, sets: {}, local: {}, archived: {}, days: {},
  totals: { a: 0, c: 0, sessions: 0 },
}, 1000);
eq('old export keeps its length', old.settings.length, 4);
eq('old export gains practiceAll', old.settings.practiceAll, true);
eq('old export keeps theme', old.settings.theme, 'dark');
const picked = C.selectSession(C.emptyState(1000), 's', new Array(12).fill(0).map((_, i) => ({
  id: 'q' + i, question: 'q', choices: ['a', 'b'], answer: 0,
})), { mode: 'practice', length: 12 });
eq('selectSession serves a 12-question pool', picked.length, 12);
console.log(JSON.stringify({ fails }));
"""


@check("core.js exposes the session-length contract")
def core_contract() -> str:
    proc = subprocess.run(
        ["node", "-e", CORE_PROBE, str(ROOT / "app" / "core.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    need(proc.returncode == 0, f"node probe failed: {proc.stderr[-1500:]}")
    claims = json.loads(proc.stdout.strip().splitlines()[-1])
    need(not claims["fails"], "core contract: " + "; ".join(claims["fails"]))
    return "10 defaults, practiceAll cap at 30, old exports migrate"


# --------------------------------------------------------------------------
# Question data split into one file per set
# --------------------------------------------------------------------------
def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@check("questions/index.json lists >= 2 set files that all parse")
def question_index() -> str:
    need(INDEX.exists(), "questions/index.json is missing")
    index = load_json(INDEX)
    files = index.get("files")
    need(isinstance(files, list) and len(files) >= 2, "index.json needs a `files` array of >= 2 names")
    need(not any("/" in name or "\\" in name for name in files), "index file names must be bare file names")
    ids = []
    for name in files:
        path = ROOT / "questions" / name
        need(path.exists(), f"questions/{name} is missing")
        data = load_json(path)
        sets = data.get("sets") if isinstance(data.get("sets"), list) else [data]
        need(sets, f"questions/{name} holds no set")
        for item in sets:
            need(isinstance(item.get("id"), str) and item["id"], f"{name}: set without an id")
            need(isinstance(item.get("title"), str) and item["title"], f"{name}: set without a title")
            qs = item.get("questions")
            need(isinstance(qs, list) and qs, f"{name}: set without questions")
            for q in qs:
                need(isinstance(q.get("choices"), list) and len(q["choices"]) >= 2,
                     f"{name}: a question has fewer than 2 choices")
                need(isinstance(q.get("answer"), int) and 0 <= q["answer"] < len(q["choices"]),
                     f"{name}: `answer` out of range")
            ids.append(item["id"])
    need(len(set(ids)) == len(ids), f"duplicate set ids across files: {ids}")
    return f"{len(files)} files, {len(ids)} sets: {', '.join(ids)}"


@check("questions/README.md documents the on-disk format in detail")
def questions_readme() -> str:
    need(QUESTIONS_README.exists(), "questions/README.md is missing")
    text = QUESTIONS_README.read_text(encoding="utf-8")
    need(len(text) >= 2000, f"questions/README.md is only {len(text)} chars")
    for token in ("index.json", "files", "questions", "choices", "answer", "0-based", "id"):
        need(token in text, f"questions/README.md never mentions {token!r}")
    need("```" in text, "questions/README.md has no code block")
    return f"{len(text)} chars, {text.count('```') // 2} code blocks"


@check("root README points at questions/README.md and no longer documents sets.json")
def root_readme() -> str:
    text = README.read_text(encoding="utf-8")
    need("questions/README.md" in text, "root README does not link questions/README.md")
    need("questions/sets.json" not in text, "root README still tells the reader about questions/sets.json")
    return "links the format doc"


@check("the old single-file bank is gone")
def old_bank_gone() -> str:
    need(not (ROOT / "questions" / "sets.json").exists(), "questions/sets.json still exists")
    return "questions/sets.json removed"


@check(".gitignore keeps disk progress out of git")
def gitignore_progress() -> str:
    text = (ROOT / ".gitignore").read_text(encoding="utf-8")
    need(re.search(r"^progress/?\*?$|^/progress/$|^progress/$|progress\.json$", text, re.M) is not None,
         ".gitignore has no progress entry")
    return "progress path ignored"


# --------------------------------------------------------------------------
# HTTP server: static app + progress persistence to disk
# --------------------------------------------------------------------------
def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http(method: str, url: str, body: bytes | None = None, timeout: float = 10):
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def start_server(progress_file: Path):
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "serve.py", "--port", str(port), "--no-open",
         "--progress", str(progress_file)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            break
        try:
            status, _ = http("GET", base + "/app/", timeout=1)
            if status == 200:
                return proc, base
        except OSError:
            pass
        time.sleep(0.1)
    output = ""
    if proc.poll() is not None:
        output = (proc.stdout.read() if proc.stdout else "")[-800:]
        raise AssertionError(f"serve.py exited early: {output}")
    proc.terminate()
    raise AssertionError("serve.py never answered on /app/")


def stop(proc) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


PROGRESS_FIXTURE = {
    "app": "question-trainer",
    "v": 1,
    "created": 1000,
    "updated": 2000,
    "q": {"gate-set::gate-q": {"a": 1, "c": 1, "f": 1, "due": 0, "box": 1, "last": 2000}},
    "sets": {"gate-set": {"streak": 1, "pts": 12}},
    "local": {},
    "archived": {},
    "days": {"2026-10-19": {"a": 1, "c": 1}},
    "settings": {"length": 10, "practiceAll": True, "theme": "auto", "sound": True},
    "totals": {"a": 1, "c": 1, "sessions": 1},
}


@check("serve.py serves the app and the split question files")
def server_static() -> str:
    need(SERVE.exists(), "serve.py is missing")
    with tempfile.TemporaryDirectory() as tmp:
        proc, base = start_server(Path(tmp) / "progress.json")
        try:
            status, body = http("GET", base + "/app/")
            need(status == 200 and b"Question Trainer" in body, f"/app/ returned {status}")
            status, body = http("GET", base + "/questions/index.json")
            need(status == 200, f"/questions/index.json returned {status}")
            names = json.loads(body)["files"]
            for name in names:
                status, _ = http("GET", base + f"/questions/{name}")
                need(status == 200, f"/questions/{name} returned {status}")
        finally:
            stop(proc)
        return f"app + {len(names)} question files"


@check("progress is written to the disk file and survives a server restart")
def server_progress() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        progress_file = Path(tmp) / "progress.json"
        proc, base = start_server(progress_file)
        try:
            payload = json.dumps(PROGRESS_FIXTURE).encode()
            status, _ = http("POST", base + "/api/progress", payload)
            need(status in (200, 201, 204), f"POST /api/progress returned {status}")
            need(progress_file.exists(), f"{progress_file} was never created")
            on_disk = json.loads(progress_file.read_text(encoding="utf-8"))
            need(on_disk == PROGRESS_FIXTURE, "the file on disk does not match what was posted")
            status, body = http("GET", base + "/api/progress")
            need(status == 200, f"GET /api/progress returned {status}")
            need(json.loads(body) == PROGRESS_FIXTURE, "GET /api/progress does not round-trip")
            status, body = http("GET", base + "/api/progress")
        finally:
            stop(proc)

        proc, base = start_server(progress_file)
        try:
            status, body = http("GET", base + "/api/progress")
            need(status == 200, f"after restart GET /api/progress returned {status}")
            need(json.loads(body) == PROGRESS_FIXTURE, "progress did not survive the restart")
        finally:
            stop(proc)
        return "posted, read back from disk, survived restart"


@check("progress payloads are rejected when they are not a progress state")
def server_progress_validation() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        progress_file = Path(tmp) / "progress.json"
        proc, base = start_server(progress_file)
        try:
            status, _ = http("POST", base + "/api/progress", b'{"nope":true}')
            need(status >= 400, f"invalid payload accepted with {status}")
            need(not progress_file.exists(), "invalid payload still wrote the progress file")
        finally:
            stop(proc)
        return f"invalid payload -> {status}"


# --------------------------------------------------------------------------
# Rendered DOM (the artifact the user actually sees)
# --------------------------------------------------------------------------
def chromium() -> str:
    found = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome-stable")
    need(found is not None, "no chromium/chrome binary found")
    assert found is not None
    return found


def dump_dom(url: str) -> str:
    proc = subprocess.run(
        [chromium(), "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
         "--virtual-time-budget=8000", "--dump-dom", url],
        capture_output=True,
        text=True,
        timeout=120,
    )
    dom = proc.stdout
    need(len(dom) > 500, f"chromium produced {len(dom)} bytes for {url}: {proc.stderr[-400:]}")
    return dom


CARD_RE = re.compile(r'<article class="card set-card"[\s\S]*?</article>')


@check("main page: set cards keep Practice/Review/Archive, the hero card has no buttons")
def dom_home_cards() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        progress_file = Path(tmp) / "progress.json"
        progress_file.write_text(json.dumps(PROGRESS_FIXTURE), encoding="utf-8")
        proc, base = start_server(progress_file)
        try:
            dom = dump_dom(base + "/app/#/")
        finally:
            stop(proc)
        hero = re.search(r'<div class="hero">([\s\S]*?)<div class="card"><div class="statgrid">', dom)
        need(hero is not None, "no hero card rendered")
        assert hero is not None
        need("Question JSON format" not in hero.group(1),
             "the hero card still shows the Question JSON format button")
        need('href="#/archive"' not in hero.group(1),
             "the hero card still shows the Archive (n) button")
        cards = CARD_RE.findall(dom)
        need(len(cards) >= 2, f"expected >= 2 rendered set cards, found {len(cards)}")
        for card in cards:
            need(">Practice<" in card, "a set card lost its Practice button")
            need(">Review<" in card, "a set card lost its Review button")
            need("data-archive" in card, "a set card lost its Archive button")
            need('mode=review' in card, "the Review button does not open review mode")
            need("card-hit" not in card, "a set card still has the whole-card overlay")
        # The archive tab sits between Progress and Settings.
        nav = re.search(r'<nav class="nav" id="nav">([\s\S]*?)</nav>', dom)
        need(nav is not None, "no nav element rendered")
        assert nav is not None
        pairs = []
        for attrs, label in re.findall(r'<a\b([^>]*)>([\s\S]*?)</a>', nav.group(1)):
            route = re.search(r'data-route="([^"]*)"', attrs)
            if route is None:
                continue
            pairs.append((route.group(1), re.sub(r'<[^>]+>', '', label).strip()))
        need([label for _, label in pairs] == ["Sets", "Progress", "Archive", "Settings", "Format"],
             f"nav order is {[label for _, label in pairs]}")
        need([route for route, _ in pairs] == ["/", "/stats", "/archive", "/settings", "/format"],
             f"nav targets are {[route for route, _ in pairs]}")
        return f"{len(cards)} cards with 3 buttons each, hero clear, nav {' / '.join(label for _, label in pairs)}"


@check("settings page: 10 per session by default and the practice-all switch")
def dom_settings() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        proc, base = start_server(Path(tmp) / "progress.json")
        try:
            dom = dump_dom(base + "/app/#/settings")
        finally:
            stop(proc)
        select = re.search(r'<select id="length">([\s\S]*?)</select>', dom)
        need(select is not None, "settings has no session-length select")
        chosen = re.search(r'value="(\d+)"[^>]*selected', select.group(1))
        need(chosen is not None, "no option is marked selected in the length select")
        assert chosen is not None
        need(chosen.group(1) == "10", f"default session length is {chosen.group(1)}, want 10")
        box = re.search(r'<input[^>]*type="checkbox"[^>]*id="practice-all"[^>]*>', dom)
        need(box is not None, "settings has no #practice-all checkbox")
        need("checked" in box.group(0), "practice-all is not on by default")
        need("30" in dom, "the practice-all setting never explains the 30-question cap")
        return "length 10 selected, practice-all checked, cap documented"


@check("archive page still renders after the nav move")
def dom_archive() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        progress_file = Path(tmp) / "progress.json"
        progress_file.write_text(json.dumps(PROGRESS_FIXTURE), encoding="utf-8")
        proc, base = start_server(progress_file)
        try:
            dom = dump_dom(base + "/app/#/archive")
        finally:
            stop(proc)
        need("Archive" in dom, "archive page is empty")
        need(re.search(r"<h1>Archive</h1>|<h2>Archive</h2>|Archived", dom) is not None,
             "archive page has no heading")
        return "archive route renders"


# --------------------------------------------------------------------------
# One-command launcher
# --------------------------------------------------------------------------
@check("./qt starts the trainer non-interactively")
def launcher() -> str:
    need(LAUNCHER.exists(), "qt launcher is missing")
    need(bool(LAUNCHER.stat().st_mode & 0o111), "qt is not executable")
    port = free_port()
    proc = subprocess.Popen(
        [str(LAUNCHER), "--port", str(port), "--no-open"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        for _ in range(120):
            if proc.poll() is not None:
                break
            try:
                status, body = http("GET", base + "/app/", timeout=1)
                if status == 200 and b"Question Trainer" in body:
                    return f"served /app/ on port {port}"
            except OSError:
                pass
            time.sleep(0.1)
        output = (proc.stdout.read() if proc.stdout else "")[-600:]
        raise AssertionError(f"qt did not serve the app (exit {proc.poll()}): {output}")
    finally:
        stop(proc)


def main() -> int:
    print(f"gate {sha256(GATE)[:12]}  root={ROOT}\n")
    width = max(len(name) for name, _, _ in RESULTS)
    for name, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {detail}")
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
