# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [x] Optional per-session shuffle of choice order — touches letter shortcuts, per-choice explanations and the stored in-flight session.
- Markdown/math rendering in stems and explanations.
- [x] Search across every set's questions from the Sets screen — a new screen/flow beyond the per-set Browse filter.
- [ ] Personal notes attached to a question. - And can be edited conveniently during practice sessions.
- [x] Keyboard shortcuts on the Results screen (<kbd>R</kbd> retry the missed questions, <kbd>P</kbd> practice again) and list them in the <kbd>?</kbd> dialog — a keyboard-only session ends on a screen whose actions are mouse/Tab-only.
- [x] Test that `serve.py` exits after `--idle-timeout` with no requests and stays up while requests arrive — the idle watchdog has no test in `test_server.py` or the acceptance gate.

## Proposed (needs the owner's OK — move to Routine to approve)

## Ideas for the owner to consider (never built automatically)

- Installable offline app (service worker / web manifest) within the strict CSP.
- Review everything due across all sets in one session — reverses the deliberate "no mixed practice" design, so it is the owner's call.

## Rejected (Claude won't re-propose these)

- [ ] Flag/star questions and practice only flagged ones — adds a field to the progress format.
    - Not needed for current usage preference. The question set is customized, and questions not worth a star should just be removed.
- More question types (multi-select, true/false) — a question-format change.
    - Multiple choice is enough for the purpose of reviewing.
- In-app question-set editor or CSV import.
    - Users ask their agents to edit the question-set directly.
- Timed exam mode: no feedback until the end, with a time limit.
- Daily goal and review reminders.
