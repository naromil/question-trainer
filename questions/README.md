# Question data format

The trainer reads every question set from the `questions/` directory. There is
no build step and no database: a set is a JSON document, and the app fetches it
when the page loads.

## The index

`questions/index.json` is the entry point. It is a JSON object with one key,
`files`, holding an array of file names:

```json
{
  "files": ["everyday-science.json", "world-geography.json"]
}
```

`files` entries must be **bare file names** relative to `questions/` — no
directories, no `..`, no absolute paths. The app requests every listed file in
parallel and merges the sets in index order. A file may be listed only once.

The app deliberately does not scan the directory: adding a file to `questions/`
does nothing until its name is listed in `index.json`. This keeps the order of
the set list explicit and lets a set be temporarily hidden without deleting its
file.

## One file per set

Each listed file holds one set. The shipped files use the flat form:

```json
{
  "id": "example-set",
  "title": "Example Set",
  "description": "Optional one-line description.",
  "questions": [
    {
      "id": "q1",
      "passage": "Optional context shown above the question.",
      "image": "images/australia-map.png",
      "imageAlt": "Map of Australia with Canberra marked.",
      "imageCaption": "Optional caption under the image.",
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
```

A `{ "sets": [ ... ] }` wrapper containing one or more sets is also accepted by
the loader. The flat form is preferred because it keeps the filename and the
set id easy to match.

## Set fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable, non-empty identifier, unique across all files. Progress and archive entries are keyed by it. |
| `title` | string | yes | Name shown on the set card. |
| `description` | string | no | One-line description under the title. Defaults to empty. |
| `questions` | array | yes | Non-empty array of question objects. |

## Question fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable, non-empty identifier, unique within the set. Progress is keyed by set id plus question id. |
| `question` | string | yes | The question stem. |
| `choices` | array of strings | yes | At least two non-empty choices. Labels A, B, C … are generated from the order. |
| `answer` | integer | yes | **0-based** index of the correct choice. `0` is the first choice, `1` the second, and so on. |
| `passage` | string | no | Context shown above the stem. Blank lines separate paragraphs; lines starting with a bullet become list items. |
| `image` | string | no | Image shown between the passage and the stem. A bare path is relative to the `questions/` directory; an absolute URL or a `data:` URI also works. |
| `imageAlt` | string | no | Text alternative for the image. Recommended whenever `image` is set; without it the image has no accessible name. |
| `imageCaption` | string | no | Visible caption shown under the image. |
| `explanation` | string | no | Overall explanation shown after the answer is checked. |
| `explanations` | array | no | One entry per choice, in the same order as `choices`. Each entry is a string or `null`; `null` and empty strings render nothing under that choice. |

All strings are trimmed when the file is loaded. Empty optional strings are
treated as absent.

## Images

Keep image files under `questions/` (for example `questions/images/`) and
reference them with a path relative to that directory:

```json
"image": "images/australia-map.png",
"imageAlt": "Map of Australia with Canberra marked.",
"imageCaption": "Canberra is the capital, in the Australian Capital Territory."
```

The path is resolved against `questions/`, **not** against the set file, so the
same string works for every set and for archived copies restored later. An
absolute `https://` URL, a `data:` URI or a root-relative `/path` also works.
The image is not fetched or checked while loading the JSON: a missing file
renders an “Image could not be loaded.” line inside that one question, and the
rest of the set still works. `imageAlt` is the text alternative for screen
readers; `imageCaption` is visible to everyone.

## ID stability

Progress — attempts, first-try flags, spaced-review boxes, mastery points and
archived snapshots — is stored against `set id / question id`, never against a
position in the array. That means:

* Rewording a question, editing a choice, fixing an explanation or reordering
  the `questions` array keeps the existing progress.
* Changing a question's `id` makes it a new question. The old record remains in
  the saved state but is never shown again.
* Changing a set's `id` makes it a new set: mastery and review history stay with
  the old id. Keep ids stable when editing content.
* Moving a question to a different set does not move its progress, because the
  set id is part of the key.

The same question id may be used in two different sets; the two records are
independent. Set ids and question ids must not be duplicated within their own
scope.

## Validation and errors

The loader applies the same rules as `app/core.js`:

* the index must be an object whose `files` value is an array;
* every entry must be a bare file name;
* a set needs non-empty `id`, `title` and `questions`;
* a question needs non-empty `id` and `question`, at least two non-empty
  choices, and an integer `answer` in `[0, choices.length)`;
* `explanations`, when present, must contain exactly one string-or-null entry
  per choice;
* ids must be unique: question ids within a set, set ids across all files.

A file that cannot be fetched, parsed or normalised is skipped and its problem
appears in the banner at the top of the app **with the file name**. The other
files still load. A missing or duplicate set id is reported the same way. With
the wrapper form, one invalid set does not prevent the valid sets in that file
from loading; with the flat form the file is one set, so a validation failure
means that file contributes nothing.

## Add a set

1. Create `questions/my-topic.json` using the flat example above. Pick an `id`
   that you will keep, for example `my-topic`, and give every question a stable
   id.
2. Add `"my-topic.json"` to the `files` array in `questions/index.json`.
3. Reload the page (or restart `./qt`). The new card appears on the Sets page.

To remove a set from the list, remove its file name from `index.json`; the file
can stay on disk. Deleting the file without editing the index produces a banner
error, and the rest of the bank still loads.

## Archived sets and local copies

Archiving a set stores a snapshot of its questions and a browser-local copy of
its progress. That snapshot is independent of the JSON files: removing a file
from `index.json` (or deleting it) does **not** delete the archived copy or its
history. Restoring a set whose source file is gone keeps the archived copy as a
browser-local set, so a temporary data change cannot destroy progress. Use
**Settings → Export JSON** to back up everything, including archived sets.
