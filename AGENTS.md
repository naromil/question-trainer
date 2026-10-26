# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first multiple-choice trainer: a static page (`app/`) plus a Python stdlib server (`serve.py`). There's no build step, no package manager and no runtime dependencies, so don't add any. JS is plain ES5-style (`var`, IIFEs, `'use strict'`) loaded with classic `<script>` tags. Python uses the standard library only.

## Commands

```bash
./qt                                   # start server on 127.0.0.1:8765 and open /app/
./qt --port 9000 --no-open --idle-timeout 0 --progress /tmp/p.json   # dev/test run

node --test tools/test_core.js                                # core.js unit tests
node --test --test-name-pattern='mastery' tools/test_core.js  # single test by name
python3 tools/test_server.py                                  # serve.py HTTP tests
python3 -m unittest tools.test_server.TestServer.<test_method>   # single server test
python3 tools/acceptance.py                                   # acceptance gate (see below)
```

`test_core.js` also checks the real bank in `questions/index.json` and its set folders. `questions/` is git-ignored except `questions/README.md`, so that test needs local question data to pass.

## Architecture

- **`app/core.js`**: all pure logic, with no DOM and no storage: bank validation and normalisation (`normalizeFolder`, `buildSet`), grading (`applyAnswer`), mastery, Leitner SRS, session selection, archive/restore, question delete/restore, state sanitising and merging (`sanitizeState`, `mergeStates`, `stampState`), and stats. A UMD wrapper exposes it as `window.QTCore` in the browser and through `module.exports` in node. New logic goes here so it can be tested in node.
- **`app/app.js`**: hash routing, rendering, and persistence. It reads `C = window.QTCore` and loads `../questions/index.json` → `<set>/index.json` → unit files. Progress goes to `localStorage` (`questiontrainer.state.v1`) and is mirrored to `/api/progress` when served by `serve.py`. The in-flight session lives separately in `sessionStorage` (`questiontrainer.session.v1`), so a reload resumes it without re-grading. Without the API (plain static server or `file://`) the app runs in browser-only mode.
- **`serve.py`**: `SimpleHTTPRequestHandler` subclass serving the repo root. Responsibilities:
  - `GET/POST /api/progress`. Writes are atomic and keep the previous file as `<progress>.bak`. A stale or equal-but-different `updated` stamp gets `409` (the client merges and retries once). If the primary file is invalid the server falls back to the backup with `X-Progress-Source: backup`, or answers `500` if there is no valid backup.
  - Never serves hidden files or `progress/`, and never lists directories.
  - Strict CSP and security headers on every response. Inline scripts/styles will be blocked, so keep JS/CSS in their files.
  - Exits after an idle timeout. A second `./qt` detects a running instance and reuses it.

### Data model invariants

- Progress is keyed by **set id + question id**. Ids are stable keys: renaming one resets that item's progress. Question ids must be unique across all units of a set, and set ids across the bank.
- `answer` is a 0-based index. The UI appends an "I don't know" choice that isn't in the JSON and is always graded wrong.
- Mastery per question is stored as integer permille `s` in [0, 1000]: 800 for a right first try, 0 for a first miss, 550 for the first correct after misses, +100 for each later correct, −200 for each miss, clamped after every step. Set and unit mastery is the mean over questions (unseen counts as 0). The tiers are ≥1, ≥50 and ≥85. The full rationale is in the comments at the top of `core.js`.
- SRS gaps are 1/4/14/45/120 days. A correct answer on a never-missed question jumps straight to the 14-day gap.
- Archived sets and units are self-contained snapshots, independent of the files on disk. Deleted questions stay in the files and keep their progress, so they can be restored.
- A broken unit or set folder is skipped and reported in the banner with its folder and file name. The rest of the bank still loads.

The full question-file format is in `questions/README.md`, and the in-app **Format** screen mirrors it. If you change the schema, update both, plus the root `README.md`, which documents user-visible behaviour in detail.

## Acceptance gate

`tools/acceptance.py` is a supervisor-owned gate, hash-locked by `tools/acceptance.sha256`. **Do not edit either file.** Its first check fails if the script's hash changes. It renders pages, hits the HTTP API and runs `./qt`, so it fails if you break the contracts it checks (for example: 10 questions per session by default, `.gitignore` keeping `progress/` out, set cards keeping Practice/Review/Archive). Briefs and logs for supervision rounds live in `.supervision/` (git-ignored).

## Conventions

- Every source file starts with an `SPDX-License-Identifier: MIT` / `Copyright (c) 2026 naromil` header.
- Commits use a conventional prefix like `feat(scope): …` or `docs(scope): …`.
