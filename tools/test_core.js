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
const { spawnSync } = require('node:child_process');

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

function load(...units) {
  /* Run the real pipeline: a folder descriptor plus the unit files it lists.
   * One unit in, one unit out, so the older assertions keep their shape. */
  const raws = units.length ? units : [rawSet()];
  const folder = C.normalizeFolder({
    id: raws[0].id,
    title: raws[0].title,
    units: raws.map((_, i) => `unit-${i}.json`)
  }, raws[0].id);
  const built = C.buildSet(folder, raws.map((raw, i) => ({ file: `unit-${i}.json`, raw })));
  assert.deepEqual(built.errors, [], JSON.stringify(built.errors));
  return built.set.units;
}

function loadSet(...units) {
  const raws = units.length ? units : [rawSet()];
  const folder = C.normalizeFolder({
    id: 'set-1',
    title: 'Set One',
    units: raws.map((_, i) => `unit-${i}.json`)
  }, 'set-1');
  const built = C.buildSet(folder, raws.map((raw, i) => ({ file: `unit-${i}.json`, raw })));
  assert.deepEqual(built.errors, [], JSON.stringify(built.errors));
  return built.set;
}


function seqRng(values) {
  let i = 0;
  return function () {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* Write a raw question record, bypassing applyAnswer so share/box combinations
 * that practice ordering has to cope with can be set up directly. */
function withRecord(state, setId, questionId, fields) {
  state.q[C.questionKey(setId, questionId)] = Object.assign({
    a: 1, c: 1, f: 1, s: 0, box: 0, due: NOW, last: NOW
  }, fields);
  return state;
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

test('normalizeUnit: accepts the fixed format and applies defaults', () => {
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

test('normalizeUnit: trims and keeps the question image fields', () => {
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

test('cloneSet: keeps every unit and the question image fields', () => {
  const set = loadSet(rawSet({
    id: 'u1',
    title: 'Unit One',
    questions: [question({
      image: 'images/australia-map.png',
      imageAlt: 'Map of Australia.',
      imageCaption: 'Canberra is marked.'
    })]
  }), rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] }));
  const copy = C.cloneSet(set);
  assert.equal(copy.units.length, 2);
  assert.equal(copy.units[1].title, 'Unit Two');
  assert.equal(copy.units[0].questions[0].image, 'images/australia-map.png');
  assert.equal(copy.units[0].questions[0].imageAlt, 'Map of Australia.');
  assert.equal(copy.units[0].questions[0].imageCaption, 'Canberra is marked.');
  copy.units[0].questions[0].choices[0] = 'changed';
  assert.equal(set.units[0].questions[0].choices[0], 'Alpha', 'the clone is independent');
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

test('buildSet: reports one bad unit and keeps the rest of the set', () => {
  const folder = C.normalizeFolder({ id: 's', title: 'S', units: ['a.json', 'b.json'] }, 's');
  const result = C.buildSet(folder, [
    { file: 'a.json', raw: rawSet({ id: 'good', questions: [question()] }) },
    { file: 'b.json', raw: rawSet({ id: 'bad', questions: [question({ answer: 9 })] }) }
  ]);
  assert.equal(result.set.units.length, 1);
  assert.equal(result.set.units[0].id, 'good');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^b\.json: /);
  assert.match(result.errors[0], /0-based choice index/);
});

test('buildSet: a set with no usable unit is not a set', () => {
  const folder = C.normalizeFolder({ id: 's', title: 'S', units: ['a.json'] }, 's');
  const result = C.buildSet(folder, [{ file: 's/a.json', error: 'HTTP 404 Not Found' }]);
  assert.equal(result.set, null);
  assert.match(result.errors[0], /HTTP 404/);
  assert.match(result.errors[1], /no usable unit/);
});

test('buildSet: rejects duplicate unit ids and question ids across units', () => {
  const folder = C.normalizeFolder({ id: 's', title: 'S', units: ['a.json', 'b.json'] }, 's');

  const duplicateUnit = C.buildSet(folder, [
    { file: 'a.json', raw: rawSet({ id: 'same' }) },
    { file: 'b.json', raw: rawSet({ id: 'same' }) }
  ]);
  assert.equal(duplicateUnit.set.units.length, 1);
  assert.match(duplicateUnit.errors[0], /duplicate unit id/);

  const duplicateQuestion = C.buildSet(folder, [
    { file: 'a.json', raw: rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }) },
    { file: 'b.json', raw: rawSet({ id: 'u2', questions: [question({ id: 'q1' })] }) }
  ]);
  assert.equal(duplicateQuestion.set.units.length, 1,
    'a question id must not repeat inside one set');
  assert.match(duplicateQuestion.errors[0], /duplicate question id/);
});

test('buildSet: rejects malformed questions inside a unit', () => {
  const folder = C.normalizeFolder({ id: 's', title: 'S', units: ['a.json'] }, 's');
  const bad = (questions) => C.buildSet(folder, [
    { file: 'a.json', raw: rawSet({ questions }) }
  ]).errors[0];

  assert.match(bad([question({ choices: ['Only one'] })]), /at least two "choices"/);
  assert.match(bad([question({ explanations: ['one'] })]), /one entry per choice/);
  assert.match(bad([question({ id: 'q1' }), question({ id: 'q1' })]),
    /duplicate question id/);
});

test('normalizeFolder: validates the set directory index', () => {
  const base = { id: 's', title: 'S', units: ['a.json'] };
  assert.deepEqual(C.normalizeFolder(base, 'fallback'),
    { id: 's', title: 'S', description: '', units: ['a.json'] });
  assert.equal(C.normalizeFolder({ title: 'S', units: ['a.json'] }, 'folder-name').id,
    'folder-name', 'the id defaults to the folder name');

  assert.throws(() => C.normalizeFolder([], 's'), /must be an object/);
  assert.throws(() => C.normalizeFolder({ nope: true }, 's'), /needs a non-empty "title"/);
  assert.throws(() => C.normalizeFolder({ id: 's', units: ['a.json'] }, 's'),
    /needs a non-empty "title"/);
  assert.throws(() => C.normalizeFolder({ id: 's', title: 'S' }, 's'),
    /"units" array/);
  assert.throws(() => C.normalizeFolder({ id: 's', title: 'S', units: [] }, 's'),
    /"units" array/);
  assert.throws(() => C.normalizeFolder({ id: 's', title: 'S', units: ['../a.json'] }, 's'),
    /bare file name/);
  assert.throws(() => C.normalizeFolder({ id: 's', title: 'S', units: ['a.json', 'a.json'] }, 's'),
    /twice/);
});

test('questions/index.json and its set folders are valid fixed-format data', () => {
  const root = path.join(__dirname, '..', 'questions');
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  assert.ok(Array.isArray(index.sets));
  assert.ok(index.sets.length >= 2);

  const sets = [];
  index.sets.forEach((name) => {
    assert.ok(!name.includes('/') && !name.includes('\\'), `${name} is not a folder name`);
    const folder = JSON.parse(fs.readFileSync(path.join(root, name, 'index.json'), 'utf8'));
    const descriptor = C.normalizeFolder(folder, name);
    const entries = descriptor.units.map((file) => ({
      file: `${name}/${file}`,
      raw: JSON.parse(fs.readFileSync(path.join(root, name, file), 'utf8'))
    }));
    const built = C.buildSet(descriptor, entries);
    assert.deepEqual(built.errors, [], `${name}: ${JSON.stringify(built.errors)}`);
    sets.push(built.set);
  });

  assert.ok(sets.length >= 2);
  assert.equal(new Set(sets.map((set) => set.id)).size, sets.length, 'set ids are unique');

  let multiUnitSets = 0;
  sets.forEach((set) => {
    assert.ok(set.units.length > 0);
    if (set.units.length > 1) multiUnitSets += 1;
    const seen = new Set();
    set.units.forEach((unit) => {
      assert.ok(unit.questions.length > 0, `${set.id}/${unit.id} has no questions`);
      assert.ok(!seen.has(unit.id), `duplicate unit id ${unit.id}`);
      seen.add(unit.id);
      unit.questions.forEach((item) => {
        assert.ok(item.choices.length >= 2);
        assert.ok(item.answer >= 0 && item.answer < item.choices.length);
        if (item.image && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(item.image)) {
          assert.ok(fs.existsSync(path.join(root, item.image)),
            `${set.id}/${item.id}: image ${item.image} is missing`);
        }
      });
    });
  });
  assert.ok(multiUnitSets >= 1, 'at least one shipped set is made of several units');
});

test('letterFor and questionKey: labels and progress keys are unambiguous', () => {
  assert.equal(C.letterFor(0), 'A');
  assert.equal(C.letterFor(25), 'Z');
  assert.equal(C.letterFor(26), 'AA');
  assert.notEqual(C.questionKey('a/b', 'c'), C.questionKey('a', 'b/c'));
  assert.equal(C.questionKey('s', 'q'), C.questionKey('s', 'q'));
});

test('choicesFor: every question ends with an "I don\'t know" choice', () => {
  const [set] = load(rawSet());
  const q = set.questions[0];
  const choices = C.choicesFor(q);
  assert.deepEqual(q.choices, ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    'the authored question data stays as written');
  assert.deepEqual(choices, ['Alpha', 'Bravo', 'Charlie', 'Delta', "I don't know"]);
  assert.equal(C.letterFor(choices.length - 1), 'E');
});

/* ---------------------------------------------------------------- grading */

test('applyAnswer: first-try correct starts a question at 80% and schedules review', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const result = C.applyAnswer(state, set.id, set.questions[0], 1, NOW);

  assert.equal(result.correct, true);
  assert.equal(result.coin, 'new');
  assert.equal(state.totals.a, 1);
  assert.equal(state.totals.c, 1);
  assert.equal(C.masteryOf(state, set.id, set.questions), 80);

  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.a, 1);
  assert.equal(rec.c, 1);
  assert.equal(rec.f, 1);
  assert.equal(rec.box, C.SRS_KNOWN_BOX, 'a first-try right answer is already known');
  assert.equal(rec.due, NOW + 14 * DAY);
});

test('applyAnswer: repeated correct answers raise the question\'s share', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  C.applyAnswer(state, set.id, q1, 1, NOW);
  assert.equal(C.masteryOf(state, set.id, set.questions), 80);

  const result = C.applyAnswer(state, set.id, q1, 1, NOW + 2 * DAY);
  assert.equal(result.coin, 'repeat');
  assert.equal(C.masteryOf(state, set.id, set.questions), 90);
  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.box, C.SRS_KNOWN_BOX + 1);
  assert.equal(rec.f, 1);
});

test('applyAnswer: a miss costs part of the question\'s share and makes it due', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const result = C.applyAnswer(state, set.id, set.questions[0], 0, NOW);

  assert.equal(result.correct, false);
  assert.equal(result.coin, 'miss');
  assert.equal(C.masteryOf(state, set.id, set.questions), 0);
  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.box, 0);
  assert.equal(rec.due, NOW);
  assert.equal(rec.f, 0);

  const lapsed = C.emptyState(NOW);
  C.applyAnswer(lapsed, set.id, set.questions[0], 1, NOW);
  C.applyAnswer(lapsed, set.id, set.questions[0], 0, NOW + DAY);
  assert.equal(C.masteryOf(lapsed, set.id, set.questions), 60,
    'a later miss takes the first-try share back down');
});

test('applyAnswer: the "I don\'t know" choice is always a miss', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q = set.questions[0];
  const dontKnow = C.choicesFor(q).length - 1;
  C.applyAnswer(state, set.id, q, 1, NOW); // right once
  const result = C.applyAnswer(state, set.id, q, dontKnow, NOW + DAY);

  assert.equal(result.correct, false);
  assert.equal(result.chosen, 'E');
  assert.equal(result.expected, 'B');
  assert.equal(result.coin, 'miss');
  assert.equal(result.boxAfter, 0);
  assert.equal(C.masteryOf(state, set.id, set.questions), 60);
  const rec = state.q[C.questionKey(set.id, 'q1')];
  assert.equal(rec.a, 2);
  assert.equal(rec.c, 1);
  assert.equal(rec.f, 1, 'the first answer stays the one that decides first-try accuracy');
});

test('SRS: a correction walks box 1 -> 2 -> ... -> last and then holds', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  C.applyAnswer(state, set.id, q1, 0, NOW); // missed: a correction
  for (let i = 0; i < 7; i += 1) {
    C.applyAnswer(state, set.id, q1, 1, NOW + (i + 1) * 200 * DAY);
    const rec = state.q[C.questionKey(set.id, 'q1')];
    assert.equal(rec.box, Math.min(i + 1, C.SRS_LAST_BOX));
  }
});

test('SRS: a never-missed question jumps to the known box, then climbs', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const key = C.questionKey(set.id, 'q1');
  withRecord(state, set.id, 'q1', { a: 1, c: 1, f: 1, s: 800, box: 1 });
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW);
  assert.equal(state.q[key].box, C.SRS_KNOWN_BOX, 'an old low box is lifted');
  assert.equal(state.q[key].due, NOW + 14 * DAY);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW + 14 * DAY);
  assert.equal(state.q[key].box, C.SRS_KNOWN_BOX + 1);
  assert.equal(state.q[key].due, NOW + 59 * DAY);
});

test('SRS: once missed, a question no longer gets the known-box jump', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  C.applyAnswer(state, set.id, q1, 1, NOW);
  C.applyAnswer(state, set.id, q1, 0, NOW + DAY);
  const result = C.applyAnswer(state, set.id, q1, 1, NOW + DAY);
  assert.equal(result.boxAfter, 1);
  assert.equal(state.q[C.questionKey(set.id, 'q1')].due, NOW + 2 * DAY);
});

test('mastery is capped at 100 and floored at 0', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q1 = set.questions[0];
  for (let i = 0; i < 20; i += 1) {
    C.applyAnswer(state, set.id, q1, 1, NOW + i * DAY);
  }
  assert.equal(C.masteryOf(state, set.id, set.questions), 100);
  for (let i = 0; i < 20; i += 1) {
    C.applyAnswer(state, set.id, q1, 0, NOW + (30 + i) * DAY);
  }
  assert.equal(C.masteryOf(state, set.id, set.questions), 0);
});

test('mastery is averaged over the whole set, whatever its size', () => {
  const four = loadSet(rawSet({
    id: 'four',
    questions: [1, 2, 3, 4].map((n) => question({ id: 'q' + n }))
  }));
  const fourQuestions = C.questionsOf(four);
  const fourState = C.emptyState(NOW);
  fourQuestions.forEach((q) => {
    C.applyAnswer(fourState, four.id, q, 1, NOW);
  });
  assert.equal(C.masteryOf(fourState, four.id, fourQuestions), 80);

  const twelve = loadSet(rawSet({
    id: 'twelve',
    questions: Array.from({ length: 12 }, (_, i) => question({ id: 'q' + (i + 1) }))
  }));
  const twelveQuestions = C.questionsOf(twelve);
  const twelveState = C.emptyState(NOW);
  twelveQuestions.forEach((q) => {
    C.applyAnswer(twelveState, twelve.id, q, 1, NOW);
  });
  assert.equal(C.masteryOf(twelveState, twelve.id, twelveQuestions), 80,
    'a full set is worth the same whether it holds 4 or 12 questions');

  const oneOfFour = C.emptyState(NOW);
  C.applyAnswer(oneOfFour, four.id, fourQuestions[0], 1, NOW);
  assert.equal(C.masteryOf(oneOfFour, four.id, fourQuestions), 20);

  const oneOfTwelve = C.emptyState(NOW);
  C.applyAnswer(oneOfTwelve, twelve.id, twelveQuestions[0], 1, NOW);
  assert.equal(C.masteryOf(oneOfTwelve, twelve.id, twelveQuestions), 7,
    'partial coverage is measured against the whole set');
});

test('mastery: repeated practice lifts a question, a first miss starts it lower', () => {
  const [set] = load(rawSet());
  const q = set.questions[0];

  const clean = C.emptyState(NOW);
  C.applyAnswer(clean, set.id, q, 1, NOW);
  assert.equal(C.masteryOf(clean, set.id, set.questions), 80);
  C.applyAnswer(clean, set.id, q, 1, NOW + DAY);
  assert.equal(C.masteryOf(clean, set.id, set.questions), 90);
  C.applyAnswer(clean, set.id, q, 1, NOW + 2 * DAY);
  assert.equal(C.masteryOf(clean, set.id, set.questions), 100);

  const missedFirst = C.emptyState(NOW);
  C.applyAnswer(missedFirst, set.id, q, 0, NOW);
  C.applyAnswer(missedFirst, set.id, q, 1, NOW + DAY);
  assert.equal(C.masteryOf(missedFirst, set.id, set.questions), 55);
  C.applyAnswer(missedFirst, set.id, q, 1, NOW + 2 * DAY);
  assert.equal(C.masteryOf(missedFirst, set.id, set.questions), 65);
});

test('mastery: the first correct answer after a first miss sets 55%', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q = set.questions[0];

  C.applyAnswer(state, set.id, q, 0, NOW);
  assert.equal(state.q[C.questionKey(set.id, 'q1')].s, 0);
  C.applyAnswer(state, set.id, q, 1, NOW + DAY);
  assert.equal(state.q[C.questionKey(set.id, 'q1')].s, 550);
  assert.equal(C.masteryOf(state, set.id, set.questions), 55);
});

test('mastery: three correct answers reach 100 and the next miss costs 20', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q = set.questions[0];

  for (let i = 0; i < 3; i += 1) {
    C.applyAnswer(state, set.id, q, 1, NOW + i * DAY);
  }
  assert.equal(C.masteryOf(state, set.id, set.questions), 100);
  C.applyAnswer(state, set.id, q, 0, NOW + 3 * DAY);
  assert.equal(C.masteryOf(state, set.id, set.questions), 80);
});

test('mastery: misses before the first correct are forgiven', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q = set.questions[0];

  for (let i = 0; i < 3; i += 1) {
    C.applyAnswer(state, set.id, q, 0, NOW + i * DAY);
  }
  assert.equal(C.masteryOf(state, set.id, set.questions), 0);
  C.applyAnswer(state, set.id, q, 1, NOW + 3 * DAY);
  assert.equal(C.masteryOf(state, set.id, set.questions), 55,
    'the first correct answer is 55 however many misses came first');
});

test('mastery: a miss on a saturated question costs 20, not nothing', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  const q = set.questions[0];

  for (let i = 0; i < 6; i += 1) {
    C.applyAnswer(state, set.id, q, 1, NOW + i * DAY);
  }
  assert.equal(C.masteryOf(state, set.id, set.questions), 100);
  C.applyAnswer(state, set.id, q, 0, NOW + 6 * DAY);
  assert.equal(C.masteryOf(state, set.id, set.questions), 80);
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
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // due NOW + 14 days
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // due NOW

  const atNow = C.selectSession(state, set.id, set.questions, { mode: 'review', length: 10, now: NOW });
  assert.deepEqual(atNow.map((item) => item.id), ['q2']);

  const later = C.selectSession(state, set.id, set.questions, {
    mode: 'review', length: 10, now: NOW + 14 * DAY
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

/* ------------------------------------------------------- sets and units */

test('unitsOf/unitOf/questionsOf: a set is the union of its units', () => {
  const set = loadSet(
    rawSet({
      id: 'u1', title: 'Unit One',
      questions: [question({ id: 'q1' }), question({ id: 'q2' })]
    }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q3' })] })
  );
  assert.deepEqual(C.unitsOf(set).map((unit) => unit.id), ['u1', 'u2']);
  assert.equal(C.unitOf(set, 'u2').title, 'Unit Two');
  assert.equal(C.unitOf(set, 'nope'), null);
  assert.deepEqual(C.questionsOf(set).map((item) => item.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(C.questionsOf(set, 'u2').map((item) => item.id), ['q3']);
  assert.deepEqual(C.questionsOf(set, 'nope'), []);
});

test('a unit session still keys progress by set id plus question id', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  const picked = C.selectSession(state, set.id, C.questionsOf(set, 'u2'), {
    mode: 'practice', length: 5, now: NOW
  });
  assert.deepEqual(picked.map((item) => item.id), ['q2']);

  C.applyAnswer(state, set.id, picked[0], 1, NOW);
  assert.ok(state.q[C.questionKey('set-1', 'q2')], 'stored under the set id');
  assert.equal(C.masteryOf(state, set.id, C.questionsOf(set)), 40,
    'the answer counts against the whole two-question set, not just its unit');
});

test('unitStats and setStats: units are reported inside the set', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' }), question({ id: 'q2' })] }),
    rawSet({ id: 'u2', questions: [question({ id: 'q3' })] })
  );
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW); // first try
  C.applyAnswer(state, set.id, set.units[1].questions[0], 0, NOW); // miss

  const unit = C.unitStats(state, set, set.units[0], NOW);
  assert.equal(unit.total, 2);
  assert.equal(unit.attempted, 1);
  assert.equal(unit.accuracy, 100);
  assert.equal(unit.points, 40, 'the unit score averages only its own questions');
  assert.equal(unit.tier.key, 'familiar', 'the unit bar is tiered by its own score');
  assert.equal(unit.due, 0);
  assert.equal(C.unitStats(state, set, set.units[1], NOW).points, 0,
    'a unit with only a miss scores zero');

  const row = C.setStats(state, set, NOW);
  assert.equal(row.units, 2);
  assert.equal(row.total, 3);
  assert.equal(row.attempted, 2);
  assert.equal(row.unitRows.length, 2);
  assert.equal(row.due, 1, 'the miss is due immediately');
  assert.equal(row.accuracy, 50);
  assert.equal(row.points, 27,
    'one first-try question of three is 80/3, rounded; unseen questions count zero');
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
  assert.equal(C.findSet(state, [], 'set-1').units[0].questions[0].answer, 1);
});

test('allSets: includes archived copies without duplicating active sets', () => {
  const [set] = load(rawSet());
  const state = C.emptyState(NOW);
  assert.deepEqual(C.allSets(state, [set]).map((item) => item.id), ['set-1']);
  C.archiveSet(state, set, NOW);
  assert.deepEqual(C.allSets(state, [set]).map((item) => item.id), ['set-1']);
  assert.equal(C.allSets(state, [set])[0].archivedAt, NOW);
});

/* -------------------------------------------------------- unit archives */

test('archiveUnit: hides one unit and keeps the rest of the set', () => {
  const set = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW);

  const active = C.activeSets(state, [set]);
  assert.equal(active.length, 1, 'the set stays on the list');
  assert.deepEqual(active[0].units.map((unit) => unit.id), ['u2']);
  assert.deepEqual(C.archivedSets(state).map((entry) => entry.id), ['u1']);
  assert.equal(C.archivedSets(state)[0].kind, 'unit');
  assert.equal(C.archivedSets(state)[0].setTitle, 'Set One');

  C.restoreUnit(state, set.id, 'u1', set, NOW + 1);
  assert.deepEqual(C.archivedSets(state), []);
  assert.deepEqual(C.activeSets(state, [set])[0].units.map((unit) => unit.id), ['u1', 'u2']);
  assert.deepEqual(state.local, {}, 'the source still has the unit, so no local copy is needed');
});

test('mastery: an archived unit leaves the active set\'s scale', () => {
  const set = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.units[1].questions[0], 1, NOW);
  assert.equal(C.masteryOf(state, set.id, C.questionsOf(set)), 80);

  C.archiveUnit(state, set, set.units[1], NOW + 1);
  const active = C.activeSets(state, [set])[0];
  assert.equal(C.questionsOf(active).length, 1);
  assert.equal(C.masteryOf(state, set.id, C.questionsOf(active)), 80,
    'the archived unit\'s record must not inflate the remaining set');
  assert.equal(C.setStats(state, active, NOW + 2).points, 80);

  const archived = C.archivedSets(state)[0];
  const archivedRow = C.unitStats(state, { id: archived.setId }, archived, NOW + 2);
  assert.equal(archivedRow.points, 80, 'the archived unit keeps its own score');
});

test('archiveUnit: the same unit id in another set is untouched', () => {
  const setA = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' })] })
  );
  const setB = Object.assign({}, setA, { id: 'set-2', title: 'Set Two' });

  const state = C.emptyState(NOW);
  C.archiveUnit(state, setB, setB.units[0], NOW);

  assert.deepEqual(C.activeSets(state, [setA, setB]).map((set) => set.id), ['set-1'],
    'the colliding unit id in set A must not hide set A');
  assert.deepEqual(C.archivedSets(state).map((entry) => entry.id), ['u1']);
  assert.equal(C.archivedSets(state)[0].setId, 'set-2');

  C.restoreUnit(state, 'set-2', 'u1', setB, NOW + 1);
  assert.deepEqual(C.activeSets(state, [setA, setB]).map((set) => set.id),
    ['set-1', 'set-2']);
});

test('archiveUnit: the set leaves the list when every unit is archived', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW);
  assert.equal(C.activeSets(state, [set]).length, 1);
  C.archiveUnit(state, set, set.units[1], NOW);
  assert.deepEqual(C.activeSets(state, [set]), []);
  assert.equal(C.archivedSets(state).length, 2);
});

test('archiveSet: absorbs the unit archives of the same set', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW);
  C.archiveSet(state, set, NOW + 1);
  assert.deepEqual(state.archivedUnits, {});
  assert.deepEqual(C.archivedSets(state).map((entry) => entry.kind), ['set']);
  assert.deepEqual(C.archivedSets(state)[0].units.map((unit) => unit.id), ['u1', 'u2']);
});

test('archiveSet: keeps a previously archived unit when given the filtered set', () => {
  const set = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW);

  /* The home screen passes the active set, which no longer contains u1. */
  const filtered = C.activeSets(state, [set])[0];
  const snapshot = C.archiveSet(state, filtered, NOW + 1);

  assert.deepEqual(snapshot.units.map((unit) => unit.id), ['u2', 'u1']);
  assert.deepEqual(state.archivedUnits, {});
  C.restoreSet(state, set.id, null, NOW + 2);
  assert.deepEqual(state.local[set.id].units.map((unit) => unit.id).sort(), ['u1', 'u2']);
});

test('restoreUnit: keeps a browser-local copy when the source lost the unit', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[1], NOW);

  const shrunk = loadSet(rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }));  // same set id, unit file removed
  C.restoreUnit(state, 'set-1', 'u2', shrunk, NOW + 1);

  assert.deepEqual(C.archivedSets(state), []);
  assert.equal(state.local['set-1'].units.length, 2);
  assert.deepEqual(C.activeSets(state, [shrunk])[0].units.map((unit) => unit.id), ['u1', 'u2']);
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
      key: { a: 3, c: 9, f: 7, box: 99, due: 'later', last: null, fast: 5000 },
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
  assert.equal(state.q.key.fast, undefined, 'timing is no longer part of mastery');
  assert.equal(state.q.empty, undefined);
  assert.equal(state.sets.set.points, undefined, 'the old stored total is not kept');
  assert.equal(state.sets.set.a, 0);
  assert.equal(state.sets.set.streak, 0);
  assert.equal(state.settings.length, 10);
  assert.equal(state.settings.theme, 'auto');
  assert.equal(state.settings.sound, false);
  assert.equal(state.settings.practiceAll, true);
  assert.deepEqual(state.totals, { a: 2, c: 2, sessions: 0 });
});

test('sanitizeState: an old export migrates from stored points to the derived score', () => {
  const [set] = load(rawSet());
  const key = C.questionKey(set.id, 'q1');
  const state = C.sanitizeState({
    app: C.STATE_APP,
    v: 1,
    q: { [key]: { a: 1, c: 1, f: 1, box: 1, due: NOW + DAY, last: NOW } },
    sets: { [set.id]: { points: 100, a: 1, c: 1, streak: 1 } },
    local: {}, archived: {}, archivedUnits: {}, days: {},
    totals: { a: 1, c: 1, sessions: 1 }
  }, NOW);

  assert.equal(state.q[key].fast, undefined, 'timing is not carried into the score');
  assert.equal(state.q[key].s, 800,
    'the stored share is seeded from the legacy first-try record');
  assert.equal(state.sets[set.id].points, undefined);
  assert.equal(C.masteryOf(state, set.id, set.questions), 80,
    'the score is recomputed from the first-try record, not the old total');
});

test('sanitizeState: a legacy flat archive becomes a one-unit set', () => {
  const state = C.sanitizeState({
    app: C.STATE_APP, v: 1, q: {}, sets: {}, local: {}, days: {},
    archived: {
      old: {
        id: 'old', title: 'Old Set', archivedAt: 5,
        questions: [question({ id: 'q1' })]
      }
    },
    totals: { a: 0, c: 0, sessions: 0 }
  }, NOW);

  assert.equal(state.archived.old.kind, 'set');
  assert.equal(state.archived.old.units.length, 1);
  assert.equal(state.archived.old.units[0].questions[0].id, 'q1');
  assert.equal(state.archivedUnits && Object.keys(state.archivedUnits).length, 0);
});

test('sanitizeState: keeps unit archives but drops those of an archived set', () => {
  const unit = { id: 'u1', title: 'U1', questions: [question({ id: 'q1' })] };
  const base = { app: C.STATE_APP, v: 1, q: {}, sets: {}, local: {}, days: {},
    totals: { a: 0, c: 0, sessions: 0 } };

  const kept = C.sanitizeState(Object.assign({}, base, {
    archivedUnits: { u1: Object.assign({ setId: 's', setTitle: 'S', archivedAt: 9 }, unit) }
  }), NOW);
  assert.deepEqual(Object.keys(kept.archivedUnits), ['s/u1'],
    'the legacy bare-id key is migrated to a set-scoped key');
  assert.equal(kept.archivedUnits['s/u1'].title, 'U1');
  assert.equal(kept.archivedUnits['s/u1'].kind, 'unit');

  const absorbed = C.sanitizeState(Object.assign({}, base, {
    archived: { s: { id: 's', title: 'S', units: [unit], archivedAt: 5 } },
    archivedUnits: { u1: Object.assign({ setId: 's', setTitle: 'S', archivedAt: 9 }, unit) }
  }), NOW);
  assert.deepEqual(absorbed.archivedUnits, {});
  assert.equal(absorbed.archived.s.units.length, 1);
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
  assert.equal(row.correctFirstTry, 1);
  assert.equal(row.accuracy, 50);
  assert.equal(row.due, 0);
  assert.equal(row.points, 68,
    'q1 at 0.8 and q2 at 0.55 (first miss, then right) average to 0.675');

  const stats = C.overallStats(state, [set], NOW + 2000);
  assert.equal(stats.answered, 3);
  assert.equal(stats.correct, 2);
  assert.equal(stats.accuracy, 50);
  assert.equal(stats.seen, 2);
  assert.equal(stats.bankSize, 2);
  assert.equal(stats.setCount, 1);
});

test('resetSetProgress: forgets one set and keeps its neighbours', () => {
  const [set] = load(rawSet({
    id: 'set-1',
    title: 'Set One',
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const other = Object.assign({}, set, { id: 'set-2', title: 'Set Two' });
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW);
  C.applyAnswer(state, other.id, other.questions[0], 1, NOW);
  const totals = Object.assign({}, state.totals);

  const removed = C.resetSetProgress(state, set.id, NOW + 1);

  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(state.q), ['set-2/q1']);
  assert.equal(state.sets[set.id], undefined);
  assert.equal(C.masteryOf(state, set.id, set.questions), 0);
  assert.equal(C.masteryOf(state, other.id, other.questions), 40);
  assert.deepEqual(state.totals, totals, 'cross-set totals keep their history');
  assert.equal(state.updated, NOW + 1);
  assert.equal(C.setStats(state, set, NOW + 2).attempted, 0);
  assert.equal(C.setStats(state, other, NOW + 2).attempted, 1);
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
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW); // due in 14 days
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // due now
  assert.equal(C.dueCount(state, [set], NOW), 1);
  assert.equal(C.dueCount(state, [set], NOW + 14 * DAY), 2);
});

test('activeDueCount: archived sets keep their schedules but leave the counter', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW); // a miss is due now

  assert.equal(C.activeDueCount(state, [set], NOW), 1);
  assert.equal(C.dueCount(state, [set], NOW), 1);

  C.archiveSet(state, set, NOW + 1);
  assert.equal(C.dueCount(state, [set], NOW + 2), 1, 'the archived set is still due');
  assert.equal(C.activeDueCount(state, [set], NOW + 2), 0,
    'but it no longer contributes to the due counter');
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

/* ---------------------------------------------------------- home list */

function homeRows() {
  return [
    { id: 'geo', title: 'World Capitals', description: 'Cities and Countries',
      units: 2, unitRows: [{ title: 'Europe' }, { title: 'Asia' }] },
    { id: 'bio', title: 'Biology', description: 'Cells and plants',
      units: 1, unitRows: [{ title: 'Cells' }] },
    { id: 'code', title: 'Algorithms', description: '',
      units: 1, unitRows: [{ title: 'Sorting' }] }
  ];
}

test('filterSetRows: matches title, description and unit titles case-insensitively', () => {
  const rows = homeRows();
  assert.deepEqual(C.filterSetRows(rows, 'WORLD').map((row) => row.id), ['geo']);
  assert.deepEqual(C.filterSetRows(rows, 'countries').map((row) => row.id), ['geo']);
  assert.deepEqual(C.filterSetRows(rows, 'asia').map((row) => row.id), ['geo'],
    'a unit title keeps its set visible');
  assert.deepEqual(C.filterSetRows(rows, 'sorted'), [], 'partial words do not match');
  assert.deepEqual(C.filterSetRows(rows, 'sorting').map((row) => row.id), ['code']);
  assert.deepEqual(C.filterSetRows(rows, '  ').length, 3, 'blank query keeps every row');
  assert.deepEqual(C.filterSetRows(rows, 'zzz'), []);
});

test('filterSetRows: works with real setStats rows through their unit titles', () => {
  const set = loadSet(
    rawSet({ id: 'europe', title: 'Europe', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'asia', title: 'Asia', questions: [question({ id: 'q2' })] })
  );
  const rows = [C.setStats(C.emptyState(NOW), set, NOW)];
  assert.equal(C.filterSetRows(rows, 'Asia').length, 1);
  assert.equal(C.filterSetRows(rows, 'Europe').length, 1);
  assert.equal(C.filterSetRows(rows, 'nowhere').length, 0);
});

test('sortSetRows: index, title, mastery and due orders', () => {
  const rows = [
    { id: 'a', title: 'Beta', points: 30, due: 2 },
    { id: 'b', title: 'Alpha', points: 50, due: 0 },
    { id: 'c', title: 'Gamma', points: 50, due: 5 },
    { id: 'd', title: 'Delta', points: 10, due: 5 }
  ];
  assert.deepEqual(C.sortSetRows(rows, 'index').map((row) => row.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(C.sortSetRows(rows, 'title').map((row) => row.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(C.sortSetRows(rows, 'mastery').map((row) => row.id), ['b', 'c', 'a', 'd'],
    'equal mastery keeps source order');
  assert.deepEqual(C.sortSetRows(rows, 'due').map((row) => row.id), ['c', 'd', 'a', 'b'],
    'equal due counts keep source order');
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c', 'd'],
    'the input array is not reordered');
});

test('sortSetRows: every mode falls back to source order on a tie', () => {
  const rows = [
    { id: 'first', title: 'Same', points: 20, due: 3 },
    { id: 'second', title: 'Same', points: 20, due: 3 },
    { id: 'third', title: 'Same', points: 20, due: 3 }
  ];
  ['index', 'title', 'mastery', 'due'].forEach((mode) => {
    assert.deepEqual(C.sortSetRows(rows, mode).map((row) => row.id),
      ['first', 'second', 'third'], mode);
  });
  assert.deepEqual(C.sortSetRows(rows, 'nonsense').map((row) => row.id),
    ['first', 'second', 'third'], 'unknown mode keeps index order');
});

/* -------------------------------------------------------------- themes */

test('nextTheme: auto -> light -> dark -> auto and unknown values fall back to auto', () => {
  assert.equal(C.nextTheme('auto'), 'light');
  assert.equal(C.nextTheme('light'), 'dark');
  assert.equal(C.nextTheme('dark'), 'auto');
  assert.equal(C.nextTheme('neon'), 'light', 'an unknown value is treated as auto');
  assert.equal(C.nextTheme(undefined), 'light');
  assert.equal(C.nextTheme(null), 'light');
});

/* ------------------------------------------------- practice ordering */

test('selectSession: a lower-share question outranks a lower box', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  withRecord(state, set.id, 'q1', { s: 800, box: 0, a: 1 });
  withRecord(state, set.id, 'q2', { s: 550, box: 1, a: 1 });

  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 2, rng: seqRng([0.9, 0.1]), now: NOW
  });
  assert.deepEqual(picked.map((item) => item.id), ['q2', 'q1'],
    'the weaker question comes first even though its box is higher');
});

test('selectSession: unseen questions come first', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  withRecord(state, set.id, 'q1', { s: 800, box: 1, a: 1 });

  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 2, rng: seqRng([0.9, 0.1]), now: NOW
  });
  assert.deepEqual(picked.map((item) => item.id), ['q2', 'q1']);
});

test('selectSession: equal shares break ties by box, recency, attempts, then rng', () => {
  const [set] = load(rawSet({
    questions: [
      question({ id: 'q1' }), question({ id: 'q2' }),
      question({ id: 'q3' }), question({ id: 'q4' })
    ]
  }));
  const state = C.emptyState(NOW);
  withRecord(state, set.id, 'q1', { s: 500, box: 1, a: 1 });
  withRecord(state, set.id, 'q2', { s: 500, box: 0, a: 2 });
  withRecord(state, set.id, 'q3', { s: 500, box: 0, a: 1 });
  withRecord(state, set.id, 'q4', { s: 500, box: 0, a: 1 });

  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 4, rng: seqRng([0.5, 0.5, 0.1, 0.9]), now: NOW
  });
  assert.deepEqual(picked.map((item) => item.id), ['q3', 'q4', 'q2', 'q1'],
    'box 0 before box 1, fewer attempts first, rng decides the last tie');
});

test('selectSession: equal shares break ties by recency before attempts', () => {
  const [set] = load(rawSet({
    questions: [
      question({ id: 'q1' }), question({ id: 'q2' }),
      question({ id: 'q3' }), question({ id: 'q4' })
    ]
  }));
  const state = C.emptyState(NOW);
  withRecord(state, set.id, 'q1', { s: 500, box: 0, a: 1, last: NOW });
  withRecord(state, set.id, 'q2', { s: 500, box: 0, a: 5, last: NOW - DAY });
  withRecord(state, set.id, 'q3', { s: 500, box: 0, a: 2, last: NOW });
  withRecord(state, set.id, 'q4', { s: 500, box: 1, a: 1, last: NOW - DAY });

  const picked = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 4, rng: seqRng([0.5, 0.5, 0.5, 0.5]), now: NOW
  });
  assert.deepEqual(picked.map((item) => item.id), ['q2', 'q1', 'q3', 'q4'],
    'the older question outranks the recent one even with more attempts');
});

test('selectSession: review order is still due-first, not mastery-first', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  withRecord(state, set.id, 'q1', { s: 0, box: 0, a: 1, due: NOW + 2 * DAY });
  withRecord(state, set.id, 'q2', { s: 900, box: 3, a: 5, due: NOW });

  const review = C.selectSession(state, set.id, set.questions, {
    mode: 'review', length: 10, now: NOW + 3 * DAY
  });
  assert.deepEqual(review.map((item) => item.id), ['q2', 'q1'],
    'review sorts by due date only');

  const practice = C.selectSession(state, set.id, set.questions, {
    mode: 'practice', length: 2, rng: seqRng([0.5, 0.5]), now: NOW + 3 * DAY
  });
  assert.deepEqual(practice.map((item) => item.id), ['q1', 'q2'],
    'practice would put the weaker q1 first');
});

/* -------------------------------------------- archived unit totals */

test('allSets: archiving one unit keeps bankSize and seen steady', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.units[1].questions[0], 1, NOW);

  const before = C.overallStats(state, C.allSets(state, [set]), NOW + 1);
  assert.equal(before.bankSize, 2);
  assert.equal(before.seen, 2);

  C.archiveUnit(state, set, set.units[1], NOW + 2);
  assert.deepEqual(C.activeSets(state, [set])[0].units.map((unit) => unit.id), ['u1'],
    'the active view still hides the archived unit');

  const after = C.overallStats(state, C.allSets(state, [set]), NOW + 3);
  assert.equal(after.bankSize, before.bankSize, 'the bank does not shrink');
  assert.equal(after.seen, before.seen, 'seen does not move backwards');
  assert.equal(after.setCount, 1);
});

test('allSets: a fully unit-archived set is still counted once', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW);
  C.archiveUnit(state, set, set.units[0], NOW + 1);
  C.archiveUnit(state, set, set.units[1], NOW + 2);

  assert.deepEqual(C.activeSets(state, [set]), []);
  const all = C.allSets(state, [set]);
  assert.equal(all.length, 1, 'the set is still reported');
  assert.equal(all[0].id, set.id);
  assert.equal(all[0].title, 'Set One');
  assert.deepEqual(all[0].units.map((unit) => unit.id).sort(), ['u1', 'u2']);

  const stats = C.overallStats(state, all, NOW + 3);
  assert.equal(stats.bankSize, 2);
  assert.equal(stats.seen, 1);
  assert.equal(stats.setCount, 1);
});

test('allSets: archiving the whole set does not double count its units', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW + 1);
  C.archiveUnit(state, set, set.units[1], NOW + 2);
  C.archiveSet(state, set, NOW + 3);

  assert.deepEqual(state.archivedUnits, {}, 'archiveSet absorbs the unit entries');
  const all = C.allSets(state, [set]);
  assert.equal(all.length, 1);

  const total = all.reduce((n, row) => n + C.questionsOf(row).length, 0);
  assert.equal(total, 2, 'each question is counted exactly once');

  const stats = C.overallStats(state, all, NOW + 4);
  assert.equal(stats.bankSize, 2);
  assert.equal(stats.setCount, 1);
});

test('allSets: a set with active and archived units totals each question once', () => {
  const set = loadSet(
    rawSet({ id: 'u1', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.archiveUnit(state, set, set.units[0], NOW + 1);

  const active = C.activeSets(state, [set]);
  const archived = C.archivedSets(state);
  const activeTotal = active.reduce((n, row) => n + C.questionsOf(row).length, 0);
  const archivedTotal = archived.reduce((n, row) =>
    n + (row.kind === 'unit' ? row.questions.length : C.questionsOf(row).length), 0);
  const allTotal = C.allSets(state, [set])
    .reduce((n, row) => n + C.questionsOf(row).length, 0);

  assert.equal(activeTotal, 1);
  assert.equal(archivedTotal, 1);
  assert.equal(allTotal, activeTotal + archivedTotal,
    'archived questions appear exactly once in the all-sets view');
});

/* --------------------------------------------------------- state merge */

test('stampState: strictly increasing even when the clock stalls or steps back', () => {
  const state = C.emptyState(NOW);
  state.updated = NOW + 10;

  assert.equal(C.stampState(state, NOW), NOW + 11, 'never below updated + 1');
  assert.equal(state.updated, NOW + 11);
  assert.equal(C.stampState(state, NOW + 100), NOW + 100, 'a newer clock wins');
  assert.equal(C.stampState(state, NOW + 100), NOW + 101, 'same millisecond still advances');
});

test('mergeStates: the newer question record wins', () => {
  const key = C.questionKey('set-1', 'q1');
  const make = (last, a, s) => {
    const state = C.emptyState(NOW);
    state.q[key] = { a: a, c: a, f: 1, s: s, box: a > 1 ? 2 : 1,
      due: NOW + DAY, last: last };
    return state;
  };

  const newerLocal = C.mergeStates(make(NOW, 1, 800), make(NOW + DAY, 3, 1000), NOW + 2 * DAY);
  assert.equal(newerLocal.q[key].last, NOW + DAY);
  assert.equal(newerLocal.q[key].s, 1000);

  const newerServer = C.mergeStates(make(NOW + DAY, 3, 1000), make(NOW, 1, 800), NOW + 2 * DAY);
  assert.equal(newerServer.q[key].last, NOW + DAY);
  assert.equal(newerServer.q[key].s, 1000);

  const tied = C.mergeStates(make(NOW, 1, 800), make(NOW, 4, 900), NOW);
  assert.equal(tied.q[key].a, 4, 'on equal last, the greater attempt count wins');
  const tiedBack = C.mergeStates(make(NOW, 4, 900), make(NOW, 1, 800), NOW);
  assert.equal(tiedBack.q[key].a, 4, 'ties fall back to the server when equal');
});

test('mergeStates: counters take the maximum of either side', () => {
  const server = C.emptyState(NOW);
  const local = C.emptyState(NOW);
  const dayKey = '2026-09-29';

  server.sets.id = { a: 5, c: 3, streak: 1 };
  local.sets.id = { a: 4, c: 4, streak: 3 };
  server.days[dayKey] = { a: 3, c: 1 };
  local.days[dayKey] = { a: 2, c: 2 };
  server.totals = { a: 10, c: 5, sessions: 2 };
  local.totals = { a: 8, c: 8, sessions: 4 };

  const merged = C.mergeStates(server, local, NOW + 1);
  assert.deepEqual(merged.sets.id, { a: 5, c: 4, streak: 3 });
  assert.deepEqual(merged.days[dayKey], { a: 3, c: 2 });
  assert.deepEqual(merged.totals, { a: 10, c: 8, sessions: 4 });
});

test('mergeStates: local settings and archives win, inputs stay untouched', () => {
  const [set] = load(rawSet());
  const server = C.emptyState(NOW);
  const local = C.emptyState(NOW);

  local.settings = { length: 20, practiceAll: false, theme: 'dark', sound: false };
  server.local['local-set'] = Object.assign(C.cloneSet(set), { id: 'local-set' });
  local.local['local-set'] = Object.assign(C.cloneSet(set), { id: 'local-set', title: 'Local Wins' });
  server.archived[set.id] = Object.assign(C.cloneSet(set), { archivedAt: NOW, title: 'Server Copy' });
  local.archived[set.id] = Object.assign(C.cloneSet(set), { archivedAt: NOW, title: 'Local Copy' });

  const serverBefore = clone(server);
  const localBefore = clone(local);
  const merged = C.mergeStates(server, local, NOW + 1);

  assert.deepEqual(merged.settings, local.settings);
  assert.equal(merged.local['local-set'].title, 'Local Wins');
  assert.equal(merged.archived[set.id].title, 'Local Copy');
  assert.deepEqual(server, serverBefore, 'the server input is not mutated');
  assert.deepEqual(local, localBefore, 'the local input is not mutated');
});

test('mergeStates: the result is sanitized so archive invariants hold', () => {
  const [set] = load(rawSet());
  const local = C.emptyState(NOW);
  local.local[set.id] = C.cloneSet(set);
  local.archived[set.id] = Object.assign(C.cloneSet(set), { archivedAt: NOW });
  local.archivedUnits[C.questionKey(set.id, 'u1')] = {
    id: 'u1', title: 'U1', questions: [question({ id: 'q9' })],
    setId: set.id, setTitle: 'Set One', archivedAt: NOW
  };

  const merged = C.mergeStates(C.emptyState(NOW), local, NOW + 1);
  assert.equal(merged.local[set.id], undefined,
    'an archived set is not also active');
  assert.deepEqual(merged.archivedUnits, {},
    'a unit of an archived set is not separately archived');
  assert.equal(merged.created, NOW, 'creation time is the earlier one');
});

/* ------------------------------------------------------ session snapshot */

function sessionFixture() {
  const set = loadSet(rawSet({
    id: 'u1',
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  const picked = C.selectSession(state, set.id, C.questionsOf(set), {
    mode: 'practice', length: 2, rng: seqRng([0.1, 0.2]), now: NOW
  });
  const session = {
    cfg: { setId: set.id, unitId: '', mode: 'practice', length: 2 },
    set: set,
    questions: picked,
    index: 1,
    results: [{
      index: 0,
      questionId: picked[0].id,
      question: picked[0],
      chosen: 'B',
      expected: 'B',
      correct: true,
      coin: 'new',
      pointsBefore: 0,
      pointsAfter: 80,
      pointsDelta: 80,
      boxBefore: 0,
      boxAfter: 1,
      streak: 1
    }],
    selected: null,
    excluded: {},
    checked: false,
    elapsed: 5000,
    runningSince: null
  };
  return { set: set, session: session, snapshot: C.makeSessionSnapshot(session, 6500) };
}

test('makeSessionSnapshot/restoreSessionSnapshot: a session round-trips', () => {
  const { set, session, snapshot } = sessionFixture();

  assert.equal(snapshot.v, 1);
  assert.deepEqual(snapshot.cfg, { setId: set.id, unitId: '', mode: 'practice', length: 2 });
  assert.deepEqual(snapshot.ids, session.questions.map((q) => q.id));
  assert.equal(snapshot.elapsed, 6500);
  assert.equal(snapshot.checked, false);
  assert.equal(snapshot.results[0].questionId, snapshot.ids[0]);

  const restored = C.restoreSessionSnapshot(snapshot, set);
  assert.ok(restored);
  assert.deepEqual(restored.cfg, snapshot.cfg);
  assert.equal(restored.set, set);
  assert.deepEqual(restored.questions.map((q) => q.id), snapshot.ids);
  assert.equal(restored.index, 1);
  assert.equal(restored.results.length, 1);
  assert.equal(restored.results[0].question.id, snapshot.ids[0]);
  assert.equal(restored.results[0].coin, 'new');
  assert.deepEqual(restored.excluded, {});
  assert.equal(restored.checked, false);
  assert.equal(restored.elapsed, 6500);
  assert.equal(restored.runningSince, null);

  const withExcluded = C.makeSessionSnapshot(
    Object.assign({}, session, { excluded: { 2: true, 0: true, 3: false } }), 0);
  assert.deepEqual(withExcluded.excluded, [0, 2], 'truthy keys only, sorted');

  const unitSnapshot = C.makeSessionSnapshot(
    Object.assign({}, session, { cfg: { setId: set.id, unitId: 'u1', mode: 'retry', length: 2 } }), 1);
  assert.ok(C.restoreSessionSnapshot(unitSnapshot, set), 'a valid unit id resolves');
  assert.equal(C.restoreSessionSnapshot(Object.assign({}, unitSnapshot, {
    cfg: Object.assign({}, unitSnapshot.cfg, { unitId: 'nope' })
  }), set), null, 'a missing unit is rejected');
});

test('restoreSessionSnapshot: malformed payloads are rejected', () => {
  const { set, session, snapshot } = sessionFixture();
  const bad = (mutate) => {
    const copy = clone(snapshot);
    mutate(copy);
    return C.restoreSessionSnapshot(copy, set);
  };

  assert.equal(C.restoreSessionSnapshot(null, set), null);
  assert.equal(C.restoreSessionSnapshot([], set), null);
  assert.equal(C.restoreSessionSnapshot(snapshot, null), null);

  assert.equal(bad((c) => { c.cfg = null; }), null);
  assert.equal(bad((c) => { c.cfg.setId = ''; }), null);
  assert.equal(bad((c) => { c.cfg.mode = 'bogus'; }), null);
  assert.equal(bad((c) => { c.cfg.length = 0; }), null);
  assert.equal(bad((c) => { c.cfg.length = 51; }), null);
  assert.equal(bad((c) => { c.cfg.length = 1.5; }), null);
  assert.equal(bad((c) => { c.cfg.unitId = 5; }), null);

  assert.equal(bad((c) => { c.ids = [c.ids[0], c.ids[0]]; }), null, 'duplicate ids');
  assert.equal(bad((c) => { c.ids[0] = 5; }), null, 'non-string id');
  assert.equal(bad((c) => { c.ids[0] = 'not-in-set'; }), null, 'unknown id');

  assert.equal(bad((c) => { c.index = c.ids.length + 1; }), null, 'index past the ids');
  assert.equal(bad((c) => { c.index = 0.5; }), null);
  assert.equal(bad((c) => { c.elapsed = -1; }), null);
  assert.equal(bad((c) => { c.elapsed = 'soon'; }), null);
  assert.equal(bad((c) => { c.checked = 1; }), null);
  assert.equal(bad((c) => { c.results = 'nope'; }), null);

  assert.equal(bad((c) => { c.results[0].questionId = 'wrong'; }), null);
  assert.equal(bad((c) => { c.results[0].index = 99; }), null);
  assert.equal(bad((c) => { c.results.push(clone(c.results[0])); }), null,
    'duplicate result index');
  assert.equal(bad((c) => { delete c.results[0].pointsAfter; }), null);
  assert.equal(bad((c) => { c.results[0].coin = 'jackpot'; }), null);
  assert.equal(bad((c) => { c.results[0].chosen = 2; }), null);

  assert.equal(bad((c) => { c.checked = true; c.index = 0; c.results = []; }), null,
    'a checked cursor with no graded record');
  assert.equal(bad((c) => {
    c.selected = C.choicesFor(session.questions[c.index === 0 ? 0 : 1]).length;
  }), null, 'a selected choice past the list');
  assert.equal(bad((c) => { c.selected = -1; }), null);

  assert.equal(bad((c) => { c.excluded = [1.5]; }), null);
  assert.equal(bad((c) => { c.excluded = [-1]; }), null);
  assert.equal(bad((c) => { c.excluded = [1, '2']; }), null);
});

/* --------------------------------------------------- stats consolidation */

test('statsFromRows: matches overallStats and the dead fields are gone', () => {
  const [set] = load(rawSet({
    questions: [question({ id: 'q1' }), question({ id: 'q2' })]
  }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.questions[1], 0, NOW);
  C.applyAnswer(state, set.id, set.questions[1], 1, NOW + 1000);

  const rows = C.allSetStats(state, [set], NOW + 2000);
  assert.deepEqual(C.statsFromRows(state, rows, NOW + 2000),
    C.overallStats(state, [set], NOW + 2000));

  const row = rows[0];
  assert.equal(row.correct, undefined, 'setStats.correct is gone');
  assert.equal(row.unitRows[0].correct, undefined, 'unitStats.correct is gone');
  assert.equal(row.unitRows[0].coverage, undefined, 'unitStats.coverage is gone');
  assert.equal(row.unitRows[0].unseen, undefined, 'unitStats.unseen is gone');

  const answer = C.applyAnswer(state, set.id, set.questions[0], 1, NOW + 3000);
  assert.equal(answer.firstCorrect, undefined, 'applyAnswer.firstCorrect is gone');
});

/* ---------------------------------------------------------- DST buckets */

test('activity/streak: local days survive DST transitions', { skip: process.platform === 'win32' }, () => {
  const corePath = path.resolve(__dirname, '..', 'app', 'core.js');
  const script = `
    const C = require(${JSON.stringify(corePath)});
    const activityState = C.emptyState(0);
    ['2026-03-05','2026-03-06','2026-03-07','2026-03-08','2026-03-09'].forEach(function (key) {
      activityState.days[key] = { a: 1, c: 1 };
    });
    const streakState = C.emptyState(0);
    streakState.days['2026-03-08'] = { a: 1, c: 1 };
    streakState.days['2026-03-09'] = { a: 1, c: 1 };
    const springNow = new Date(2026, 2, 9, 0, 30).getTime();
    const fallNow = new Date(2026, 10, 2, 0, 30).getTime();
    console.log(JSON.stringify({
      spring: C.activity(activityState, 5, springNow).map(function (row) { return row.date; }),
      streak: C.streak(streakState, springNow),
      fall: C.activity(activityState, 5, fallNow).map(function (row) { return row.date; })
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { TZ: 'America/New_York' }),
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);

  const out = JSON.parse(child.stdout);
  assert.deepEqual(out.spring,
    ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'],
    'the spring-forward date is neither skipped nor repeated');
  assert.equal(out.streak, 2, 'Mar 8 and Mar 9 count as two consecutive days');
  assert.deepEqual(out.fall,
    ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
    'the fall-back window has no duplicate local keys');
  assert.equal(new Set(out.fall).size, out.fall.length);
});

test('deleteQuestion: hides a question from practice, mastery and stats', () => {
  const set = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' }), question({ id: 'q2' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q3' })] })
  );
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW);
  C.deleteQuestion(state, set.id, 'q2', NOW + 1);

  assert.equal(C.isDeleted(state, set.id, 'q2'), true);
  const active = C.activeSets(state, [set]);
  assert.deepEqual(C.questionsOf(active[0]).map((q) => q.id), ['q1', 'q3']);
  assert.equal(C.masteryOf(state, set.id, C.questionsOf(active[0])), 40);
  assert.equal(C.allSetStats(state, C.allSets(state, [set]), NOW + 2)[0].total, 2);
  assert.deepEqual(C.questionsOf(C.findSet(state, [set], set.id)).map((q) => q.id), ['q1', 'q3']);

  const browse = C.findBrowseSet(state, [set], set.id);
  assert.deepEqual(C.questionsOf(browse).map((q) => q.id), ['q1', 'q2', 'q3'],
    'the browser still shows the deleted question');
  assert.deepEqual(C.deletedQuestions(state, C.browseSets(state, [set])).map((row) => row.q.id),
    ['q2']);

  C.restoreQuestion(state, set.id, 'q2', NOW + 3);
  assert.equal(C.isDeleted(state, set.id, 'q2'), false);
  assert.deepEqual(C.questionsOf(C.activeSets(state, [set])[0]).map((q) => q.id),
    ['q1', 'q2', 'q3']);
});

test('deleteQuestion: a unit or set with every question deleted leaves the list', () => {
  const set = loadSet(
    rawSet({ id: 'u1', title: 'Unit One', questions: [question({ id: 'q1' })] }),
    rawSet({ id: 'u2', title: 'Unit Two', questions: [question({ id: 'q2' })] })
  );
  const state = C.emptyState(NOW);
  C.deleteQuestion(state, set.id, 'q1', NOW);
  assert.deepEqual(C.activeSets(state, [set])[0].units.map((unit) => unit.id), ['u2']);
  C.deleteQuestion(state, set.id, 'q2', NOW + 1);
  assert.deepEqual(C.activeSets(state, [set]), []);
  assert.deepEqual(C.allSets(state, [set]), []);
  assert.equal(C.browseSets(state, [set]).length, 1);
});

test('deleteQuestion: an archived set leaves its deleted questions out', () => {
  const set = loadSet(rawSet({ questions: [question({ id: 'q1' }), question({ id: 'q2' })] }));
  const state = C.emptyState(NOW);
  C.deleteQuestion(state, set.id, 'q1', NOW);
  C.archiveSet(state, set, NOW + 1);
  const found = C.findSet(state, [set], set.id);
  assert.deepEqual(C.questionsOf(found).map((q) => q.id), ['q2']);
  assert.equal(found.kind, 'set');
  assert.deepEqual(C.questionsOf(C.findBrowseSet(state, [set], set.id)).map((q) => q.id),
    ['q1', 'q2']);
  assert.equal(C.allSetStats(state, C.allSets(state, [set]), NOW + 2)[0].total, 1);
});

test('deleted marks: sanitized, and a merge keeps the later decision', () => {
  const key = C.questionKey('set-1', 'q1');
  const raw = C.emptyState(NOW);
  raw.deleted = { [key]: { on: true, at: NOW }, bad: { on: 'yes' }, worse: null };
  assert.deepEqual(C.sanitizeState(raw, NOW).deleted, { [key]: { on: true, at: NOW } });

  const server = C.emptyState(NOW);
  const local = C.emptyState(NOW);
  C.deleteQuestion(server, 'set-1', 'q1', NOW);
  C.restoreQuestion(local, 'set-1', 'q1', NOW + 5);
  assert.equal(C.isDeleted(C.mergeStates(server, local, NOW + 6), 'set-1', 'q1'), false,
    'a newer restore is not undone by the older delete');
  assert.equal(C.isDeleted(C.mergeStates(local, server, NOW + 6), 'set-1', 'q1'), false);

  C.deleteQuestion(server, 'set-1', 'q2', NOW + 9);
  assert.equal(C.isDeleted(C.mergeStates(server, local, NOW + 10), 'set-1', 'q2'), true,
    'a delete only one side knows about survives');
});

test('resetQuestionProgress: forgets one question and keeps its neighbours', () => {
  const set = loadSet(rawSet({ questions: [question({ id: 'q1' }), question({ id: 'q2' })] }));
  const state = C.emptyState(NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[0], 1, NOW);
  C.applyAnswer(state, set.id, set.units[0].questions[1], 1, NOW);
  assert.equal(C.resetQuestionProgress(state, set.id, 'q1', NOW + 1), true);
  assert.equal(state.q[C.questionKey(set.id, 'q1')], undefined);
  assert.ok(state.q[C.questionKey(set.id, 'q2')]);
  assert.equal(C.resetQuestionProgress(state, set.id, 'q1', NOW + 2), false);
});
