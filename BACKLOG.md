# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- Markdown/math rendering in stems and explanations.
- [ ] Personal notes attached to a question. - And can be edited conveniently during practice sessions.
- [x] Each row of the Results "Question by question" log links to that question in Browse — today a miss can only be re-read in the session-local review card, not opened with its record and explanations.
- [ ] Show the unit tag on each question during a whole-set session of a multi-unit set — the unit is only shown when the session itself is unit-scoped, so you can't tell where a question comes from.
- [ ] Review forecast on the Progress screen: how many questions fall due on each of the next 7 days — a standard SRS view; pure counting in `core.js` from existing `due` dates.
- [ ] Keep the Sets screen's filter text and sort choice in the address, like Search does — a reload or Back from a set resets them to empty and Index order.
- [ ] Print stylesheet (`@media print`) for Browse and Results — hides nav, buttons and animations so a set or a session's misses print as a clean study sheet.
- [ ] Unit tests for `dueQuestions` (unanswered and not-yet-due excluded) and `recentDayKeys` (14 distinct days across a DST change) — both drive the Review and Progress screens but have no direct test.

## Proposed (needs the owner's OK — move to Routine to approve)

- Undo the last answer during a session (restore the question's previous record) — rewrites stored progress and grading counters, so it touches the data-model invariants.
- Custom session length beyond the fixed 5–50 choices — changes settings validation in the progress format and the 10-question default the acceptance gate checks.

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
