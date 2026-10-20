# Question Trainer

A local-first, set-based multiple-choice trainer. Drop a fixed-format JSON file into
`questions/`, open the app, and practice one question set at a time — with instant
grading, per-choice explanations, mastery tracking, spaced review, and an archive for
sets you have finished.

No build step and no runtime dependencies: a static page plus one JSON file per
set under `questions/`.

## Run it

The app fetches its question file, so serve the repository root over HTTP rather than
opening the HTML from disk:

```bash
python3 -m http.server 8765
# then open http://127.0.0.1:8765/app/
```

Progress and archived sets live in `localStorage`, so pick one origin and stay on it.
Use **Settings → Export/Import JSON** to move progress between machines or origins.

## What it does

| Screen | What you get |
|---|---|
| **Sets** (home) | One card per active question set: mastery bar, tier, answered count, first-try accuracy and due count. Click a card to start practising the set; the due badge opens spaced review for what is due, and **Archive** stays a separate button. There is no mixed practice. |
| **Session** | One set only. One question at a time with progress dots and an answering-time clock that pauses while you read feedback. Choose with the mouse or <kbd>A</kbd>–<kbd>Z</kbd>/<kbd>1</kbd>–<kbd>9</kbd>, <kbd>Enter</kbd> to check and again for the next question. Choices can be crossed out (and un-crossed) before answering. |
| **Results** | Score, mastery delta, question-by-question log, full explanations for misses, and **Retry the missed questions**. |
| **Archive** | Sets you archived, with their progress and a saved copy of their questions. **Restore** puts a set back on the active list. If the set is no longer listed in `questions/index.json`, the saved copy is kept as a browser-local set. |
| **Progress** | Answers, first-try accuracy, questions seen, sets mastered, day streak, due count, a 14-day activity chart, a per-set table, and repeated trouble spots. |
| **Settings** | Session length, theme, answer sounds, export/import/reset. |
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
* Archiving a set never deletes its progress.

## Question data

`questions/index.json` lists the set files by bare name:

```json
{ "files": ["everyday-science.json", "world-geography.json"] }
```

Each listed file holds one set, either as a flat object or inside a
`{ "sets": [...] }` wrapper. A set has `id`, `title`, optional `description`, and a
non-empty `questions` array; each question has `id`, `question`, two or more
`choices`, and `answer` as the **0-based index** of the correct choice.
`passage`, `explanation` and per-choice `explanations` are optional.

Ids are stable keys: progress is stored by set id plus question id, so renaming an
id starts that item over. A broken file is reported in the banner with its file
name and skipped; the rest still load. The complete field reference, validation
rules and an "add a set" recipe are in [questions/README.md](questions/README.md);
the in-app **Format** screen shows a compact version.

## Layout

```
app/index.html          shell
app/styles.css          light/dark theme
app/core.js             pure logic: JSON validation, grading, mastery, SRS,
                        session selection, archive/restore, stats
app/app.js              routing, rendering, localStorage
questions/index.json    list of set files the app loads
questions/*.json        one set per file
questions/README.md     complete question-data format reference
tools/test_core.js      node --test suite for core.js and the sample data
LICENSE                 MIT licence
```

## Tests

```bash
node --test tools/test_core.js
```

## Copyright

Copyright © 2026 naromil. The original code, styles, tooling and documentation in this
repository are released under the [MIT Licence](LICENSE). Question content you put in
`questions/*.json` is yours to manage.
