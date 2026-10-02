/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 naromil
 * No College Board question content is distributed with this repository; see NOTICE.md.
 *
 * SAT trainer - pure logic.
 *
 * No DOM, no storage: everything here is a plain function over the state
 * object so it can be unit tested in node (tools/test_core.js) and reused by
 * app/app.js in the browser. Loaded as a classic script tag, so it publishes
 * `SATCore` on the global object (and `module.exports` under node).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SATCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var STATE_VERSION = 1;

  /* ------------------------------------------------------------------ *
   * Mastery
   *
   * Per skill the trainer keeps a point total in [0, 100] - the same shape
   * Khan Academy uses. A question answered correctly for the first time is
   * worth the most; repeats are worth less (you already knew it); a miss
   * costs points, so mastery decays if a skill goes rusty.
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

  /* OCR-quality flags that make a question untrustworthy enough to filter. */
  var RISKY_FLAGS = [
    'low-confidence',
    'low-confidence-word',
    'ocr-disagreement',
    'line-repaired',
    'choices-fallback',
    'choices-block-fallback',
    'blank-missing',
    'multiple-blanks'
  ];

  var LETTERS = ['A', 'B', 'C', 'D'];

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function emptyState(now) {
    now = now || Date.now();
    return {
      v: STATE_VERSION,
      created: now,
      updated: now,
      q: {},
      skills: {},
      days: {},
      settings: {
        length: 4,
        excludeFigure: false,
        excludeRisky: false,
        excludeUnderline: false,
        theme: 'auto',
        sound: true
      },
      totals: { a: 0, c: 0, sessions: 0 }
    };
  }

  /* Accepts anything (old export, truncated JSON, hand-edited file) and
   * returns a state the rest of the app can rely on. */
  function sanitizeState(raw, now) {
    var state = emptyState(now);
    if (!raw || typeof raw !== 'object') return state;

    if (raw.q && typeof raw.q === 'object') {
      Object.keys(raw.q).forEach(function (id) {
        var rec = raw.q[id];
        if (!rec || typeof rec !== 'object') return;
        var attempts = Math.max(0, rec.a | 0);
        if (!attempts) return;
        var correct = clamp(rec.c | 0, 0, attempts);
        state.q[id] = {
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

    if (raw.skills && typeof raw.skills === 'object') {
      Object.keys(raw.skills).forEach(function (skill) {
        var rec = raw.skills[skill];
        if (!rec || typeof rec !== 'object') return;
        state.skills[skill] = {
          points: clamp(Math.round(rec.points) || 0, 0, MASTERY.cap),
          a: Math.max(0, rec.a | 0),
          c: Math.max(0, rec.c | 0),
          streak: Math.max(0, rec.streak | 0)
        };
      });
    }

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
      var length = raw.settings.length | 0;
      state.settings.length = [4, 8, 12, 20].indexOf(length) >= 0 ? length : 4;
      state.settings.excludeFigure = !!raw.settings.excludeFigure;
      state.settings.excludeRisky = !!raw.settings.excludeRisky;
      state.settings.excludeUnderline = !!raw.settings.excludeUnderline;
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
    return state;
  }

  function recFor(state, id) {
    return state.q[id] || null;
  }

  /* ------------------------------------------------------------------ *
   * Grading
   * ------------------------------------------------------------------ */
  function applyAnswer(state, question, choiceIndex, now) {
    now = now || Date.now();
    var letter = LETTERS[choiceIndex];
    var correct = letter === question.answer;
    var before = state.q[question.id] || null;
    var hadCorrectBefore = !!(before && before.c > 0);

    var boxBefore = before ? before.box : 0;
    var boxAfter = correct
      ? clamp(boxBefore + 1, 1, SRS_LAST_BOX)
      : 0;
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
    state.q[question.id] = rec;

    var skill = state.skills[question.skill] || { points: 0, a: 0, c: 0, streak: 0 };
    var pointsBefore = skill.points;
    var delta = correct
      ? (hadCorrectBefore ? MASTERY.repeatCorrect : MASTERY.firstCorrect)
      : MASTERY.wrong;
    skill.points = clamp(skill.points + delta, 0, MASTERY.cap);
    skill.a += 1;
    skill.c += correct ? 1 : 0;
    skill.streak = correct ? skill.streak + 1 : 0;
    state.skills[question.skill] = skill;

    var key = dayKey(now);
    var day = state.days[key] || { a: 0, c: 0 };
    day.a += 1;
    day.c += correct ? 1 : 0;
    state.days[key] = day;

    state.totals.a += 1;
    if (correct) state.totals.c += 1;
    state.updated = now;

    return {
      correct: correct,
      expected: question.answer,
      chosen: letter,
      pointsBefore: pointsBefore,
      pointsAfter: skill.points,
      pointsDelta: skill.points - pointsBefore,
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

  /* Which mastery tier a point total is heading towards, for progress bars. */
  function nextTierOf(points) {
    var tiers = MASTERY.tiers;
    for (var i = tiers.length - 1; i >= 0; i--) {
      if (points < tiers[i].min) return tiers[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Rationale parsing
   *
   * Bank rationales have a fixed shape:
   *   "Choice D is the best answer. <why>\n\n
   *    Choice A is incorrect. <why> Choice B is incorrect. <why> ..."
   * so the per-choice explanations can be shown next to the choices. Anything
   * that does not match is kept whole and flagged `parsed: false`.
   * ------------------------------------------------------------------ */
  var BEST_RE = /^Choice ([A-D]) is the best answer\b\.?\s*/;
  var WRONG_RE = /Choice ([A-D]) is incorrect\b\.?\s*/g;

  function parseRationale(text, answerLetter) {
    var parsed = {
      parsed: false,
      best: answerLetter,
      bestText: '',
      wrong: {},
      raw: text || ''
    };
    if (!text) return parsed;

    var blocks = text.split(/\n{2,}/);
    var head = blocks[0].replace(/^\s+/, '');
    var match = BEST_RE.exec(head);
    var rest = blocks.slice(1).join(' ');

    if (match) {
      parsed.best = match[1];
      parsed.bestText = head.slice(match[0].length).trim();
      WRONG_RE.lastIndex = 0;
      var marks = [];
      var m;
      while ((m = WRONG_RE.exec(rest)) !== null) {
        marks.push({ letter: m[1], start: m.index, end: WRONG_RE.lastIndex });
      }
      if (marks.length) {
        marks.forEach(function (mark, i) {
          var stop = i + 1 < marks.length ? marks[i + 1].start : rest.length;
          parsed.wrong[mark.letter] = rest.slice(mark.end, stop).trim();
        });
      }
      parsed.parsed = marks.length === 3 && !!parsed.bestText &&
        parsed.best === answerLetter && !parsed.wrong[answerLetter];
    }
    return parsed;
  }

  /* The explanation for one choice, or '' when there is none. */
  function rationaleFor(parsed, letter) {
    if (!parsed.parsed) return '';
    return letter === parsed.best ? parsed.bestText : (parsed.wrong[letter] || '');
  }

  /* ------------------------------------------------------------------ *
   * Question pool
   * ------------------------------------------------------------------ */
  function flagsOf(question) {
    return question.flags || [];
  }

  function isExcluded(question, filters) {
    if (!filters) return false;
    var flags = flagsOf(question);
    if (filters.excludeFigure && flags.indexOf('figure') >= 0) return true;
    if (filters.excludeUnderline && flags.indexOf('underline') >= 0) return true;
    if (filters.excludeRisky) {
      for (var i = 0; i < RISKY_FLAGS.length; i++) {
        if (flags.indexOf(RISKY_FLAGS[i]) >= 0) return true;
      }
    }
    return false;
  }

  function poolFor(questions, options) {
    var skill = options.skill || null;
    return questions.filter(function (q) {
      if (skill && q.skill !== skill) return false;
      return !isExcluded(q, options.filters);
    });
  }

  function dueAt(state, id) {
    var rec = state.q[id];
    return rec ? rec.due : null;
  }

  function lastSeenAt(state, id) {
    var rec = state.q[id];
    return rec ? rec.last : 0;
  }

  function boxOf(state, id) {
    var rec = state.q[id];
    return rec ? rec.box : 0;
  }

  function attemptsOf(state, id) {
    var rec = state.q[id];
    return rec ? rec.a : 0;
  }

  function masteryOf(state, skill) {
    var rec = state.skills[skill];
    return rec ? rec.points : 0;
  }

  /* Questions that are due for review right now: seen at least once and past
   * their due date. Box 0 items are lapsed, so they are always due. */
  function dueQuestions(state, questions, now) {
    now = now || Date.now();
    return questions.filter(function (q) {
      var rec = state.q[q.id];
      return !!rec && rec.a > 0 && rec.due <= now;
    });
  }

  /* Decorate with a random tiebreak so equal-priority questions come in a
   * different order each session (deterministic when `rng` is provided). */
  function decorate(list, state, rng) {
    return list.map(function (q) {
      return { q: q, r: rng() };
    }).sort(function (x, y) {
      var bx = boxOf(state, x.q.id) - boxOf(state, y.q.id);
      if (bx) return bx;
      var ax = attemptsOf(state, x.q.id) - attemptsOf(state, y.q.id);
      if (ax) return ax;
      var lx = lastSeenAt(state, x.q.id) - lastSeenAt(state, y.q.id);
      if (lx) return lx;
      return x.r - y.r;
    }).map(function (entry) { return entry.q; });
  }

  /**
   * Pick the questions for one session.
   *
   * options:
   *   skill    - skill name, or null/'' for a mixed session
   *   mode     - 'practice' (breadth-first), 'review' (spaced repetition),
   *              'weak' (mix, weakest skills first)
   *   length   - number of questions
   *   filters  - {excludeFigure, excludeUnderline, excludeRisky}
   *   exclude  - array/Set of question ids to skip (e.g. already done today)
   *   rng      - optional () => [0,1), injectable for tests
   */
  function selectSession(state, questions, options) {
    options = options || {};
    var now = typeof options.now === 'number' ? options.now : Date.now();
    var rng = options.rng || Math.random;
    var length = options.length || 4;
    var mode = options.mode || 'practice';
    var skip = {};
    (options.exclude || []).forEach(function (id) { skip[id] = true; });

    var pool = poolFor(questions, options).filter(function (q) {
      return !skip[q.id];
    });
    var limit = Math.min(length, pool.length);
    if (!limit) return [];

    if (mode === 'review') {
      /* Due-only: a review session never pads itself with questions the
       * schedule does not ask for, so it may be shorter than `length`. */
      return dueQuestions(state, pool, now).sort(function (a, b) {
        return dueAt(state, a.id) - dueAt(state, b.id);
      }).slice(0, limit);
    }

    if (mode === 'weak') {
      var skills = skillOrder(questions);
      return decorate(pool, state, rng).sort(function (a, b) {
        var sa = skills.indexOf(a.skill) - skills.indexOf(b.skill);
        return sa || 0;
      }).slice(0, limit);
    }

    return decorate(pool, state, rng).slice(0, limit);
  }

  /* Skill names in the order the question list presents them (already
   * domain-ordered in the generated data). */
  function skillOrder(questions) {
    var out = [];
    questions.forEach(function (q) {
      if (out.indexOf(q.skill) < 0) out.push(q.skill);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Reporting
   * ------------------------------------------------------------------ */
  function skillStats(state, questions, now) {
    now = now || Date.now();
    var rows = {};
    var order = [];
    questions.forEach(function (q) {
      if (!rows[q.skill]) {
        rows[q.skill] = {
          skill: q.skill,
          domain: q.domain,
          total: 0,
          attempted: 0,
          correct: 0,
          correctFirstTry: 0,
          boxed: 0,
          due: 0,
          points: masteryOf(state, q.skill),
          streak: (state.skills[q.skill] || {}).streak || 0
        };
        order.push(q.skill);
      }
      var row = rows[q.skill];
      row.total += 1;
      var rec = state.q[q.id];
      if (rec && rec.a > 0) {
        row.attempted += 1;
        row.correct += rec.c;
        row.correctFirstTry += rec.f;
        row.boxed += 1;
        if (rec.due <= now) row.due += 1;
      }
    });
    return order.map(function (skill) {
      var row = rows[skill];
      row.accuracy = row.attempted
        ? Math.round((row.correctFirstTry / row.attempted) * 100)
        : 0;
      row.tier = tierOf(row.points, row.attempted);
      row.unseen = row.total - row.attempted;
      return row;
    });
  }

  function overallStats(state, questions, now) {
    now = now || Date.now();
    var stats = skillStats(state, questions, now);
    var answered = state.totals.a;
    var rows = stats.filter(function (row) { return row.attempted > 0; });
    var attempted = 0;
    var firstTry = 0;
    rows.forEach(function (row) {
      attempted += row.attempted;
      firstTry += row.correctFirstTry;
    });
    return {
      answered: answered,
      correct: state.totals.c,
      /* Share of questions whose first answer was right — not the share of all
       * answers that were right, which retries drag down. */
      accuracy: attempted ? Math.round((firstTry / attempted) * 100) : 0,
      sessions: state.totals.sessions,
      mastered: stats.filter(function (r) { return r.tier.key === 'mastered'; }).length,
      proficient: stats.filter(function (r) { return r.tier.key === 'proficient'; }).length,
      skillsStarted: rows.length,
      skillCount: stats.length,
      due: dueQuestions(state, questions, now).length,
      bankSize: questions.length,
      seen: Object.keys(state.q).length,
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

  /* Most-missed questions, for the stats screen. */
  function troubleSpots(state, questions, limit) {
    var rows = [];
    questions.forEach(function (q) {
      var rec = state.q[q.id];
      if (!rec || rec.a < 2) return;
      var wrong = rec.a - rec.c;
      if (!wrong) return;
      rows.push({ q: q, attempts: rec.a, correct: rec.c, wrong: wrong });
    });
    rows.sort(function (a, b) {
      return b.wrong - a.wrong || b.attempts - a.attempts;
    });
    return rows.slice(0, limit || 10);
  }

  return {
    LETTERS: LETTERS,
    MASTERY: MASTERY,
    SRS_INTERVALS_DAYS: SRS_INTERVALS_DAYS,
    SRS_LAST_BOX: SRS_LAST_BOX,
    RISKY_FLAGS: RISKY_FLAGS,
    STATE_VERSION: STATE_VERSION,
    DAY_MS: DAY_MS,
    dayKey: dayKey,
    emptyState: emptyState,
    sanitizeState: sanitizeState,
    applyAnswer: applyAnswer,
    tierOf: tierOf,
    nextTierOf: nextTierOf,
    masteryOf: masteryOf,
    parseRationale: parseRationale,
    rationaleFor: rationaleFor,
    isExcluded: isExcluded,
    dueQuestions: dueQuestions,
    selectSession: selectSession,
    skillStats: skillStats,
    skillOrder: skillOrder,
    overallStats: overallStats,
    activity: activity,
    streak: streak,
    troubleSpots: troubleSpots,
    dueCount: function (state, questions, now) {
      return dueQuestions(state, questions, now).length;
    }
  };
});
