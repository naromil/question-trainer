/* Tests for the trainer's logic and generated data.  Run:  node tools/test_core.js
 *
 * Only the things a user could plausibly notice go in here: grading, mastery,
 * the review schedule, session selection, state import robustness, and the
 * integrity of the generated question file.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../app/core.js');
const DATA = require('../app/data/questions.js');

const DAY = C.DAY_MS;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function question(overrides) {
  return Object.assign({
    id: 'q1',
    skill: 'Words in Context',
    domain: 'Craft and Structure',
    set: 'Words in Context 2',
    number: '1.1',
    stimulus: 'text',
    stem: 'stem',
    choices: ['one', 'two', 'three', 'four'],
    answer: 'B',
    analysis: '',
    flags: []
  }, overrides);
}

/* ------------------------------------------------------------- the data */

test('generated data: every item is complete and gradeable', () => {
  assert.equal(DATA.meta.difficulty, 'Hard');
  assert.equal(DATA.meta.count, DATA.questions.length);
  assert.ok(DATA.questions.length > 200, 'expected the hard tier to be sizeable');

  const ids = new Set();
  for (const q of DATA.questions) {
    assert.ok(!ids.has(q.id), `duplicate id ${q.id}`);
    ids.add(q.id);
    assert.equal(q.choices.length, 4, `${q.id} choices`);
    assert.ok('ABCD'.includes(q.answer), `${q.id} answer`);
    assert.ok(q.stimulus.trim() && q.stem.trim(), `${q.id} text`);
    assert.ok(q.analysis.trim(), `${q.id} rationale`);
    assert.ok(DATA.meta.domains.includes(q.domain), `${q.id} domain`);
    assert.ok(!/^[-–—]/.test(q.set), `${q.id} set name ${q.set}`);
    assert.ok(!/Text\d/.test(q.stimulus), `${q.id} un-normalised text label`);
  }
  assert.equal(
    DATA.meta.skills.reduce((sum, s) => sum + s.count, 0),
    DATA.questions.length,
    'skill counts must add up'
  );
});

test('generated data: every rationale parses per choice, matching the key', () => {
  for (const q of DATA.questions) {
    const parsed = C.parseRationale(q.analysis, q.answer);
    assert.equal(parsed.parsed, true, `${q.id} rationale not parsed`);
    assert.equal(parsed.best, q.answer, `${q.id} best answer mismatch`);
    assert.ok(parsed.bestText.length > 10, `${q.id} best text`);
    assert.equal(Object.keys(parsed.wrong).length, 3, `${q.id} wrong-choice count`);
    assert.equal(C.rationaleFor(parsed, q.answer), parsed.bestText);
    assert.ok(!parsed.wrong[q.answer], `${q.id} best choice also marked incorrect`);
  }
});

/* ---------------------------------------------------------------- grading */

test('applyAnswer: first-try correct earns full mastery and schedules review', () => {
  const state = C.emptyState(NOW);
  const q = question({ id: 'a' });
  const result = C.applyAnswer(state, q, 1, NOW); // 'B'

  assert.equal(result.correct, true);
  assert.equal(result.pointsDelta, C.MASTERY.firstCorrect);
  assert.equal(state.skills[q.skill].points, C.MASTERY.firstCorrect);
  assert.equal(result.boxAfter, 1);
  assert.equal(state.q.a.due, NOW + 1 * DAY);
  assert.deepEqual(state.q.a, { a: 1, c: 1, box: 1, due: NOW + DAY, last: NOW });
  assert.deepEqual(C.activity(state, 1, NOW)[0], {
    date: C.dayKey(NOW), a: 1, c: 1
  });
});

test('applyAnswer: a correct repeat is worth less than the first time', () => {
  const state = C.emptyState(NOW);
  const q = question({ id: 'a', answer: 'B' });
  C.applyAnswer(state, q, 1, NOW);
  const second = C.applyAnswer(state, q, 1, NOW);
  assert.equal(second.coin, 'repeat');
  assert.equal(second.pointsDelta, C.MASTERY.repeatCorrect);
  assert.equal(state.skills[q.skill].points, 12 + 5);
});

test('applyAnswer: a miss costs mastery and makes the item due immediately', () => {
  const state = C.emptyState(NOW);
  const q = question({ id: 'a', answer: 'B' });
  C.applyAnswer(state, q, 1, NOW);
  const miss = C.applyAnswer(state, q, 0, NOW + DAY);
  assert.equal(miss.correct, false);
  assert.equal(miss.pointsDelta, C.MASTERY.wrong);
  assert.equal(miss.boxAfter, 0);
  assert.ok(state.q.a.due <= NOW + DAY, 'missed question is due now');
  assert.equal(state.skills[q.skill].points, 12 - 8);
  assert.equal(state.skills[q.skill].streak, 0);
  assert.deepEqual(C.dueQuestions(state, [q], NOW + DAY).map((x) => x.id), ['a']);
});

test('SRS: correct answers walk box 1 -> 2 -> 3 -> 4 and then hold', () => {
  const state = C.emptyState(NOW);
  const q = question({ id: 'a' });
  const gaps = [];
  let at = NOW;
  for (let i = 0; i < 5; i++) {
    const result = C.applyAnswer(state, q, 1, at);
    gaps.push(result.boxAfter);
    at = state.q.a.due;
  }
  assert.deepEqual(gaps, [1, 2, 3, 4, 4]);
  assert.equal(at, NOW + (1 + 3 + 7 + 21 + 21) * DAY);
});

test('mastery is capped at 100 and floored at 0', () => {
  const state = C.emptyState(NOW);
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(question({ id: 'q' + i }));
  pool.forEach((q) => C.applyAnswer(state, q, 1, NOW));
  assert.equal(state.skills['Words in Context'].points, 100, '10 first-tries saturates');
  for (let i = 0; i < 20; i++) C.applyAnswer(state, pool[0], 0, NOW);
  assert.equal(state.skills['Words in Context'].points, 0, 'mistakes cannot go negative');
});

test('tierOf: tiers follow the point thresholds', () => {
  assert.equal(C.tierOf(0, 0).key, 'new');
  assert.equal(C.tierOf(0, 3).key, 'new');
  assert.equal(C.tierOf(1, 1).key, 'familiar');
  assert.equal(C.tierOf(49, 5).key, 'familiar');
  assert.equal(C.tierOf(50, 5).key, 'proficient');
  assert.equal(C.tierOf(84, 5).key, 'proficient');
  assert.equal(C.tierOf(85, 5).key, 'mastered');
});

/* -------------------------------------------------------- rationale parse */

test('parseRationale: keeps working when the phrasing is unexpected', () => {
  const parsed = C.parseRationale('The answer is B because of reasons.', 'B');
  assert.equal(parsed.parsed, false);
  assert.equal(parsed.raw, 'The answer is B because of reasons.');
  assert.equal(C.rationaleFor(parsed, 'B'), '');
});

/* ---------------------------------------------------------- session pick */

test('selectSession: practice hands out unseen questions first', () => {
  const pool = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    question({ id: 'q' + n, skill: 'Words in Context' }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, pool[0], 1, NOW);
  C.applyAnswer(state, pool[1], 0, NOW);

  const picked = C.selectSession(state, pool, {
    skill: 'Words in Context', mode: 'practice', length: 3,
    rng: seqRng([0.5, 0.4, 0.3, 0.2, 0.1])
  });
  assert.equal(picked.length, 3);
  for (const q of picked) {
    assert.notEqual(q.id, 'q1');
    assert.notEqual(q.id, 'q2');
  }
});

test('selectSession: only the requested skill, and filters are honoured', () => {
  const pool = [
    question({ id: 'keep', skill: 'Transitions' }),
    question({ id: 'other', skill: 'Boundaries' }),
    question({ id: 'fig', skill: 'Transitions', flags: ['figure'] }),
    question({ id: 'risky', skill: 'Transitions', flags: ['low-confidence'] }),
    question({ id: 'dash', skill: 'Transitions', flags: ['underline'] })
  ];
  const state = C.emptyState(NOW);
  const ids = (opts) => C.selectSession(state, pool, Object.assign({
    skill: 'Transitions', mode: 'practice', length: 10, rng: () => 0
  }, opts)).map((q) => q.id);

  assert.deepEqual(ids({}), ['keep', 'fig', 'risky', 'dash']);
  assert.deepEqual(ids({ filters: { excludeFigure: true } }), ['keep', 'risky', 'dash']);
  assert.deepEqual(ids({ filters: { excludeUnderline: true } }), ['keep', 'fig', 'risky']);
  assert.deepEqual(ids({ filters: { excludeRisky: true } }), ['keep', 'fig', 'dash']);
  assert.deepEqual(ids({ filters: { excludeFigure: true, excludeRisky: true, excludeUnderline: true } }),
    ['keep']);
});

test('selectSession: review serves exactly the due questions, oldest first', () => {
  const pool = [1, 2, 3].map((n) => question({ id: 'q' + n }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, pool[0], 1, NOW);           // due in 1 day
  C.applyAnswer(state, pool[1], 0, NOW - DAY);     // lapsed, due immediately

  const later = NOW + 2 * DAY;
  const picked = C.selectSession(state, pool, {
    skill: 'Words in Context', mode: 'review', length: 10, now: later, rng: () => 0
  });
  assert.deepEqual(picked.map((q) => q.id), ['q2', 'q1'], 'lapsed before merely due');
  assert.equal(picked.length, 2, 'unseen questions are not padded in');

  assert.deepEqual(C.selectSession(state, pool, {
    skill: 'Words in Context', mode: 'review', length: 10, now: NOW, rng: () => 0
  }).map((q) => q.id), ['q2'], 'the lapsed question is already due');
});

test('selectSession: never repeats an excluded id and never overruns', () => {
  const pool = [1, 2, 3].map((n) => question({ id: 'q' + n }));
  const state = C.emptyState(NOW);
  const picked = C.selectSession(state, pool, {
    skill: 'Words in Context', mode: 'practice', length: 2,
    exclude: ['q1'], rng: () => 0
  });
  assert.deepEqual(picked.map((q) => q.id), ['q2', 'q3']);
  assert.equal(C.selectSession(state, pool, {
    skill: 'Words in Context', mode: 'practice', length: 2, exclude: ['q1', 'q2', 'q3']
  }).length, 0);
});

test('selectSession: mixed mode is deterministic under a seeded rng', () => {
  const pool = [1, 2, 3, 4, 5, 6].map((n) =>
    question({ id: 'q' + n, skill: n % 2 ? 'Transitions' : 'Boundaries' }));
  const state = C.emptyState(NOW);
  const opts = { skill: null, mode: 'practice', length: 4, rng: seqRng([0.1, 0.9, 0.3, 0.7, 0.2, 0.5]) };
  const first = C.selectSession(state, pool, opts).map((q) => q.id);
  const second = C.selectSession(state, pool, opts).map((q) => q.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 4);
});

/* -------------------------------------------------------- state handling */

test('sanitizeState: junk imports become a usable empty state', () => {
  for (const junk of [null, undefined, 42, 'nope', [], { q: 'x', skills: 3 }]) {
    const state = C.sanitizeState(junk, NOW);
    assert.equal(state.totals.a, 0);
    assert.deepEqual(state.q, {});
    assert.equal(state.settings.length, 4);
  }
});

test('sanitizeState: clamps nonsense records instead of trusting them', () => {
  const state = C.sanitizeState({
    q: {
      good: { a: 3, c: 2, box: 2, due: NOW, last: NOW - DAY },
      tooManyCorrect: { a: 1, c: 9 },
      boxOutOfRange: { a: 1, c: 1, box: 99 },
      neverAnswered: { a: 0, c: 0 },
      garbage: 'no'
    },
    skills: { 'Words in Context': { points: 780, a: -4 } },
    days: { '2026-09-29': { a: 2, c: 5 }, '2026-09-28': { a: 0 } },
    settings: { length: 7, theme: 'neon' },
    totals: { a: 1, c: 4, sessions: -2 }
  }, NOW);

  assert.deepEqual(Object.keys(state.q).sort(), ['boxOutOfRange', 'good', 'tooManyCorrect']);
  assert.equal(state.q.tooManyCorrect.c, 1);
  assert.equal(state.q.boxOutOfRange.box, C.SRS_LAST_BOX);
  assert.equal(state.skills['Words in Context'].points, 100);
  assert.equal(state.skills['Words in Context'].a, 0);
  assert.deepEqual(state.days, { '2026-09-29': { a: 2, c: 2 } });
  assert.equal(state.settings.length, 4);
  assert.equal(state.settings.theme, 'auto');
  assert.equal(state.totals.c, 1);
  assert.equal(state.totals.sessions, 0);
});

test('streak: counts back from today, tolerating an untouched today', () => {
  const state = C.emptyState(NOW);
  assert.equal(C.streak(state, NOW), 0);
  for (const back of [2, 1]) {
    state.days[C.dayKey(NOW - back * DAY)] = { a: 2, c: 1 };
  }
  assert.equal(C.streak(state, NOW), 2, 'yesterday and the day before');
  state.days[C.dayKey(NOW)] = { a: 1, c: 1 };
  assert.equal(C.streak(state, NOW), 3);
  state.days[C.dayKey(NOW - 4 * DAY)] = { a: 1, c: 0 };
  assert.equal(C.streak(state, NOW), 3, 'the count stops at the first gap');
  state.days[C.dayKey(NOW - 3 * DAY)] = { a: 1, c: 0 };
  assert.equal(C.streak(state, NOW), 5, 'bridging the gap extends it again');
});

/* --------------------------------------------------------------- reports */

test('skillStats and overallStats agree with the recorded answers', () => {
  const pool = [
    question({ id: 'q1', skill: 'Transitions' }),
    question({ id: 'q2', skill: 'Transitions' }),
    question({ id: 'q3', skill: 'Boundaries' })
  ];
  const state = C.emptyState(NOW);
  C.applyAnswer(state, pool[0], 1, NOW);   // right
  C.applyAnswer(state, pool[1], 0, NOW);   // wrong
  C.applyAnswer(state, pool[2], 1, NOW);   // right

  const rows = C.skillStats(state, pool, NOW);
  const transitions = rows.find((row) => row.skill === 'Transitions');
  const boundaries = rows.find((row) => row.skill === 'Boundaries');
  assert.deepEqual(
    [transitions.total, transitions.attempted, transitions.correct,
      transitions.correctFirstTry, transitions.accuracy, transitions.due, transitions.unseen],
    [2, 2, 1, 1, 50, 1, 0]
  );
  assert.equal(boundaries.accuracy, 100);
  assert.equal(rows[0].domain, 'Craft and Structure');
  assert.deepEqual(C.skillOrder(pool), ['Transitions', 'Boundaries']);

  const overall = C.overallStats(state, pool, NOW);
  assert.equal(overall.answered, 3);
  assert.equal(overall.accuracy, 67);
  assert.equal(overall.seen, 3);
  assert.equal(overall.bankSize, 3);
  assert.equal(overall.due, 1);
  assert.equal(overall.sessions, 0);
});

test('troubleSpots lists repeated misses, worst first', () => {
  const pool = [
    question({ id: 'q1', skill: 'Transitions' }),
    question({ id: 'q2', skill: 'Transitions' })
  ];
  const state = C.emptyState(NOW);
  C.applyAnswer(state, pool[0], 0, NOW);
  C.applyAnswer(state, pool[0], 0, NOW);
  C.applyAnswer(state, pool[0], 1, NOW);
  C.applyAnswer(state, pool[1], 0, NOW);
  C.applyAnswer(state, pool[1], 1, NOW);

  const spots = C.troubleSpots(state, pool, 5);
  assert.deepEqual(spots.map((row) => row.q.id), ['q1', 'q2'], 'worst first');
  assert.equal(spots[0].wrong, 2);
  assert.equal(spots[1].wrong, 1);
});

test('dueCount counts what the review mode would serve', () => {
  const pool = [1, 2].map((n) => question({ id: 'q' + n }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, pool[0], 1, NOW);
  assert.equal(C.dueCount(state, pool, NOW), 0);
  assert.equal(C.dueCount(state, pool, NOW + DAY), 1);
});
