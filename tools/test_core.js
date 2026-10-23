/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 naromil
 *
 * Node test suite for app/core.js and the sample bank in questions/index.json
 * plus the per-set files it lists.
 * Run: node --test tools/test_core.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../app/core.js');

const DAY = C.DAY_MS;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function question(overrides) {
  return Object.assign({
    id: 'q1',
    passage: '',
    image: '',
    imageAlt: '',
    imageCaption: '',
    question: 'Question?',
    choices: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    answer: 1,
    explanation: '',
    explanations: null
  }, overrides);
}

function rawSet(overrides) {
  return Object.assign({
    id: 'set-1',
    title: 'Set One',
    description: '',
    questions: [question()]
  }, overrides);
}

function load(...sets) {
  const result = C.normalizeBank({ sets });
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  return result.sets;
}

function seqRng(values) {
  let i = 0;
  return function () {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
}

/* ------------------------------------------------------------ session size */

test('sessionLength: practice-all serves a small set whole and caps at 30', () => {
  assert.deepEqual(C.SESSION_LENGTHS, [5, 10, 15, 20, 30, 50]);
  const settings = { length: 10, practiceAll: true };
  assert.equal(C.sessionLength(settings, 0), 0);
  assert.equal(C.sessionLength(settings, 12), 12);
  assert.equal(C.sessionLength(settings, 30), 30);
  assert.equal(C.sessionLength(settings, 31), 10);
  assert.equal(C.sessionLength({ length: 20, practiceAll: true }, 40), 20);
});

test('sessionLength: switch off or missing uses the sanitised length', () => {
  assert.equal(C.sessionLength({ length: 15, practiceAll: false }, 12), 15);
  assert.equal(C.sessionLength({ length: 20 }, 7), 7, 'missing practiceAll defaults on');
  assert.equal(C.sessionLength({ length: 10 }, 40), 10);
  assert.equal(C.sessionLength({ practiceAll: false }, 12), 10);
  assert.equal(C.sessionLength({ length: 7, practiceAll: false }, 12), 10);
  assert.equal(C.sessionLength(null, 12), 12);
});

test('emptyState: session defaults are 10 and practice-all on', () => {
  assert.deepEqual(C.emptyState(NOW).settings, {
    length: 10,
    practiceAll: true,
    theme: 'auto',
    sound: true
  });
});

test('sanitizeState: keeps known lengths and migrates practiceAll', () => {
  const base = {
    app: C.STATE_APP,
    v: 1,
    q: {},
    sets: {},
    local: {},
    archived: {},
    days: {},
    totals: { a: 0, c: 0, sessions: 0 }
  };
  const old = C.sanitizeState(Object.assign({}, base, {
    settings: { length: 4, theme: 'dark', sound: false }
  }), NOW);
  assert.equal(old.settings.length, 4, 'a legacy length survives');
  assert.equal(old.settings.practiceAll, true, 'old exports gain the switch');
  assert.equal(old.settings.theme, 'dark');
  assert.equal(old.settings.sound, false);

  const off = C.sanitizeState(Object.assign({}, base, {
    settings: { length: 12, practiceAll: false }
  }), NOW);
  assert.equal(off.settings.practiceAll, false, 'an explicit false is kept');

  const junk = C.sanitizeState(Object.assign({}, base, {
    settings: { length: 7, practiceAll: false }
  }), NOW);
  assert.equal(junk.settings.length, 10, 'an unknown length falls back to 10');
  assert.equal(junk.settings.practiceAll, false);
});

/* ------------------------------------------------------------- the format */

test('normalizeBank: accepts the fixed format and applies defaults', () => {
  const sets = load(rawSet({
    questions: [
      question({ id: 'q1' }),
      question({
        id: 'q2',
        passage: '  A passage.  ',
        explanation: '  Because.  ',
        explanations: ['  A why  ', null, null, null]
      })
    ]
  }));
  assert.equal(sets.length, 1);
  const set = sets[0];
  assert.equal(set.id, 'set-1');
  assert.equal(set.title, 'Set One');
  assert.equal(set.description, '');
  assert.equal(set.questions.length, 2);
  assert.equal(set.questions[1].passage, 'A passage.');
  assert.equal(set.questions[1].explanation, 'Because.');
  assert.deepEqual(set.questions[1].explanations, ['A why', '', '', '']);
  assert.equal(set.questions[0].explanations, null);
  assert.equal(set.questions[0].image, '');
  assert.equal(set.questions[0].imageAlt, '');
  assert.equal(set.questions[0].imageCaption, '');
});

test('normalizeBank: trims and keeps the question image fields', () => {
  const sets = load(rawSet({
    questions: [question({
      image: '  images/australia-map.png  ',
      imageAlt: '  Map of Australia with Canberra marked.  ',
      imageCaption: '  Canberra is in the ACT.  '
    })]
  }));
  const q = sets[0].questions[0];
  assert.equal(q.image, 'images/australia-map.png');
  assert.equal(q.imageAlt, 'Map of Australia with Canberra marked.');
  assert.equal(q.imageCaption, 'Canberra is in the ACT.');
});

test('cloneSet: keeps the question image fields', () => {
  const set = load(rawSet({
    questions: [question({
      image: 'images/australia-map.png',
      imageAlt: 'Map of Australia.',
      imageCaption: 'Canberra is marked.'
    })]
  }))[0];
  const copy = C.cloneSet(set);
  assert.equal(copy.questions[0].image, 'images/australia-map.png');
  assert.equal(copy.questions[0].imageAlt, 'Map of Australia.');
  assert.equal(copy.questions[0].imageCaption, 'Canberra is marked.');
});

test('resolveImage: resolves bare paths and rejects script schemes', () => {
  const base = 'http://127.0.0.1:8765/questions/';
  assert.equal(C.resolveImage('images/a.png', base),
    'http://127.0.0.1:8765/questions/images/a.png');
  assert.equal(C.resolveImage(' /images/a.png ', base),
    'http://127.0.0.1:8765/images/a.png');
  assert.equal(C.resolveImage('../assets/a.png', base),
    'http://127.0.0.1:8765/assets/a.png');
  assert.equal(C.resolveImage('https://cdn.example/a.png', base),
    'https://cdn.example/a.png');
  assert.equal(C.resolveImage('data:image/svg+xml,<svg></svg>', base),
    'data:image/svg+xml,<svg></svg>');
  assert.equal(C.resolveImage('javascript:alert(1)', base), '');
  assert.equal(C.resolveImage('', base), '');
});

test('normalizeBank: reports one bad set and keeps the rest', () => {
  const result = C.normalizeBank({
    sets: [
      rawSet({ id: 'good', questions: [question()] }),
      rawSet({ id: 'bad', questions: [question({ answer: 9 })] })
    ]
  });
  assert.deepEqual(result.sets.map((set) => set.id), ['good']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /0-based choice index/);
});

test('normalizeBank: rejects duplicate ids and malformed questions', () => {
  const duplicateSet = C.normalizeBank({
    sets: [rawSet({ id: 'same' }), rawSet({ id: 'same' })]
  });
  assert.equal(duplicateSet.sets.length, 1);
  assert.match(duplicateSet.errors[0].message, /duplicate set id/);

  const duplicateQuestion = C.normalizeBank({
    sets: [rawSet({ questions: [question({ id: 'q1' }), question({ id: 'q1' })] })]
  });
  assert.match(duplicateQuestion.errors[0].message, /duplicate question id/);

  const badChoices = C.normalizeBank({
    sets: [rawSet({ questions: [question({ choices: ['Only one'] })] })]
  });
  assert.match(badChoices.errors[0].message, /at least two "choices"/);

  const badExplanation = C.normalizeBank({
    sets: [rawSet({ questions: [question({ explanations: ['one'] })] })]
  });
  assert.match(badExplanation.errors[0].message, /one entry per choice/);
});

test('normalizeBank: rejects a non-bank object', () => {
  const result = C.normalizeBank({ nope: true });
  assert.equal(result.sets.length, 0);
  assert.match(result.errors[0].message, /"sets" array/);
});

test('questions/index.json and its set files are valid fixed-format data', () => {
  const root = path.join(__dirname, '..', 'questions');
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  assert.ok(Array.isArray(index.files));
  assert.ok(index.files.length >= 2);

  const sets = [];
  index.files.forEach((name) => {
    assert.ok(!name.includes('/') && !name.includes('\\'), `${name} is not a bare file name`);
    const raw = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    const bank = Array.isArray(raw.sets)
      ? C.normalizeBank(raw)
      : { sets: [C.normalizeSet(raw, 0)], errors: [] };
    assert.deepEqual(bank.errors, [], `${name}: ${JSON.stringify(bank.errors)}`);
    sets.push(...bank.sets);
  });

  assert.ok(sets.length >= 2);
  assert.equal(new Set(sets.map((set) => set.id)).size, sets.length, 'set ids are unique');
  sets.forEach((set) => {
    assert.ok(set.questions.length > 0);
    set.questions.forEach((item) => {
      assert.ok(item.choices.length >= 2);
      assert.ok(item.answer >= 0 && item.answer < item.choices.length);
      if (item.image && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(item.image)) {
        assert.ok(fs.existsSync(path.join(root, item.image)),
          `${set.id}/${item.id}: image ${item.image} is missing`);
      }
    });
  });
});

test('letterFor and questionKey: labels and progress keys are unambiguous', () => {
  assert.equal(C.letterFor(0), 'A');
  assert.equal(C.letterFor(25), 'Z');
  assert.equal(C.letterFor(26), 'AA');
  assert.notEqual(C.questionKey('a/b', 'c'), C.questionKey('a', 'b/c'));
  assert.equal(C.questionKey('s', 'q'), C.questionKey('s', 'q'));
});

/* ---------------------------------------------------------------- grading */

test('applyAnswer: first-try correct earns full mastery and schedules review', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const result = C.applyAnswer(state, set.id, set.questions[0], 1, NOW);

  assert.equal(result.correct, true);
  assert.equal(result.coin, 'new');
  assert.equal(result.firstCorrect, true);
  assert.equal(result.pointsDelta, C.MASTERY.firstCorrect);
  assert.equal(state.totals.a, 1);
  assert.equal(state.totals.c, 1);
  assert.equal(state.sets[set.id].points, C.MASTERY.firstCorrect);

  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.a, 1);
  assert.equal(rec.c, 1);
  assert.equal(rec.f, 1);
  assert.equal(rec.box, 1);
  assert.equal(rec.due, NOW + DAY);
});

test('applyAnswer: a correct repeat is worth less than the first time', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  C.applyAnswer(state, set.id, q1, 1, NOW);
  const result = C.applyAnswer(state, set.id, q1, 1, NOW + 2 * DAY);

  assert.equal(result.coin, 'repeat');
  assert.equal(result.firstCorrect, false);
  assert.equal(result.pointsDelta, C.MASTERY.repeatCorrect);
  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.box, 2);
  assert.equal(rec.f, 1);
});

test('applyAnswer: a miss costs mastery and makes the item due immediately', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const result = C.applyAnswer(state, set.id, set.questions[0], 0, NOW);

  assert.equal(result.correct, false);
  assert.equal(result.coin, 'miss');
  assert.equal(result.pointsDelta, 0, 'mastery is floored at zero');
  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.box, 0);
  assert.equal(rec.due, NOW);
  assert.equal(rec.f, 0);
});

test('SRS: correct answers walk box 1 -> 2 -> 3 -> 4 and then hold', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  for (let i = 0; i < 6; i += 1) {
    C.applyAnswer(state, set.id, q1, 1, NOW + i * 30 * DAY);
    const rec = state.q[C.questionKey(set.id, 'q1')];
    assert.equal(rec.box, Math.min(i + 1, C.SRS_LAST_BOX));
  }
});

test('mastery is capped at 100 and floored at 0', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  for (let i = 0; i < 20; i += 1) C.applyAnswer(state, set.id, q1, 1, NOW + i * DAY);
  assert.equal(state.sets[set.id].points, 100);
  for (let i = 0; i < 20; i += 1) C.applyAnswer(state, set.id, q1, 0, NOW + (30 + i) * DAY);
  assert.equal(state.sets[set.id].points, 0);
});

test('tierOf: tiers follow the point thresholds', () => {
  assert.equal(C.tierOf(0, 0).key, 'new');
  assert.equal(C.tierOf(0, 1).key, 'new');
  assert.equal(C.tierOf(1, 1).key, 'familiar');
  assert.equal(C.tierOf(50, 1).key, 'proficient');
  assert.equal(C.tierOf(85, 1).key, 'mastered');
});

/* ---------------------------------------------------------- session pick */

test('selectSession: practice starts with unseen questions', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' }), question({ id: 'q3' }), question({ id: 'q4' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // correct, box 1
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // wrong, box 0
  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 4, rng: seqRng([0.1, 0.2, 0.3, 0.4]), now: NOW + 1000
  });
  assert.deepEqual(picked.slice(0, 2).map((item) => item.id).sort(), ['q3', 'q4']);
  assert.equal(picked[picked.length - 1].id, 'q1', 'the mastered question comes last');
});

test('selectSession: review serves exactly the due questions, oldest first', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // due NOW + 1 day
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // due NOW

  const atNow = C.selectSession(state, set.id, set.questions, { mode: 'review', length: 10, now: NOW });
  assert.deepEqual(atNow.map((item) => item.id), ['q2']);

  const later = C.selectSession(state, set.id, set.questions, {
    mode: 'review', length: 10, now: NOW + 2 * DAY
  });
  assert.deepEqual(later.map((item) => item.id), ['q2', 'q1']);
});

test('selectSession: never repeats an excluded id and never overruns', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' }), question({ id: 'q3' })]
  }));
  const state = C.emptyState(NOW);
  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 100, exclude: ['q2'], rng: seqRng([0.5])
  });
  assert.equal(picked.length, 2);
  assert.ok(!picked.some((item) => item.id === 'q2'));
});

test('selectSession: practice is deterministic under a seeded rng', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' }), question({ id: 'q3' })]
  }));
  const state = C.emptyState(NOW);
  const run = () => C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 3, rng: seqRng([0.3, 0.1, 0.2])
  }).map((item) => item.id);
  assert.deepEqual(run(), run());
});

/* --------------------------------------------------------------- archive */

test('archiveSet/restoreSet: hide a set, keep its copy, restore it', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);

  const snapshot = C.archiveSet(state, set, NOW);
  assert.equal(snapshot.archivedAt, NOW);
  assert.deepEqual(C.activeSets(state, [set]), []);
  assert.deepEqual(C.archivedSets(state).map((item) => item.id), ['set-1']);
  assert.equal(C.findSet(state, [set], 'set-1').title, 'Set One');

  C.restoreSet(state, 'set-1', set, NOW + 1);
  assert.deepEqual(C.archivedSets(state), []);
  assert.deepEqual(C.activeSets(state, [set]).map((item) => item.id), ['set-1']);
  assert.deepEqual(state.local, {});
});

test('restoreSet: keeps a browser-local copy when the source set is gone', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  C.archiveSet(state, set, NOW);
  C.restoreSet(state, 'set-1', null, NOW + 1);

  assert.deepEqual(C.archivedSets(state), []);
  assert.equal(state.local['set-1'].title, 'Set One');
  assert.deepEqual(C.activeSets(state, []).map((item) => item.id), ['set-1']);
  assert.equal(C.findSet(state, [], 'set-1').questions[0].answer, 1);
});

test('allSets: includes archived copies without duplicating active sets', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  assert.deepEqual(C.allSets(state, [set]).map((item) => item.id), ['set-1']);
  C.archiveSet(state, set, NOW);
  assert.deepEqual(C.allSets(state, [set]).map((item) => item.id), ['set-1']);
  assert.equal(C.allSets(state, [set])[0].archivedAt, NOW);
});

/* -------------------------------------------------------- state handling */

test('sanitizeState: junk imports become a usable empty state', () => {
  const state = C.sanitizeState({ v: 1, q: 'nope', totals: 'nope' }, NOW);
  assert.deepEqual(state.q, {});
  assert.deepEqual(state.totals, { a: 0, c: 0, sessions: 0 });
  assert.equal(state.settings.length, 10);
  assert.equal(state.settings.practiceAll, true);

  assert.deepEqual(C.sanitizeState({ v: 99, q: {} }, NOW), C.emptyState(NOW));
  assert.deepEqual(C.sanitizeState({ app: 'other-trainer', v: 1, q: {} }, NOW),
    C.emptyState(NOW));
  assert.deepEqual(C.sanitizeState(null, NOW), C.emptyState(NOW));
});

test('sanitizeState: keeps archive snapshots and local copies, dropping duplicates', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  C.archiveSet(state, set, NOW);
  const roundTrip = C.sanitizeState(JSON.parse(JSON.stringify(state)), NOW + 5);
  assert.equal(roundTrip.archived['set-1'].title, 'Set One');
  assert.equal(roundTrip.archived['set-1'].archivedAt, NOW);

  const duplicated = C.emptyState(NOW);
  duplicated.local['set-1'] = C.cloneSet(set);
  duplicated.archived['set-1'] = Object.assign(C.cloneSet(set), { archivedAt: NOW });
  const clean = C.sanitizeState(JSON.parse(JSON.stringify(duplicated)), NOW);
  assert.deepEqual(clean.local, {});
  assert.equal(clean.archived['set-1'].title, 'Set One');
});

test('sanitizeState: clamps nonsense records instead of trusting them', () => {
  const state = C.sanitizeState({
    app: C.STATE_APP,
    v: 1,
    q: {
      key: { a: 3, c: 9, f: 7, box: 99, due: 'later', last: null },
      empty: { a: 0 }
    },
    sets: { set: { points: 999, a: -2, c: 4, streak: -3 } },
    settings: { length: 7, theme: 'neon', sound: false },
    totals: { a: 2, c: 9, sessions: -1 }
  }, NOW);
  assert.equal(state.q.key.a, 3);
  assert.equal(state.q.key.c, 3);
  assert.equal(state.q.key.box, C.SRS_LAST_BOX);
  assert.equal(state.q.key.due, NOW);
  assert.equal(state.q.key.f, 1);
  assert.equal(state.q.empty, undefined);
  assert.equal(state.sets.set.points, 100);
  assert.equal(state.sets.set.a, 0);
  assert.equal(state.sets.set.streak, 0);
  assert.equal(state.settings.length, 10);
  assert.equal(state.settings.theme, 'auto');
  assert.equal(state.settings.sound, false);
  assert.equal(state.settings.practiceAll, true);
  assert.deepEqual(state.totals, { a: 2, c: 2, sessions: 0 });
});

test('streak: counts back from today, tolerating an untouched today', () => {
  const state = C.emptyState(NOW);
  state.days[C.dayKey(NOW)] = { a: 2, c: 1 };
  state.days[C.dayKey(NOW - DAY)] = { a: 1, c: 1 };
  assert.equal(C.streak(state, NOW), 2);
  assert.equal(C.streak(state, NOW + DAY), 2, 'an untouched today does not break the streak');

  const stale = C.emptyState(NOW);
  stale.days[C.dayKey(NOW - 2 * DAY)] = { a: 1, c: 1 };
  assert.equal(C.streak(stale, NOW), 0);
});

/* --------------------------------------------------------------- reports */

test('setStats and overallStats agree with the recorded answers', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // first-try correct
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // miss
  C.applyAnswer(state, set.id, set.questions[1], 1, NOW + 1000); // retry correct

  const row = C.setStats(state, set, NOW + 2000);
  assert.equal(row.total, 2);
  assert.equal(row.attempted, 2);
  assert.equal(row.correct, 2);
  assert.equal(row.correctFirstTry, 1);
  assert.equal(row.accuracy, 50);
  assert.equal(row.due, 0);
  assert.equal(row.points, C.MASTERY.firstCorrect - 8 + C.MASTERY.firstCorrect);

  const stats = C.overallStats(state, [set], NOW + 2000);
  assert.equal(stats.answered, 3);
  assert.equal(stats.correct, 2);
  assert.equal(stats.accuracy, 50);
  assert.equal(stats.seen, 2);
  assert.equal(stats.bankSize, 2);
  assert.equal(stats.setCount, 1);
});

test('first-try accuracy counts the first answer, not eventual correctness', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW);
  C.applyAnswer(state, set.id, set.questions[1], 1, NOW + DAY);

  const row = C.setStats(state, set, NOW + 2 * DAY);
  assert.equal(row.correctFirstTry, 1);
  assert.equal(row.accuracy, 50);
});

test('troubleSpots lists repeated misses, worst first', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 0, NOW);
  C.applyAnswer(state, set.id, set.questions[0], 0, NOW + 1);
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW);

  const rows = C.troubleSpots(state, [set], 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].q.id, 'q1');
  assert.equal(rows[0].wrong, 2);
});

test('dueCount counts what the review mode would serve', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // due in 1 day
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // due now
  assert.equal(C.dueCount(state, [set], NOW), 1);
  assert.equal(C.dueCount(state, [set], NOW + 2 * DAY), 2);
});

test('activity reports the requested window, ending today', () => {
  const state = C.emptyState(NOW);
  state.days[C.dayKey(NOW)] = { a: 3, c: 2 };
  const days = C.activity(state, 14, NOW);
  assert.equal(days.length, 14);
  assert.equal(days[days.length - 1].date, C.dayKey(NOW));
  assert.equal(days[days.length - 1].a, 3);
  assert.equal(days[0].a, 0);
});
