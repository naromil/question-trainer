# Question Trainer

A local-first, set-based multiple-choice trainer. Drop a question set — a folder of
unit files — into `questions/`, open the app, and practice one question set at a time,
whole or one unit at a time, with instant grading, per-choice explanations, mastery
tracking, spaced review, and an archive for sets and units you have finished.

No build step and no runtime dependencies: a static page plus one folder per set
under `questions/`.

## Run it

From the repository root:

```bash
./qt
```

`qt` starts the stdlib server, serves the repository at
`http://127.0.0.1:8765/app/`, and opens that URL in your browser. Progress is
written to `progress/progress.json` (git-ignored) as well as to `localStorage`,
so it survives a browser-data wipe and a server restart.

```bash
./qt --port 9000 --no-open          # another port; do not open a browser
./qt --host 0.0.0.0                 # listen on all interfaces
./qt --progress /tmp/qt-progress.json
```

`--progress` may be absolute, or relative to the repository root; the default is
`progress/progress.json`. `--host` defaults to `127.0.0.1` and `--port` to
`8765`. `python3 serve.py` accepts the same flags.

The server exits by itself after five minutes without requests; only incoming
requests reset that clock, so an idle browser tab does not keep it alive.
`--idle-timeout SECONDS` changes the limit (`0` keeps it running until Ctrl-C).

Running `./qt` again while the server is up starts nothing new: it prints the
running URL, opens that tab unless `--no-open` is given, and exits. It only does
this for a server it recognises as Question Trainer; if the port belongs to
another program, it says so and exits non-zero.

The page still works from a plain static server (for example
`python3 -m http.server 8765` with `http://127.0.0.1:8765/app/`) or when opened
from disk where the browser allows it. In that mode the progress API is not
available, so everything stays in `localStorage`; **Settings → Progress data**
says which mode is active.

Use **Settings → Export/Import JSON** to move progress between machines or
origins.

## What it does

| Screen | What you get |
|---|---|
| **Sets** (home) | One long card per active question set: mastery bar, tier, answered count, first-try accuracy, due count, and **Practice**, **Review**, **Archive** for the set. A set with several units also lists them on the right of its card, each unit with its own **Practice**, **Review** and **Archive**. There is no mixed practice. |
| **Session** | One set, or one unit of it. One question at a time with a progress rail, live mastery and streak chips, and an answering-time clock that pauses while you read feedback and while the tab is hidden. Choose with the mouse or <kbd>A</kbd>–<kbd>Z</kbd>/<kbd>1</kbd>–<kbd>9</kbd>, <kbd>Enter</kbd> to check and again for the next question. Choices can be crossed out (and un-crossed) before answering. The question and its choices glide in; selecting a choice pops its letter, and grading marks the right row with a tick and a wrong pick with a cross. A right answer pays off on several channels at once — the stage glows green (amber while a streak runs), the card pulses, sparks burst from the tick, and both mastery totals count up — with a chord that lands an octave higher for a first-time correct and gains a note every few of a run. A miss tints the stage red, shakes the card and plays a low two-tone. Sound follows the setting; animation follows `prefers-reduced-motion`. |
| **Results** | An animated score ring, mastery delta, question-by-question log, full explanations for misses, and **Retry the missed questions** (inside the same unit when the session was unit-scoped). A strong score adds confetti and a rising chord. |
| **Archive** | Sets and single units you archived, with their progress and a saved copy of their questions. **Restore** puts a set or unit back on the active list. If the source is no longer listed in `questions/index.json`, the saved copy is kept as a browser-local set. |
| **Progress** | Answers, first-try accuracy, questions seen, sets mastered, day streak, due count for active sets, a 14-day activity chart, a per-set table with a **Reset** action, and repeated trouble spots. |
| **Settings** | Session length (10 by default), the practice-all switch for sets of 30 or fewer questions, theme, answer sounds, export/import/reset, and where progress is saved. |
| **Format** | The in-app schema summary with an example; the full reference is [questions/README.md](questions/README.md). |

### Mastery

A 0–100 point total per set.

* first-time correct **+12**, correct repeat **+5**, miss **−8** — floored at 0, capped at 100;
* tiers: **Familiar** ≥ 1, **Proficient** ≥ 50, **Mastered** ≥ 85.

### Spaced review

Leitner boxes. A correct answer promotes a question one box; a miss sends it back to box 0
and makes it due immediately. Gaps between reviews: **1, 3, 7, 21** days.

* **Practice** walks the whole set least-seen-first.
* **Review** serves only questions that are due (so it can be shorter than the session
  length, and says so when nothing is due).
* Due counters count active sets only. Archived sets keep their review dates and show
  them in the Archive, but do not add to the due totals until restored.
* Archiving a set never deletes its progress.
* **Reset** on the Progress screen forgets one set's per-question history, mastery and
  review dates; the 14-day activity chart and all-time totals keep their history.

## Question data

`questions/index.json` lists the set folders by name:

```json
{ "sets": ["everyday-science", "photosynthesis"] }
```

Each folder has its own `index.json` naming the set and its unit files:

```json
{ "id": "photosynthesis", "title": "Photosynthesis", "description": "…",
  "units": ["light-reactions.json", "calvin-c4-cam.json"] }
```

Each unit file has `id`, `title`, optional `description`, and a non-empty
`questions` array; each question has `id`, `question`, two or more `choices`, and
`answer` as the **0-based index** of the correct choice. `passage`, `image` (with
optional `imageAlt` and `imageCaption`), `explanation` and per-choice
`explanations` are optional. Bare image paths are resolved against `questions/`,
so the files can live in `questions/images/`. A set with one unit needs a single
unit file and looks like a plain long card; a set with several units shows them on
the right of its card.

Ids are stable keys: progress is stored by set id plus question id, so renaming an
id starts that item over, and question ids must be unique across all units of one
set. A broken unit is reported in the banner with its folder and file name and
skipped; the rest of the set still loads. The complete field reference, validation
rules and an "add a set" recipe are in [questions/README.md](questions/README.md);
the in-app **Format** screen shows a compact version.

## Layout

```
app/index.html          shell
app/styles.css          light/dark theme
app/core.js             pure logic: JSON validation, sets and units, grading,
                        mastery, SRS, session selection, archive/restore, stats
app/app.js              routing, rendering, localStorage + disk mirror
questions/index.json    list of set folders the app loads
questions/<set>/        one folder per set: index.json + its unit files
questions/README.md     complete question-data format reference
serve.py                stdlib static server + disk progress API
qt                      one-command launcher for serve.py
tools/test_core.js      node --test suite for core.js and the sample data
LICENSE                 MIT licence
```

`progress/` is created on demand, git-ignored, and holds `progress.json` unless
`--progress` says otherwise.

## Tests

```bash
node --test tools/test_core.js
```

## Copyright

Copyright © 2026 naromil. The original code, styles, tooling and documentation in this
repository are released under the [MIT Licence](LICENSE). Question content you put in
`questions/` is yours to manage.
