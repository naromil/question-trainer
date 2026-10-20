/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 naromil
 *
 * Question Trainer - pure logic.
 *
 * No DOM, no storage: everything here is a plain function over the state
 * object so it can be unit tested in node (tools/test_core.js) and reused by
 * app/app.js in the browser. Loaded as a classic script tag, so it publishes
 * `QTCore` on the global object (and `module.exports` under node).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QTCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var STATE_VERSION = 1;
  var STATE_APP = 'question-trainer';
  var SESSION_LENGTHS = [5, 10, 15, 20, 30, 50];
  var DEFAULT_SESSION_LENGTH = 10;
  /* Lengths offered by older versions are still honoured on import, so an
   * existing export does not silently change its session size. */
  var LEGACY_SESSION_LENGTHS = [4, 8, 12];

  /* ------------------------------------------------------------------ *
   * Mastery
   *
   * Per set the trainer keeps a point total in [0, 100]. A question answered
   * correctly for the first time is worth the most; repeats are worth less
   * (you already knew it); a miss costs points, so mastery decays if a set
   * goes rusty.
   * ------------------------------------------------------------------ */
  var MASTERY = {
    firstCorrect: 12,
    repeatCorrect: 5,
    wrong: -8,
    cap: 100,
    tiers: [
      { min: 85, key: 'mastered', label: 'Mastered' },
      { min: 50, key: 'proficient', label: 'Proficient' },
      { min: 1, key: 'familiar', label: 'Familiar' },
      { min: 0, key: 'new', label: 'Not started' }
    ]
  };

  /* Spaced repetition: Leitner boxes. `box` is the index into this table and
   * the value is the gap until the question is due again. Box 0 means "new, or
   * lapsed and due right now"; each correct answer promotes the question one
   * box, so the gaps become 1, 3, 7, 21 days. A miss sends it back to box 0. */
  var SRS_INTERVALS_DAYS = [0, 1, 3, 7, 21];
  var SRS_LAST_BOX = SRS_INTERVALS_DAYS.length - 1;

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  /* Stored lengths are normally one of SESSION_LENGTHS, but exports from older
   * versions may still carry 4, 8 or 12. Anything else falls back to 10. */
  function sanitizeLength(value) {
    var length = value | 0;
    if (SESSION_LENGTHS.indexOf(length) >= 0 ||
        LEGACY_SESSION_LENGTHS.indexOf(length) >= 0) {
      return length;
    }
    return DEFAULT_SESSION_LENGTH;
  }

  /* How many questions one practice session should serve. With the practice-all
   * switch on (the default), a set of 30 or fewer questions is served whole;
   * larger sets, and the switch turned off, use the chosen session length.
   * Review never calls this: it only serves what is due. */
  function sessionLength(settings, questionCount) {
    settings = settings && typeof settings === 'object' ? settings : {};
    var count = Number(questionCount);
    if (!isFinite(count) || count <= 0) return 0;
    count = Math.floor(count);
    if (!count) return 0;
    if (settings.practiceAll !== false && count <= 30) return count;
    return sanitizeLength(settings.length);
  }

  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* Choice labels are derived from the index: 0 -> A, 25 -> Z, 26 -> AA. */
  function letterFor(index) {
    var n = (index | 0) + 1;
    var out = '';
    while (n > 0) {
      var rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  /* Progress is keyed by set plus question id, so two sets may reuse a
   * question id without sharing history. Encoding keeps the key unambiguous
   * even when an id contains a slash or a colon. */
  function questionKey(setId, questionId) {
    return encodeURIComponent(String(setId)) + '/' + encodeURIComponent(String(questionId));
  }

  /* ------------------------------------------------------------------ *
   * Fixed JSON format
   *
   * questions/sets.json:
   *   { "sets": [ { "id", "title", "description"?, "questions": [
   *       { "id", "question", "choices": ["..."], "answer": <0-based index>,
   *         "passage"?, "explanation"?, "explanations"?: ["..." | null] }
   *   ] } ] }
   *
   * One bad set is reported and skipped; the rest of the file still loads.
   * ------------------------------------------------------------------ */
  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeQuestion(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('question ' + (index + 1) + ' must be an object');
    }
    var id = text(raw.id);
    if (!id) throw new Error('question ' + (index + 1) + ' needs a non-empty string "id"');

    var prompt = text(raw.question);
    if (!prompt) throw new Error('question "' + id + '" needs a non-empty "question"');

    if (!Array.isArray(raw.choices) || raw.choices.length < 2) {
      throw new Error('question "' + id + '" needs at least two "choices"');
    }
    var choices = raw.choices.map(function (choice, i) {
      var label = text(choice);
      if (!label) throw new Error('question "' + id + '" choice ' + (i + 1) + ' must be a non-empty string');
      return label;
    });

    var answer = raw.answer;
    if (typeof answer !== 'number' || !isFinite(answer) || Math.floor(answer) !== answer ||
        answer < 0 || answer >= choices.length) {
      throw new Error('question "' + id + '" needs "answer" as a 0-based choice index ' +
        'between 0 and ' + (choices.length - 1));
    }

    var explanations = null;
    if (raw.explanations != null) {
      if (!Array.isArray(raw.explanations) || raw.explanations.length !== choices.length) {
        throw new Error('question "' + id + '" "explanations" must be an array with one entry ' +
          'per choice');
      }
      explanations = raw.explanations.map(function (value, i) {
        if (value == null) return '';
        if (typeof value !== 'string') {
          throw new Error('question "' + id + '" explanation ' + (i + 1) +
            ' must be a string or null');
        }
        return value.trim();
      });
    }

    return {
      id: id,
      passage: text(raw.passage),
      question: prompt,
      choices: choices,
      answer: answer,
      explanation: text(raw.explanation),
      explanations: explanations
    };
  }

  function normalizeSet(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('set ' + (index + 1) + ' must be an object');
    }
    var id = text(raw.id);
    if (!id) throw new Error('set ' + (index + 1) + ' needs a non-empty string "id"');
    var title = text(raw.title);
    if (!title) throw new Error('set "' + id + '" needs a non-empty "title"');
    if (!Array.isArray(raw.questions) || !raw.questions.length) {
      throw new Error('set "' + id + '" needs a non-empty "questions" array');
    }

    var seen = {};
    var questions = raw.questions.map(function (question, i) {
      var normalized = normalizeQuestion(question, i);
      if (seen[normalized.id]) {
        throw new Error('set "' + id + '" has duplicate question id "' + normalized.id + '"');
      }
      seen[normalized.id] = true;
      return normalized;
    });

    return {
      id: id,
      title: title,
      description: text(raw.description),
      questions: questions
    };
  }

  function normalizeBank(raw) {
    var result = { sets: [], errors: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.sets)) {
      result.errors.push({ message: 'The file must be an object with a "sets" array.' });
      return result;
    }
    var seen = {};
    raw.sets.forEach(function (rawSet, index) {
      try {
        var set = normalizeSet(rawSet, index);
        if (seen[set.id]) throw new Error('duplicate set id "' + set.id + '"');
        seen[set.id] = true;
        result.sets.push(set);
      } catch (err) {
        result.errors.push({ index: index, message: 'Set ' + (index + 1) + ': ' + err.message });
      }
    });
    return result;
  }

  function cloneSet(set) {
    return {
      id: set.id,
      title: set.title,
      description: set.description || '',
      questions: set.questions.map(function (question) {
        return {
          id: question.id,
          passage: question.passage,
          question: question.question,
          choices: question.choices.slice(),
          answer: question.answer,
          explanation: question.explanation,
          explanations: question.explanations ? question.explanations.slice() : null
        };
      })
    };
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  function emptyState(now) {
    now = now || Date.now();
    return {
      app: STATE_APP,
      v: STATE_VERSION,
      created: now,
      updated: now,
      q: {},
      sets: {},
      local: {},
      archived: {},
      days: {},
      settings: {
        length: DEFAULT_SESSION_LENGTH,
        practiceAll: true,
        theme: 'auto',
        sound: true
      },
      totals: { a: 0, c: 0, sessions: 0 }
    };
  }

  function sanitizeArchived(entry, now) {
    var set = normalizeSet(entry, 0);
    return {
      id: set.id,
      title: set.title,
      description: set.description,
      questions: set.questions,
      archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : now
    };
  }

  /* Accepts anything (old export, truncated JSON, hand-edited file) and
   * returns a state the rest of the app can rely on. */
  function sanitizeState(raw, now) {
    now = now || Date.now();
    var state = emptyState(now);
    if (!raw || typeof raw !== 'object' || raw.app !== STATE_APP || raw.v !== STATE_VERSION) {
      return state;
    }

    if (raw.q && typeof raw.q === 'object') {
      Object.keys(raw.q).forEach(function (key) {
        var rec = raw.q[key];
        if (!rec || typeof rec !== 'object') return;
        var attempts = Math.max(0, rec.a | 0);
        if (!attempts) return;
        var correct = clamp(rec.c | 0, 0, attempts);
        state.q[key] = {
          a: attempts,
          c: correct,
          /* Exports predating `f` lose the first answer as soon as a question
           * has both a right and a wrong attempt. What survives: an all-correct
           * record (c === a) was right from the start, and a mixed or all-wrong
           * one cannot be assumed correct, so it counts as not-first-try. */
          f: rec.f === 0 || rec.f === 1 ? rec.f : (correct === attempts ? 1 : 0),
          box: clamp(rec.box | 0, 0, SRS_LAST_BOX),
          due: typeof rec.due === 'number' ? rec.due : now,
          last: typeof rec.last === 'number' ? rec.last : now
        };
      });
    }

    if (raw.sets && typeof raw.sets === 'object') {
      Object.keys(raw.sets).forEach(function (setId) {
        var rec = raw.sets[setId];
        if (!rec || typeof rec !== 'object') return;
        var attempts = Math.max(0, rec.a | 0);
        state.sets[setId] = {
          points: clamp(Math.round(rec.points) || 0, 0, MASTERY.cap),
          a: attempts,
          c: clamp(rec.c | 0, 0, attempts),
          streak: Math.max(0, rec.streak | 0)
        };
      });
    }

    if (raw.local && typeof raw.local === 'object') {
      Object.keys(raw.local).forEach(function (key) {
        try {
          var set = normalizeSet(raw.local[key], 0);
          state.local[set.id] = set;
        } catch (err) { /* drop an unusable restored copy */ }
      });
    }

    if (raw.archived && typeof raw.archived === 'object') {
      Object.keys(raw.archived).forEach(function (key) {
        try {
          var archived = sanitizeArchived(raw.archived[key], now);
          state.archived[archived.id] = archived;
        } catch (err) { /* drop an unusable archive entry */ }
      });
    }
    /* An archived set must never also be active. */
    Object.keys(state.local).forEach(function (id) {
      if (state.archived[id]) delete state.local[id];
    });

    if (raw.days && typeof raw.days === 'object') {
      Object.keys(raw.days).forEach(function (key) {
        var rec = raw.days[key];
        if (!rec || typeof rec !== 'object') return;
        var answered = Math.max(0, rec.a | 0);
        if (!answered) return;
        state.days[key] = { a: answered, c: clamp(rec.c | 0, 0, answered) };
      });
    }

    if (raw.settings && typeof raw.settings === 'object') {
      state.settings.length = sanitizeLength(raw.settings.length);
      /* Exports predating the switch practised the whole set, so they default
       * on; an explicit false is kept. */
      state.settings.practiceAll = raw.settings.practiceAll !== false;
      state.settings.theme = ['auto', 'light', 'dark'].indexOf(raw.settings.theme) >= 0
        ? raw.settings.theme
        : 'auto';
      /* Pre-sound exports have no such key and should come back audible. */
      state.settings.sound = raw.settings.sound !== false;
    }

    if (raw.totals && typeof raw.totals === 'object') {
      var answered = Math.max(0, raw.totals.a | 0);
      state.totals = {
        a: answered,
        c: clamp(raw.totals.c | 0, 0, answered),
        sessions: Math.max(0, raw.totals.sessions | 0)
      };
    }
    if (typeof raw.created === 'number') state.created = raw.created;
    if (typeof raw.updated === 'number') state.updated = raw.updated;
    return state;
  }

  function recordFor(state, setId, questionId) {
    return state.q[questionKey(setId, questionId)] || null;
  }

  /* ------------------------------------------------------------------ *
   * Grading
   * ------------------------------------------------------------------ */
  function applyAnswer(state, setId, question, choiceIndex, now) {
    now = now || Date.now();
    var key = questionKey(setId, question.id);
    var correct = choiceIndex === question.answer;
    var chosen = letterFor(choiceIndex);
    var expected = letterFor(question.answer);
    var before = state.q[key] || null;
    var hadCorrectBefore = !!(before && before.c > 0);

    var boxBefore = before ? before.box : 0;
    var boxAfter = correct ? clamp(boxBefore + 1, 1, SRS_LAST_BOX) : 0;
    var rec = {
      a: (before ? before.a : 0) + 1,
      c: (before ? before.c : 0) + (correct ? 1 : 0),
      /* f: 1 when this question's very first answer was right, else 0. Stored
       * rather than derived: later retries inflate `c`, so "ever correct" is a
       * different (wrong) thing from "right on the first try". */
      f: before ? (before.f ? 1 : 0) : (correct ? 1 : 0),
      box: boxAfter,
      due: now + SRS_INTERVALS_DAYS[boxAfter] * DAY_MS,
      last: now
    };
    state.q[key] = rec;

    var set = state.sets[setId] || { points: 0, a: 0, c: 0, streak: 0 };
    var pointsBefore = set.points;
    var delta = correct
      ? (hadCorrectBefore ? MASTERY.repeatCorrect : MASTERY.firstCorrect)
      : MASTERY.wrong;
    set.points = clamp(set.points + delta, 0, MASTERY.cap);
    set.a += 1;
    set.c += correct ? 1 : 0;
    set.streak = correct ? set.streak + 1 : 0;
    state.sets[setId] = set;

    var key2 = dayKey(now);
    var day = state.days[key2] || { a: 0, c: 0 };
    day.a += 1;
    day.c += correct ? 1 : 0;
    state.days[key2] = day;

    state.totals.a += 1;
    if (correct) state.totals.c += 1;
    state.updated = now;

    return {
      correct: correct,
      expected: expected,
      chosen: chosen,
      pointsBefore: pointsBefore,
      pointsAfter: set.points,
      pointsDelta: set.points - pointsBefore,
      coin: correct ? (hadCorrectBefore ? 'repeat' : 'new') : 'miss',
      boxBefore: boxBefore,
      boxAfter: boxAfter,
      firstCorrect: correct && !hadCorrectBefore
    };
  }

  function tierOf(points, attempts) {
    if (!attempts) return MASTERY.tiers[MASTERY.tiers.length - 1];
    for (var i = 0; i < MASTERY.tiers.length; i++) {
      if (points >= MASTERY.tiers[i].min) return MASTERY.tiers[i];
    }
    return MASTERY.tiers[MASTERY.tiers.length - 1];
  }

  function masteryOf(state, setId) {
    var rec = state.sets[setId];
    return rec ? rec.points : 0;
  }

  /* ------------------------------------------------------------------ *
   * Session selection
   * ------------------------------------------------------------------ */
  function dueQuestions(state, setId, questions, now) {
    now = now || Date.now();
    return questions.filter(function (question) {
      var rec = recordFor(state, setId, question.id);
      return !!rec && rec.a > 0 && rec.due <= now;
    });
  }

  /* Decorate with a random tiebreak so equal-priority questions come in a
   * different order each session (deterministic when `rng` is provided). */
  function decorate(list, state, setId, rng) {
    return list.map(function (question) {
      return { q: question, r: rng() };
    }).sort(function (x, y) {
      var rx = recordFor(state, setId, x.q.id);
      var ry = recordFor(state, setId, y.q.id);
      var bx = (rx ? rx.box : 0) - (ry ? ry.box : 0);
      if (bx) return bx;
      var ax = (rx ? rx.a : 0) - (ry ? ry.a : 0);
      if (ax) return ax;
      var lx = (rx ? rx.last : 0) - (ry ? ry.last : 0);
      if (lx) return lx;
      return x.r - y.r;
    }).map(function (entry) { return entry.q; });
  }

  /**
   * Pick the questions for one session inside one set.
   *
   * options:
   *   mode     - 'practice' (breadth-first) or 'review' (spaced repetition)
   *   length   - number of questions
   *   exclude  - array/Set of question ids to skip (e.g. already done today)
   *   rng      - optional () => [0,1), injectable for tests
   */
  function selectSession(state, setId, questions, options) {
    options = options || {};
    var now = typeof options.now === 'number' ? options.now : Date.now();
    var rng = options.rng || Math.random;
    var length = options.length || 4;
    var mode = options.mode || 'practice';
    var skip = {};
    (options.exclude || []).forEach(function (id) { skip[id] = true; });

    var pool = questions.filter(function (question) {
      return !skip[question.id];
    });
    var limit = Math.min(length, pool.length);
    if (!limit) return [];

    if (mode === 'review') {
      /* Due-only: a review session never pads itself with questions the
       * schedule does not ask for, so it may be shorter than `length`. */
      return dueQuestions(state, setId, pool, now).sort(function (a, b) {
        return recordFor(state, setId, a.id).due - recordFor(state, setId, b.id).due;
      }).slice(0, limit);
    }

    return decorate(pool, state, setId, rng).slice(0, limit);
  }

  /* ------------------------------------------------------------------ *
   * Per-set activity and archive
   * ------------------------------------------------------------------ */
  function setStats(state, set, now) {
    now = now || Date.now();
    var row = {
      set: set,
      id: set.id,
      title: set.title,
      description: set.description,
      total: set.questions.length,
      attempted: 0,
      correct: 0,
      correctFirstTry: 0,
      due: 0,
      points: masteryOf(state, set.id),
      streak: (state.sets[set.id] || {}).streak || 0
    };
    set.questions.forEach(function (question) {
      var rec = recordFor(state, set.id, question.id);
      if (!rec || rec.a <= 0) return;
      row.attempted += 1;
      row.correct += rec.c;
      row.correctFirstTry += rec.f;
      if (rec.due <= now) row.due += 1;
    });
    row.accuracy = row.attempted
      ? Math.round((row.correctFirstTry / row.attempted) * 100)
      : 0;
    row.tier = tierOf(row.points, row.attempted);
    row.unseen = row.total - row.attempted;
    row.archived = !!set.archivedAt;
    return row;
  }

  function allSetStats(state, sets, now) {
    return sets.map(function (set) { return setStats(state, set, now); });
  }

  function overallStats(state, sets, now) {
    now = now || Date.now();
    var rows = allSetStats(state, sets, now);
    var attempted = 0;
    var firstTry = 0;
    rows.forEach(function (row) {
      attempted += row.attempted;
      firstTry += row.correctFirstTry;
    });
    return {
      answered: state.totals.a,
      correct: state.totals.c,
      /* Share of questions whose first answer was right — not the share of all
       * answers that were right, which retries drag down. */
      accuracy: attempted ? Math.round((firstTry / attempted) * 100) : 0,
      sessions: state.totals.sessions,
      mastered: rows.filter(function (row) { return row.tier.key === 'mastered'; }).length,
      proficient: rows.filter(function (row) { return row.tier.key === 'proficient'; }).length,
      setsStarted: rows.filter(function (row) { return row.attempted > 0; }).length,
      setCount: rows.length,
      due: rows.reduce(function (n, row) { return n + row.due; }, 0),
      bankSize: rows.reduce(function (n, row) { return n + row.total; }, 0),
      seen: attempted,
      streak: streak(state, now)
    };
  }

  function activity(state, days, now) {
    now = typeof now === 'number' ? now : Date.now();
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var key = dayKey(now - i * DAY_MS);
      var rec = state.days[key] || { a: 0, c: 0 };
      out.push({ date: key, a: rec.a, c: rec.c });
    }
    return out;
  }

  /* Consecutive days with at least one answer, counting back from today. A
   * day with no answers yet does not break the streak until it is over. */
  function streak(state, now) {
    now = typeof now === 'number' ? now : Date.now();
    var count = 0;
    var offset = state.days[dayKey(now)] && state.days[dayKey(now)].a > 0 ? 0 : 1;
    for (var i = offset; i < 400; i++) {
      var rec = state.days[dayKey(now - i * DAY_MS)];
      if (rec && rec.a > 0) count++;
      else break;
    }
    return count;
  }

  /* Most-missed questions, for the progress screen. */
  function troubleSpots(state, sets, limit) {
    var rows = [];
    sets.forEach(function (set) {
      set.questions.forEach(function (question) {
        var rec = recordFor(state, set.id, question.id);
        if (!rec || rec.a < 2) return;
        var wrong = rec.a - rec.c;
        if (!wrong) return;
        rows.push({
          set: set,
          q: question,
          attempts: rec.a,
          correct: rec.c,
          wrong: wrong
        });
      });
    });
    rows.sort(function (a, b) {
      return b.wrong - a.wrong || b.attempts - a.attempts;
    });
    return rows.slice(0, limit || 10);
  }

  function archiveSet(state, set, now) {
    now = now || Date.now();
    var snapshot = cloneSet(set);
    snapshot.archivedAt = now;
    state.archived[set.id] = snapshot;
    delete state.local[set.id];
    state.updated = now;
    return snapshot;
  }

  /* Restore an archived set. If the source file no longer lists it, keep the
   * archived copy as a browser-local set so restore is not a dead end. */
  function restoreSet(state, setId, sourceSet, now) {
    now = now || Date.now();
    var snapshot = state.archived[setId];
    if (!snapshot) return null;
    delete state.archived[setId];
    if (!sourceSet) state.local[setId] = cloneSet(snapshot);
    state.updated = now;
    return snapshot;
  }

  function activeSets(state, sourceSets) {
    var out = [];
    var seen = {};
    (sourceSets || []).forEach(function (set) {
      if (state.archived[set.id] || seen[set.id]) return;
      seen[set.id] = true;
      out.push(set);
    });
    Object.keys(state.local || {}).forEach(function (id) {
      if (state.archived[id] || seen[id]) return;
      seen[id] = true;
      out.push(state.local[id]);
    });
    return out;
  }

  function archivedSets(state) {
    return Object.keys(state.archived || {}).map(function (id) {
      return state.archived[id];
    }).sort(function (a, b) {
      return (b.archivedAt || 0) - (a.archivedAt || 0);
    });
  }

  function allSets(state, sourceSets) {
    var out = activeSets(state, sourceSets);
    var seen = {};
    out.forEach(function (set) { seen[set.id] = true; });
    archivedSets(state).forEach(function (set) {
      if (seen[set.id]) return;
      seen[set.id] = true;
      out.push(set);
    });
    return out;
  }

  /* A set for a session: active source first, then a restored local copy,
   * then the frozen archived copy. */
  function findSet(state, sourceSets, setId) {
    var sets = activeSets(state, sourceSets);
    for (var i = 0; i < sets.length; i++) {
      if (sets[i].id === setId) return sets[i];
    }
    return (state.archived || {})[setId] || null;
  }

  function dueCount(state, sets, now) {
    return (sets || []).reduce(function (n, set) {
      return n + dueQuestions(state, set.id, set.questions, now).length;
    }, 0);
  }

  return {
    MASTERY: MASTERY,
    SRS_INTERVALS_DAYS: SRS_INTERVALS_DAYS,
    SRS_LAST_BOX: SRS_LAST_BOX,
    STATE_VERSION: STATE_VERSION,
    STATE_APP: STATE_APP,
    SESSION_LENGTHS: SESSION_LENGTHS,
    DEFAULT_SESSION_LENGTH: DEFAULT_SESSION_LENGTH,
    DAY_MS: DAY_MS,
    dayKey: dayKey,
    letterFor: letterFor,
    questionKey: questionKey,
    normalizeBank: normalizeBank,
    normalizeSet: normalizeSet,
    cloneSet: cloneSet,
    emptyState: emptyState,
    sanitizeState: sanitizeState,
    sessionLength: sessionLength,
    applyAnswer: applyAnswer,
    tierOf: tierOf,
    masteryOf: masteryOf,
    dueQuestions: dueQuestions,
    selectSession: selectSession,
    setStats: setStats,
    allSetStats: allSetStats,
    overallStats: overallStats,
    activity: activity,
    streak: streak,
    troubleSpots: troubleSpots,
    archiveSet: archiveSet,
    restoreSet: restoreSet,
    activeSets: activeSets,
    archivedSets: archivedSets,
    allSets: allSets,
    findSet: findSet,
    dueCount: dueCount
  };
});
