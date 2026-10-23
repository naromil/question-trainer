# Question data format

The trainer reads every question set from the `questions/` directory. There is
no build step and no database: a set is a **folder** of JSON files, and the app
fetches them when the page loads.

## The index

`questions/index.json` is the entry point. It is a JSON object with one key,
`sets`, holding an array of set folder names:

```json
{
  "sets": ["everyday-science", "world-geography", "photosynthesis"]
}
```

`sets` entries must be **folder names** relative to `questions/` — no slashes,
no `..`, no absolute paths. The app reads the folders in index order, so this is
the order the set list appears in. A folder may be listed only once.

The app deliberately does not scan the directory: adding a folder to `questions/`
does nothing until its name is listed in `index.json`. This keeps the order of
the set list explicit and lets a set be temporarily hidden without deleting its
files.

## One folder per set

A set folder holds its own `index.json` plus one or more unit files:

```
questions/photosynthesis/
  index.json              the set: id, title, description, unit list
  light-reactions.json    a unit: id, title, questions
  calvin-c4-cam.json      another unit
```

The set folder index:

```json
{
  "id": "photosynthesis",
  "title": "Photosynthesis (SBI4U Unit 2)",
  "description": "Light reactions, the Calvin cycle, C4/CAM, and how photosynthesis compares with respiration.",
  "units": ["light-reactions.json", "calvin-c4-cam.json"]
}
```

`units` entries must be **bare file names** in that same folder, in display order,
with no duplicates. `id` defaults to the folder name when it is omitted.

Each unit file has the shape a whole set used to have:

```json
{
  "id": "light-reactions",
  "title": "Light reactions & pigments",
  "description": "Optional one-line description of the unit.",
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
        "Canberra is the capital of Australia.",
        "Melbourne is a large city, but it is not the capital.",
        "Perth is the capital of Western Australia, not of the country."
      ]
    }
  ]
}
```

A set with one unit still uses a folder: one `index.json` listing a single unit
file. Its card is a plain long row; a set with several units shows them on the
right of its card, each with its own practice, review and archive.

## Set folder fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | no | Stable identifier, unique across all sets. Defaults to the folder name. Progress, mastery, archive entries and local copies are keyed by it. |
| `title` | string | yes | Name shown on the set card. |
| `description` | string | no | One-line description under the title. Defaults to empty. |
| `units` | array of strings | yes | Non-empty list of bare unit file names in this folder, in display order. |

## Unit fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable identifier, unique within the set. A unit session is `?set=<set>&unit=<id>`. |
| `title` | string | yes | Name shown on the unit row. |
| `description` | string | no | One-line description. Defaults to empty. |
| `questions` | array | yes | Non-empty array of question objects. |

## Question fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable, non-empty identifier, unique **across all units of the set**. Progress is keyed by set id plus question id. |
| `question` | string | yes | The question stem. |
| `choices` | array of strings | yes | At least two non-empty choices. Labels A, B, C … are generated from the order. |
| `answer` | integer | yes | **0-based** index of the correct choice. `0` is the first choice, `1` the second, and so on. |
| `passage` | string | no | Context shown above the stem. Blank lines separate paragraphs; lines starting with a bullet become list items. |
| `image` | string | no | Image shown between the passage and the stem. A bare path is relative to the `questions/` directory; an absolute URL or a `data:` URI also works. |
| `imageAlt` | string | no | Text alternative for the image. Recommended whenever `image` is set; without it the image has no accessible name. |
| `imageCaption` | string | no | Visible caption shown under the image. |
| `explanation` | string | no | Overall explanation shown after the answer is checked. |
| `explanations` | array | no | One entry per choice, in the same order as `choices`. Each entry is a string or `null`; `null` and empty strings render nothing under that choice. |

All strings are trimmed when the files are loaded. Empty optional strings are
treated as absent.

## Images

Keep image files under `questions/` (for example `questions/images/`) and
reference them with a path relative to that directory:

```json
"image": "images/australia-map.png",
"imageAlt": "Map of Australia with Canberra marked.",
"imageCaption": "Canberra is the capital, in the Australian Capital Territory."
```

The path is resolved against `questions/`, **not** against the unit file, so the
same string works in every set folder and for archived copies restored later.
An absolute `https://` URL, a `data:` URI or a root-relative `/path` also works.
The image is not fetched or checked while loading the JSON: a missing file
renders an “Image could not be loaded.” line inside that one question, and the
rest of the set still works. `imageAlt` is the text alternative for screen
readers; `imageCaption` is visible to everyone.

## ID stability

Progress — attempts, first-try flags, spaced-review boxes, mastery points and
archived snapshots — is stored against `set id / question id`, never against a
unit, a file name or a position in an array. That means:

* Rewording a question, editing a choice, fixing an explanation or reordering
  the `questions` array keeps the existing progress.
* **Moving a question between units of the same set keeps its progress**, because
  the set id did not change. Splitting one big unit into two is free.
* Changing a question's `id` makes it a new question. The old record remains in
  the saved state but is never shown again.
* Moving a question to a different **set** does not move its progress, because the
  set id is part of the key.
* Changing a set's `id` (in its folder `index.json`) makes it a new set: mastery
  and review history stay with the old id. Keep ids stable when editing content.

The same question id may be used in two different sets; the two records are
independent. Set ids must be unique across the bank, unit ids within their set,
and question ids within their set.

Mastery is a per-set total. A unit row reports that unit's own coverage (answered
of total), first-try accuracy and due count; the units add up to the set's
numbers.

## Validation and errors

The loader applies the same rules as `app/core.js`:

* the index must be an object whose `sets` value is an array of folder names;
* a set folder index needs a non-empty `title` and a non-empty `units` array of
  bare file names, without duplicates;
* a unit needs non-empty `id`, `title` and `questions`;
* a question needs non-empty `id` and `question`, at least two non-empty
  choices, and an integer `answer` in `[0, choices.length)`;
* `explanations`, when present, must contain exactly one string-or-null entry
  per choice;
* ids must be unique: unit ids and question ids within their set, set ids across
  the whole bank.

A unit that cannot be fetched, parsed or normalised is dropped and its problem
appears in the banner at the top of the app **with its folder and file name**. The
other units of that set still load. A set folder whose own `index.json` is
missing or invalid is dropped as a whole, also with a banner message naming the
folder. A folder listed in the index but absent on disk produces a banner error,
and the rest of the bank still loads.

## Add a set

1. Create `questions/my-topic/` and put the unit files in it, using the unit
   example above. Pick a set `id` that you will keep (for example `my-topic`) and
   give every question a stable id.
2. Write `questions/my-topic/index.json` with the set `id`, `title`, optional
   `description`, and the file names in `units`.
3. Add `"my-topic"` to the `sets` array in `questions/index.json`.
4. Reload the page (or restart `./qt`). The new card appears on the Sets page.

To add a unit to an existing set, drop the file into its folder and add the file
name to that folder's `units` array. The existing units keep their progress, and a
set that had one unit starts showing the units panel on its card.

To remove a set from the list, remove its folder name from `index.json`; the
folder can stay on disk. Deleting the folder without editing the index produces a
banner error, and the rest of the bank still loads.

## Archived sets, archived units and local copies

Archiving a set stores a snapshot of all its units and a browser-local copy of its
progress. Archiving a single unit stores just that unit and hides it from its set;
the set stays active and its other units keep working. Archiving the whole set
absorbs any unit archives it already had, so restoring the set brings every unit
back at once.

Snapshots are independent of the JSON files: removing a folder from `index.json`
(or deleting it) does **not** delete the archived copy or its history. Restoring a
set whose source folder is gone keeps the snapshot as a browser-local set, and
restoring a unit whose source file is gone keeps it in a browser-local copy of its
set, so a temporary data change cannot destroy progress. Use **Settings → Export
JSON** to back up everything, including archived sets and units.
