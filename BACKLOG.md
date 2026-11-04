# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [x] fix: wrong padding for "All sets are archived": <img width="1016" height="705" alt="image" src="https://github.com/user-attachments/assets/8d273f15-d1a6-46ee-bc6c-e56910ebacba" />
- [ ] Undo button on the "Question deleted" note in a session — the Delete key is easy to hit by accident and recovery today means a trip to the Archive.
- [ ] Show when the next review falls due on the "Nothing is due for review" screen — its copy says "within a day or two", which is wrong since never-missed questions wait 14+ days.
- [ ] Run the bank-shape and serving tests against a tracked fixture when `questions/` is absent — a fresh clone fails `test_core.js` and `test_server.py` only for lack of local data.
- [ ] Optional per-session shuffle of choice order — touches letter shortcuts, per-choice explanations and the stored in-flight session.
- [ ] Press <kbd>/</kbd> to focus the filter box on Sets and Browse — the usual search shortcut; the filters are mouse/Tab-only today.
- [ ] Forced-colors (Windows high contrast) styles for selected, crossed-out, right and wrong choices — those states rely on colour and opacity that forced-colors mode strips.
- [ ] <kbd>M</kbd> toggles answer sounds during a session — muting today means leaving the session for Settings.


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
