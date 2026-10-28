# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Confirm before Import JSON replaces progress — today an import silently overwrites all history, mastery and archives with no prompt.
- [ ] Reset the import file input and report read failures — picking the same file twice fires no change event, and a failed `file.text()` is swallowed.
- [ ] Keyboard shortcut to cross out a choice (e.g. Shift+letter) — today it needs the mouse or tabbing to each cross-out button.
- [ ] "End session" button that shows Results for the questions answered so far — users expect to stop early without losing the summary.
- [ ] Per-route `document.title` (e.g. "Practice · <set> — Question Trainer") — tabs, history and screen readers all show the same title today.
- [ ] Move progress-import validation into `core.js` with node tests — the check lives untested in `app.js`.
- [ ] Date-stamp the exported progress file name — repeated exports all download as `question-trainer-progress.json`.
- [ ] Run the bank-shape and serving tests against a tracked fixture when `questions/` is absent — a fresh clone fails `test_core.js` and `test_server.py` only for lack of local data.
- [ ] Optional per-session shuffle of choice order — touches letter shortcuts, per-choice explanations and the stored in-flight session.
- [ ] fix: wrong padding for "All sets are archived": <img width="1016" height="705" alt="image" src="https://github.com/user-attachments/assets/8d273f15-d1a6-46ee-bc6c-e56910ebacba" />


## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Merge an imported progress file with the current one (via `mergeStates`) instead of replacing it — changes what Import means for existing users.
- [ ] Search across every set's questions from the Sets screen — a new screen/flow beyond the per-set Browse filter.

## Ideas for the owner to consider (never built automatically)

- Timed exam mode: no feedback until the end, with a time limit.
- Markdown/math rendering in stems and explanations.
- Installable offline app (service worker / web manifest) within the strict CSP.
- Daily goal and review reminders.
- Personal notes attached to a question.

## Rejected (Claude won't re-propose these)

- [ ] Flag/star questions and practice only flagged ones — adds a field to the progress format.
    - Not needed for current usage preference. The question set is customized, and questions not worth a star should just be removed.
- More question types (multi-select, true/false) — a question-format change.
    - Multiple choice is enough for the purpose of reviewing.
- In-app question-set editor or CSV import.
    - Users ask their agents to edit the question-set directly.
