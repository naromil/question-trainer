# Question Trainer

A local-first, set-based multiple-choice trainer. Drop a fixed-format JSON file into
`questions/`, open the app, and practice one question set at a time — with instant
grading, per-choice explanations, mastery tracking, spaced review, and an archive for
sets you have finished.

No build step, no dependencies, no server-side code: a static page plus
`questions/sets.json`.

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
| **Sets** (home) | One card per active question set: mastery bar, tier, answered count, first-try accuracy and due count. Buttons: **Practice**, **Review**, **Archive**. There is no mixed practice. |
| **Session** | One set only. One question at a time with progress dots and an answering-time clock that pauses while you read feedback. Choose with the mouse or <kbd>A</kbd>–<kbd>Z</kbd>/<kbd>1</kbd>–<kbd>9</kbd>, <kbd>Enter</kbd> to check and again for the next question. Choices can be crossed out (and un-crossed) before answering. |
| **Results** | Score, mastery delta, question-by-question log, full explanations for misses, and **Retry the missed questions**. |
| **Archive** | Sets you archived, with their progress and a saved copy of their questions. **Restore** puts a set back on the active list. If the set is no longer in `questions/sets.json`, the saved copy is kept as a browser-local set. |
| **Progress** | Answers, first-try accuracy, questions seen, sets mastered, day streak, due count, a 14-day activity chart, a per-set table, and repeated trouble spots. |
| **Settings** | Session length, theme, answer sounds, export/import/reset. |
| **Format** | The complete `questions/sets.json` schema with an example. |

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

`questions/sets.json` is read at startup:

```json
{
  "sets": [
    {
      "id": "example-set",
      "title": "Example Set",
      "description": "Optional one-line description.",
      "questions": [
        {
          "id": "q1",
          "passage": "Optional context or passage.",
          "question": "What is the capital of Australia?",
          "choices": ["Sydney", "Canberra", "Melbourne", "Perth"],
          "answer": 1,
          "explanation": "Canberra is the capital of Australia.",
          "explanations": [
            "Sydney is the largest city, but it is not the capital.",
            "Correct. Canberra is the capital.",
            "Melbourne is a large city, but it is not the capital.",
            "Perth is the capital of Western Australia, not of the country."
          ]
        }
      ]
    }
  ]
}
```

* `answer` is the **0-based index** of the correct choice.
* `id` values must be stable: progress is keyed by set id plus question id.
* `passage`, `explanation` and `explanations` are optional. `explanations`, when present,
  has one entry per choice (string or `null`).
* A malformed set is reported in the UI and skipped; the rest of the file still loads.
* The sample file in this repository demonstrates every field. The **Format** screen
  documents the same schema in the app.

## Layout

```
app/index.html          shell
app/styles.css          light/dark theme
app/core.js             pure logic: JSON validation, grading, mastery, SRS,
                        session selection, archive/restore, stats
app/app.js               routing, rendering, localStorage
questions/sets.json     fixed-format question sets
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
`questions/sets.json` is yours to manage.
