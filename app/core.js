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
  var APP_TITLE = 'Question Trainer';
  var SESSION_LENGTHS = [5, 10, 15, 20, 30, 50];
  var DEFAULT_SESSION_LENGTH = 10;
  /* Lengths offered by older versions are still honoured on import, so an
   * existing export does not silently change its session size. */
  var LEGACY_SESSION_LENGTHS = [4, 8, 12];

  /* ------------------------------------------------------------------ *
   * Mastery
   *
   * A set's mastery is the average of every question's own share, so the
   * score does not depend on how many questions the set holds: a set is
   * mastered when most of *its* questions are known, not after a fixed
   * number of points has been collected.
   *
   * One question's share is stored as integer permille in [0, 1000] and is
   * updated answer by answer:
   *
   *   - a right answer on the first try sets it to 800; a first miss to 0;
   *   - a right answer on a question that has never been right before sets it
   *     to 550, however many misses came first;
   *   - every other right answer adds 100 and every miss subtracts 200;
   *   - the share is clamped to [0, 1000] after every step, so headroom above
   *     a full score and debt below zero are not remembered.
   *
   * The last point is deliberate: a saturated question loses 20 points on its
   * next miss, and a question missed several times starts climbing again from
   * 55% on its first correct answer. The legacy count formula is kept only to
   * seed `s` for records imported without one.
   *
   * masteryOf() averages the stored shares and scales the mean to 0..100.
   * ------------------------------------------------------------------ */
  var MASTERY = {
    firstTry: 800,
    retry: 550,
    practiceGain: 100,
    missPenalty: 200,
    shareMax: 1000,
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
   * box, so the gaps become 1, 4, 14, 45, 120 days. A miss sends it back to
   * box 0.
   *
   * The trainer reviews knowledge learned elsewhere, so a question that has
   * never been missed is already known: a correct answer on it promotes it to
   * at least SRS_KNOWN_BOX (14 days). Only corrections - questions missed at
   * least once - climb the ladder from box 1. */
  var SRS_INTERVALS_DAYS = [0, 1, 4, 14, 45, 120];
  var SRS_LAST_BOX = SRS_INTERVALS_DAYS.length - 1;
  var SRS_KNOWN_BOX = 3;

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

  /* The top-bar theme button walks auto -> light -> dark -> auto. An unknown
   * stored value is treated as auto, so its first click starts at light. */
  function nextTheme(theme) {
    if (theme === 'light') return 'dark';
    if (theme === 'dark') return 'auto';
    return 'light';
  }

  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* Every question also offers "I don't know" after its authored choices. It is
   * not part of the question data, and it can never be the correct answer:
   * applyAnswer() treats it as a miss. */
  var DONT_KNOW_CHOICE = "I don't know";

  function choicesFor(question) {
    return question.choices.concat([DONT_KNOW_CHOICE]);
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

  /* Set-scoped ids are pairs: question ids are unique inside a set, and unit
   * ids only inside their own set. Encoding keeps the key unambiguous even
   * when an id contains a slash or a colon. */
  function scopedKey(setId, itemId) {
    return encodeURIComponent(String(setId)) + '/' + encodeURIComponent(String(itemId));
  }

  function questionKey(setId, questionId) {
    return scopedKey(setId, questionId);
  }

  function unitKey(setId, unitId) {
    return scopedKey(setId, unitId);
  }

  /* ------------------------------------------------------------------ *
   * Fixed JSON format
   *
   * A set is a directory under questions/. questions/index.json lists the
   * directory names:
   *   { "sets": ["everyday-science", "photosynthesis"] }
   *
   * Each directory has its own index.json naming the unit files that make up
   * the set:
   *   { "id", "title", "description"?, "units": ["light.json", "calvin.json"] }
   *
   * A unit file has the shape a set file used to have:
   *   { "id", "title", "description"?, "questions": [
   *       { "id", "question", "choices": ["..."], "answer": <0-based index>,
   *         "passage"?, "image"?, "imageAlt"?, "imageCaption"?,
   *         "explanation"?, "explanations"?: ["..." | null] }
   *   ] }
   *
   * One bad unit is reported and skipped; the rest of the set still loads.
   * app/app.js prefixes file-level errors with the path it fetched.
   * ------------------------------------------------------------------ */
  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /* Unit file names and set directory names are bare names: no directories,
   * no "..", nothing a path traversal could use. */
  function bareName(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  }

  /* Question images are stored as written. Bare paths are resolved against
   * the questions/ directory by the app; absolute URLs and data: URIs pass
   * through. Script schemes are dropped rather than copied into an <img src>. */
  function resolveImage(value, base) {
    var src = text(value);
    if (!src) return '';
    if (/^(?:javascript|vbscript):/i.test(src)) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
    try {
      return new URL(src, base).href;
    } catch (err) {
      return '';
    }
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
      image: text(raw.image),
      imageAlt: text(raw.imageAlt),
      imageCaption: text(raw.imageCaption),
      question: prompt,
      choices: choices,
      answer: answer,
      explanation: text(raw.explanation),
      explanations: explanations
    };
  }

  /* A unit file: an id, a title, and a non-empty question list. Question ids
   * must be unique inside the unit; buildSet() widens that to the whole set,
   * because progress is keyed by set id plus question id. */
  function normalizeUnit(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('unit ' + (index + 1) + ' must be an object');
    }
    var id = text(raw.id);
    if (!id) throw new Error('unit ' + (index + 1) + ' needs a non-empty string "id"');
    var title = text(raw.title);
    if (!title) throw new Error('unit "' + id + '" needs a non-empty "title"');
    if (!Array.isArray(raw.questions) || !raw.questions.length) {
      throw new Error('unit "' + id + '" needs a non-empty "questions" array');
    }

    var seen = {};
    var questions = raw.questions.map(function (question, i) {
      var normalized = normalizeQuestion(question, i);
      if (seen[normalized.id]) {
        throw new Error('unit "' + id + '" has duplicate question id "' + normalized.id + '"');
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

  /* A set directory's index.json: who the set is and which files make it up. */
  function normalizeFolder(raw, fallbackId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('a set index must be an object');
    }
    var id = text(raw.id) || text(fallbackId);
    if (!id) throw new Error('the set index needs a non-empty string "id"');
    var title = text(raw.title);
    if (!title) throw new Error('set "' + id + '" needs a non-empty "title"');
    if (!Array.isArray(raw.units) || !raw.units.length) {
      throw new Error('set "' + id + '" needs a non-empty "units" array of file names');
    }

    var seen = {};
    var units = raw.units.map(function (value, i) {
      var name = typeof value === 'string' ? value.trim() : '';
      if (!bareName(name)) {
        throw new Error('set "' + id + '" unit ' + (i + 1) + ' must be a bare file name');
      }
      if (seen[name]) throw new Error('set "' + id + '" lists unit file "' + name + '" twice');
      seen[name] = true;
      return name;
    });

    return { id: id, title: title, description: text(raw.description), units: units };
  }

  /* Assemble a set from its folder descriptor and the unit files that could be
   * read. `entries` is [{ file, raw }] for a parsed unit, or [{ file, error }]
   * when fetching/parsing it failed. Bad units are dropped with a message; a
   * set with no usable unit is not a set at all. */
  function buildSet(folder, entries) {
    var errors = [];
    var units = [];
    var seenUnit = {};
    var seenQuestion = {};

    (entries || []).forEach(function (entry) {
      var file = entry && entry.file ? entry.file : 'unit';
      if (!entry || entry.raw === undefined || entry.raw === null) {
        errors.push(file + ': ' + ((entry && entry.error) || 'could not be read'));
        return;
      }
      try {
        var unit = normalizeUnit(entry.raw, units.length);
        if (seenUnit[unit.id]) {
          throw new Error('duplicate unit id "' + unit.id + '" in the set');
        }
        unit.questions.forEach(function (question) {
          if (seenQuestion[question.id]) {
            throw new Error('duplicate question id "' + question.id + '" in the set');
          }
        });
        seenUnit[unit.id] = true;
        unit.questions.forEach(function (question) { seenQuestion[question.id] = true; });
        units.push(unit);
      } catch (err) {
        errors.push(file + ': ' + err.message);
      }
    });

    if (!units.length) {
      errors.push('set "' + folder.id + '" has no usable unit');
      return { set: null, errors: errors };
    }
    return {
      set: {
        id: folder.id,
        title: folder.title,
        description: folder.description,
        units: units
      },
      errors: errors
    };
  }

  /* Every set is a group of units. A flat set object from an older version
   * (questions, no units) is treated as a set with one unit, so archived and
   * restored copies from before the split keep working. */
  function unitsOf(set) {
    if (!set || typeof set !== 'object') return [];
    if (Array.isArray(set.units) && set.units.length) return set.units;
    if (Array.isArray(set.questions)) {
      return [{
        id: set.id,
        title: set.title,
        description: set.description || '',
        questions: set.questions
      }];
    }
    return [];
  }

  function unitOf(set, unitId) {
    if (!unitId) return null;
    var units = unitsOf(set);
    for (var i = 0; i < units.length; i++) {
      if (units[i].id === unitId) return units[i];
    }
    return null;
  }

  /* The questions a session draws from: one unit, or the whole set in unit
   * order. Progress keys stay set id / question id either way. */
  function questionsOf(set, unitId) {
    if (unitId) {
      var unit = unitOf(set, unitId);
      return unit ? unit.questions : [];
    }
    return unitsOf(set).reduce(function (all, unit) {
      return all.concat(unit.questions);
    }, []);
  }

  function withUnits(set, units) {
    return {
      id: set.id,
      title: set.title,
      description: set.description || '',
      units: units
    };
  }

  function cloneQuestion(question) {
    return {
      id: question.id,
      passage: question.passage,
      image: question.image,
      imageAlt: question.imageAlt,
      imageCaption: question.imageCaption,
      question: question.question,
      choices: question.choices.slice(),
      answer: question.answer,
      explanation: question.explanation,
      explanations: question.explanations ? question.explanations.slice() : null
    };
  }

  function cloneUnit(unit) {
    return {
      id: unit.id,
      title: unit.title,
      description: unit.description || '',
      questions: unit.questions.map(cloneQuestion)
    };
  }

  function cloneSet(set) {
    return withUnits(set, unitsOf(set).map(cloneUnit));
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
      archivedUnits: {},
      deleted: {},
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

  /* A set snapshot may come from an older version, where a set was one flat
   * object with questions. Both shapes sanitise to a set with units. */
  function snapshotSet(raw) {
    if (raw && typeof raw === 'object' && Array.isArray(raw.units) && raw.units.length) {
      var id = text(raw.id);
      if (!id) throw new Error('set snapshot without an id');
      var seen = {};
      var units = [];
      raw.units.forEach(function (value, i) {
        var unit = normalizeUnit(value, i);
        if (seen[unit.id]) return;
        seen[unit.id] = true;
        units.push(unit);
      });
      if (!units.length) throw new Error('set snapshot without a unit');
      return {
        id: id,
        title: text(raw.title) || id,
        description: text(raw.description),
        units: units
      };
    }
    var single = normalizeUnit(raw, 0);
    return {
      id: single.id,
      title: single.title,
      description: single.description,
      units: [single]
    };
  }

  function sanitizeArchived(entry, now) {
    var set = snapshotSet(entry);
    return {
      id: set.id,
      title: set.title,
      description: set.description,
      units: set.units,
      kind: 'set',
      archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : now
    };
  }

  function sanitizeArchivedUnit(entry, now) {
    var unit = normalizeUnit(entry, 0);
    var setId = text(entry.setId);
    /* A unit archive is only meaningful inside its set: the id alone does not
     * identify it, because two sets may both have a unit "basics". */
    if (!setId) throw new Error('archived unit without a set id');
    return {
      id: unit.id,
      title: unit.title,
      description: unit.description,
      questions: unit.questions,
      kind: 'unit',
      setId: setId,
      setTitle: text(entry.setTitle),
      archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : now
    };
  }

  /* A delete mark is { on, at }: whether the question is deleted, and when
   * that was last decided. A restore keeps the mark with on=false, so a merge
   * with an older copy that still has it deleted does not bring it back. */
  function sanitizeDeleted(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.on !== 'boolean') return null;
    return {
      on: entry.on,
      at: typeof entry.at === 'number' && isFinite(entry.at) ? entry.at : 0
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
        /* Exports predating `f` lose the first answer as soon as a question
         * has both a right and a wrong attempt. What survives: an all-correct
         * record (c === a) was right from the start, and a mixed or all-wrong
         * one cannot be assumed correct, so it counts as not-first-try. */
        var first = rec.f === 0 || rec.f === 1 ? rec.f : (correct === attempts ? 1 : 0);
        state.q[key] = {
          a: attempts,
          c: correct,
          f: first,
          /* Records from before the stored score have no `s`; seed it once
           * from the legacy count formula so the displayed score does not
           * jump on the upgrade. */
          s: typeof rec.s === 'number' && isFinite(rec.s)
            ? clampShare(Math.round(rec.s))
            : deriveShare({ a: attempts, c: correct, f: first }),
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
          a: attempts,
          c: clamp(rec.c | 0, 0, attempts),
          streak: Math.max(0, rec.streak | 0)
        };
      });
    }

    if (raw.local && typeof raw.local === 'object') {
      Object.keys(raw.local).forEach(function (key) {
        try {
          var set = snapshotSet(raw.local[key]);
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

    if (raw.archivedUnits && typeof raw.archivedUnits === 'object') {
      Object.keys(raw.archivedUnits).forEach(function (key) {
        try {
          var unit = sanitizeArchivedUnit(raw.archivedUnits[key], now);
          /* Derive the key from the entry, not the old object key: exports made
           * before unit archives were set-scoped used the bare unit id. */
          state.archivedUnits[unitKey(unit.setId, unit.id)] = unit;
        } catch (err) { /* drop an unusable archived unit */ }
      });
    }

    if (raw.deleted && typeof raw.deleted === 'object') {
      Object.keys(raw.deleted).forEach(function (key) {
        var mark = sanitizeDeleted(raw.deleted[key]);
        if (mark) state.deleted[key] = mark;
      });
    }

    /* An archived set must never also be active, and a unit of an archived set
     * is not separately archived. */
    Object.keys(state.local).forEach(function (id) {
      if (state.archived[id]) delete state.local[id];
    });
    Object.keys(state.archivedUnits).forEach(function (key) {
      if (state.archived[state.archivedUnits[key].setId]) delete state.archivedUnits[key];
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

  /* Stamp a state after a local change. The clock alone is not enough for
   * conflict detection: two writes in the same millisecond, or a clock that
   * stepped backwards, must still produce a strictly increasing stamp. */
  function stampState(state, now) {
    now = typeof now === 'number' && isFinite(now) ? now : Date.now();
    var value = Math.max(now, (Number(state.updated) || 0) + 1);
    state.updated = value;
    return value;
  }

  /* The union keys of two plain objects, preserving first-seen order. */
  function unionKeys(first, second) {
    var seen = {};
    var keys = [];
    [first, second].forEach(function (map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        if (seen[key]) return;
        seen[key] = true;
        keys.push(key);
      });
    });
    return keys;
  }

  function counterOf(record, field) {
    return record && typeof record === 'object' ? Math.max(0, record[field] | 0) : 0;
  }

  function lastOf(record) {
    return record && typeof record === 'object' &&
      typeof record.last === 'number' && isFinite(record.last) ? record.last : -Infinity;
  }

  function mergeRecord(server, local) {
    if (!server || typeof server !== 'object') return local;
    if (!local || typeof local !== 'object') return server;
    var serverLast = lastOf(server);
    var localLast = lastOf(local);
    if (localLast > serverLast) return local;
    if (serverLast > localLast) return server;
    return counterOf(local, 'a') > counterOf(server, 'a') ? local : server;
  }

  /* Reconcile a browser state (local, just changed) with the newer disk copy
   * (server). The merge is additive and deliberate:
   *   - question records are keyed unions; the newer `last` wins, then the
   *     larger attempt count, then the server record. Two tabs answering the
   *     same question concurrently therefore collapse to one record instead of
   *     double-counting the answer;
   *   - per-set, per-day and all-time counters take each field's maximum, so
   *     the result never exceeds the high-water mark of either side;
   *   - settings, local sets and archives keep the local values, because the
   *     action that triggered the merge happened in this browser;
   *   - delete marks keep the later decision, then the local one, so a delete
   *     or a restore made on either side survives;
   *   - creation time is the earlier of the two and the schema comes from the
   *     server;
   *   - the result is sanitized so the archive invariants (an archived set is
   *     not also active, a unit of an archived set is not separately archived)
   *     hold even if the union produced contradictions.
   * Neither input is mutated. */
  function mergeStates(server, local, now) {
    server = server && typeof server === 'object' ? server : {};
    local = local && typeof local === 'object' ? local : {};
    now = typeof now === 'number' && isFinite(now) ? now : Date.now();

    var created;
    if (typeof server.created === 'number' && typeof local.created === 'number') {
      created = Math.min(server.created, local.created);
    } else {
      created = typeof local.created === 'number' ? local.created : server.created;
    }

    var raw = {
      app: server.app,
      v: server.v,
      created: created,
      updated: Math.max(
        typeof server.updated === 'number' && isFinite(server.updated) ? server.updated : 0,
        typeof local.updated === 'number' && isFinite(local.updated) ? local.updated : 0),
      q: {},
      sets: {},
      local: {},
      archived: {},
      archivedUnits: {},
      deleted: {},
      days: {},
      settings: local.settings,
      totals: {
        a: Math.max(counterOf(server.totals, 'a'), counterOf(local.totals, 'a')),
        c: Math.max(counterOf(server.totals, 'c'), counterOf(local.totals, 'c')),
        sessions: Math.max(counterOf(server.totals, 'sessions'),
          counterOf(local.totals, 'sessions'))
      }
    };

    unionKeys(server.q, local.q).forEach(function (key) {
      raw.q[key] = mergeRecord(server.q && server.q[key], local.q && local.q[key]);
    });

    unionKeys(server.sets, local.sets).forEach(function (setId) {
      var s = server.sets && server.sets[setId];
      var l = local.sets && local.sets[setId];
      raw.sets[setId] = {
        a: Math.max(counterOf(s, 'a'), counterOf(l, 'a')),
        c: Math.max(counterOf(s, 'c'), counterOf(l, 'c')),
        streak: Math.max(counterOf(s, 'streak'), counterOf(l, 'streak'))
      };
    });

    unionKeys(server.days, local.days).forEach(function (key) {
      var s = server.days && server.days[key];
      var l = local.days && local.days[key];
      raw.days[key] = {
        a: Math.max(counterOf(s, 'a'), counterOf(l, 'a')),
        c: Math.max(counterOf(s, 'c'), counterOf(l, 'c'))
      };
    });

    unionKeys(server.local, local.local).forEach(function (id) {
      raw.local[id] = local.local && local.local[id] != null
        ? local.local[id]
        : server.local[id];
    });
    unionKeys(server.archived, local.archived).forEach(function (id) {
      raw.archived[id] = local.archived && local.archived[id] != null
        ? local.archived[id]
        : server.archived[id];
    });
    unionKeys(server.archivedUnits, local.archivedUnits).forEach(function (key) {
      raw.archivedUnits[key] = local.archivedUnits && local.archivedUnits[key] != null
        ? local.archivedUnits[key]
        : server.archivedUnits[key];
    });
    unionKeys(server.deleted, local.deleted).forEach(function (key) {
      var s = sanitizeDeleted(server.deleted && server.deleted[key]);
      var l = sanitizeDeleted(local.deleted && local.deleted[key]);
      raw.deleted[key] = !s || (l && l.at >= s.at) ? l : s;
    });

    return sanitizeState(raw, now);
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
    /* The appended "I don't know" choice sits past the authored choices; the
     * bound keeps it wrong even if a question's answer index were set to it. */
    var correct = choiceIndex === question.answer && choiceIndex < question.choices.length;
    var chosen = letterFor(choiceIndex);
    var expected = letterFor(question.answer);
    var before = state.q[key] || null;
    var hadCorrectBefore = !!(before && before.c > 0);

    var boxBefore = before ? before.box : 0;
    var neverMissed = !before || before.c >= before.a;
    var boxAfter = correct
      ? clamp(Math.max(boxBefore + 1, neverMissed ? SRS_KNOWN_BOX : 1), 1, SRS_LAST_BOX)
      : 0;
    var rec = {
      a: (before ? before.a : 0) + 1,
      c: (before ? before.c : 0) + (correct ? 1 : 0),
      /* f: 1 when this question's very first answer was right, else 0. Stored
       * rather than derived: later retries inflate `c`, so "ever correct" is a
       * different (wrong) thing from "right on the first try". */
      f: before ? (before.f ? 1 : 0) : (correct ? 1 : 0),
      s: nextShare(before, correct),
      box: boxAfter,
      due: now + SRS_INTERVALS_DAYS[boxAfter] * DAY_MS,
      last: now
    };
    state.q[key] = rec;

    var set = state.sets[setId] || { a: 0, c: 0, streak: 0 };
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
      coin: correct ? (hadCorrectBefore ? 'repeat' : 'new') : 'miss',
      boxBefore: boxBefore,
      boxAfter: boxAfter
    };
  }

  function tierOf(points, attempts) {
    if (!attempts) return MASTERY.tiers[MASTERY.tiers.length - 1];
    for (var i = 0; i < MASTERY.tiers.length; i++) {
      if (points >= MASTERY.tiers[i].min) return MASTERY.tiers[i];
    }
    return MASTERY.tiers[MASTERY.tiers.length - 1];
  }

  function clampShare(share) {
    return Math.min(MASTERY.shareMax, Math.max(0, share));
  }

  /* The pre-permille count formula, in permille. Only used to seed `s` for
   * imported records that predate the stored score. */
  function deriveShare(rec) {
    if (!rec || !rec.a || !rec.c) return 0;
    var wrong = rec.a - rec.c;
    var base = rec.f ? MASTERY.firstTry : MASTERY.retry;
    var misses = rec.f ? wrong : Math.max(0, wrong - 1);
    return clampShare(base + (rec.c - 1) * MASTERY.practiceGain -
      misses * MASTERY.missPenalty);
  }

  /* The score after one answer. The first answer is the baseline; a correct
   * answer on a question that has never been correct is the one-time 550
   * bootstrap, however many misses came before it. Everything else is 100 up
   * or 200 down, clamped after the step. */
  function nextShare(before, correct) {
    if (!before) return correct ? MASTERY.firstTry : 0;
    var share = typeof before.s === 'number' && isFinite(before.s)
      ? clampShare(Math.round(before.s))
      : deriveShare(before);
    if (correct) share = before.c > 0 ? share + MASTERY.practiceGain : MASTERY.retry;
    else share -= MASTERY.missPenalty;
    return clampShare(share);
  }

  /* The question's stored share in permille. */
  function questionShare(rec) {
    if (!rec || !rec.a) return 0;
    return typeof rec.s === 'number' && isFinite(rec.s)
      ? clampShare(Math.round(rec.s))
      : deriveShare(rec);
  }

  /* The set's 0-100 score: the mean of every question's share. Unseen
   * questions pull the mean down; an archived unit is not in `questions`, so
   * its records do not silently count towards the active set either. */
  function masteryOf(state, setId, questions) {
    var list = Array.isArray(questions) ? questions : [];
    if (!list.length) return 0;
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      sum += questionShare(recordFor(state, setId, list[i].id));
    }
    /* sum is permille; the mean share is sum / (1000 * n), and the 0-100
     * score is that times 100. */
    return clamp(Math.round(sum / (10 * list.length)), 0, MASTERY.cap);
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
   * different order each session (deterministic when `rng` is provided).
   * Practice goes weakest first, ordered by mastery share, then box, then
   * least-recently-answered, then fewest attempts, then rng. The mastery
   * share is the primary key, so an unseen question (share 0) is served
   * before a known one, even when the known one sits in an earlier box. */
  function decorate(list, state, setId, rng) {
    return list.map(function (question) {
      return { q: question, r: rng() };
    }).sort(function (x, y) {
      var rx = recordFor(state, setId, x.q.id);
      var ry = recordFor(state, setId, y.q.id);
      var sx = questionShare(rx) - questionShare(ry);
      if (sx) return sx;
      var bx = (rx ? rx.box : 0) - (ry ? ry.box : 0);
      if (bx) return bx;
      var lx = (rx ? rx.last : 0) - (ry ? ry.last : 0);
      if (lx) return lx;
      var ax = (rx ? rx.a : 0) - (ry ? ry.a : 0);
      if (ax) return ax;
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

  /* The disposable sessionStorage payload for a running session. Results carry
   * the reward as it was at answer time, because mastery may have moved on
   * since then. `elapsed` is passed in so the caller keeps owning the clock. */
  function makeSessionSnapshot(session, elapsed) {
    var excluded = [];
    Object.keys(session.excluded || {}).forEach(function (key) {
      var index = parseInt(key, 10);
      if (index >= 0 && session.excluded[key]) excluded.push(index);
    });
    excluded.sort(function (a, b) { return a - b; });
    return {
      v: 1,
      cfg: {
        setId: session.cfg.setId,
        unitId: session.cfg.unitId || '',
        mode: session.cfg.mode,
        length: session.cfg.length
      },
      ids: session.questions.map(function (question) { return question.id; }),
      index: session.index,
      results: session.results.map(function (record) {
        return {
          index: record.index,
          questionId: record.question.id,
          chosen: record.chosen,
          expected: record.expected,
          correct: record.correct,
          coin: record.coin,
          pointsBefore: record.pointsBefore,
          pointsAfter: record.pointsAfter,
          pointsDelta: record.pointsDelta,
          boxBefore: record.boxBefore,
          boxAfter: record.boxAfter,
          streak: record.streak
        };
      }),
      selected: session.selected,
      excluded: excluded,
      checked: !!session.checked,
      elapsed: elapsed
    };
  }

  /* Stop a session before its last question. The answers given so far keep
   * their grades; an unchecked selection and its cross-outs are dropped, and
   * the cursor moves past the end so the session shows its results. */
  function endSession(session) {
    session.index = session.questions.length;
    session.selected = null;
    session.excluded = {};
    session.checked = false;
    return session;
  }

  /* A finished session answered every question; one stopped early did not. */
  function endedEarly(session) {
    return session.index >= session.questions.length &&
      session.results.length < session.questions.length;
  }

  function finiteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /* Rebuild a session from a makeSessionSnapshot() payload against the set it
   * claims to belong to. Every id is checked against the current bank, so a
   * session whose ids no longer resolve is dropped rather than half-restored.
   * Returns a session object ready to resume, or null when anything is off. */
  function restoreSessionSnapshot(raw, set) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;

    var cfg = raw.cfg;
    var mode = cfg && cfg.mode;
    var valid = !!cfg && typeof cfg.setId === 'string' && !!cfg.setId &&
      (mode === 'practice' || mode === 'review' || mode === 'retry') &&
      finiteNumber(cfg.length) && Math.floor(cfg.length) === cfg.length &&
      cfg.length >= 1 && cfg.length <= 50 &&
      (cfg.unitId == null || typeof cfg.unitId === 'string') &&
      Array.isArray(raw.ids) && finiteNumber(raw.index) &&
      Math.floor(raw.index) === raw.index && raw.index >= 0 &&
      raw.index <= raw.ids.length &&
      Array.isArray(raw.results) && typeof raw.checked === 'boolean' &&
      finiteNumber(raw.elapsed) && raw.elapsed >= 0 &&
      (raw.selected == null || (finiteNumber(raw.selected) &&
        Math.floor(raw.selected) === raw.selected && raw.selected >= 0)) &&
      Array.isArray(raw.excluded);
    if (!valid) return null;

    var unitId = cfg.unitId || '';
    if (!set) return null;
    if (unitId && !unitOf(set, unitId)) return null;

    var pool = questionsOf(set, unitId);
    var byId = {};
    pool.forEach(function (question) { byId[question.id] = question; });
    var questions = [];
    var seen = {};
    for (var i = 0; i < raw.ids.length; i++) {
      var id = raw.ids[i];
      if (typeof id !== 'string' || !byId[id] || seen[id]) return null;
      seen[id] = true;
      questions.push(byId[id]);
    }

    var results = [];
    var resultByIndex = {};
    for (var j = 0; j < raw.results.length; j++) {
      var rec = raw.results[j];
      var pos = rec && rec.index;
      if (!rec || typeof rec !== 'object' || !finiteNumber(pos) ||
          Math.floor(pos) !== pos || pos < 0 || pos >= questions.length ||
          questions[pos].id !== rec.questionId ||
          typeof rec.chosen !== 'string' || typeof rec.expected !== 'string' ||
          typeof rec.correct !== 'boolean' ||
          (rec.coin !== 'new' && rec.coin !== 'repeat' && rec.coin !== 'miss') ||
          !finiteNumber(rec.pointsBefore) || !finiteNumber(rec.pointsAfter) ||
          !finiteNumber(rec.pointsDelta) || !finiteNumber(rec.boxBefore) ||
          !finiteNumber(rec.boxAfter) || !finiteNumber(rec.streak) ||
          resultByIndex[pos]) {
        return null;
      }
      var record = {
        index: pos,
        questionId: rec.questionId,
        question: questions[pos],
        chosen: rec.chosen,
        expected: rec.expected,
        correct: rec.correct,
        coin: rec.coin,
        pointsBefore: rec.pointsBefore,
        pointsAfter: rec.pointsAfter,
        pointsDelta: rec.pointsDelta,
        boxBefore: rec.boxBefore,
        boxAfter: rec.boxAfter,
        streak: rec.streak
      };
      results.push(record);
      resultByIndex[pos] = record;
    }
    /* A checked cursor without its graded record could not paint feedback.
     * At the results screen the cursor sits past the last question, so there
     * is no record at its index. */
    if (raw.checked && raw.index < questions.length && !resultByIndex[raw.index]) {
      return null;
    }

    var excluded = {};
    for (var k = 0; k < raw.excluded.length; k++) {
      var crossed = raw.excluded[k];
      if (!finiteNumber(crossed) || Math.floor(crossed) !== crossed || crossed < 0) {
        return null;
      }
      excluded[crossed] = true;
    }
    var selected = raw.selected == null ? null : raw.selected;
    if (selected != null && raw.index < questions.length &&
        selected >= choicesFor(questions[raw.index]).length) {
      return null;
    }

    return {
      cfg: { setId: cfg.setId, unitId: unitId, mode: mode, length: cfg.length },
      set: set,
      questions: questions,
      index: raw.index,
      results: results,
      selected: selected,
      excluded: excluded,
      checked: raw.checked,
      elapsed: raw.elapsed,
      runningSince: null
    };
  }

  /* Forget one set's question history and mastery. Daily activity and the
   * all-time totals are cross-set aggregates, so they keep their history; the
   * set's own rows and due count are recalculated from the empty records. */
  function resetSetProgress(state, setId, now) {
    now = now || Date.now();
    var prefix = scopedKey(setId, '');
    var removed = 0;
    Object.keys(state.q || {}).forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      delete state.q[key];
      removed += 1;
    });
    delete state.sets[setId];
    state.updated = now;
    return removed;
  }

  /* Forget one question's history, mastery share and review date. */
  function resetQuestionProgress(state, setId, questionId, now) {
    var key = questionKey(setId, questionId);
    var had = !!state.q[key];
    delete state.q[key];
    state.updated = now || Date.now();
    return had;
  }

  /* ------------------------------------------------------------------ *
   * Deleted questions
   *
   * Deleting a question hides it from practice, review, mastery and stats;
   * the question file is never touched and the progress record is kept, so a
   * restore brings the question back exactly as it was.
   * ------------------------------------------------------------------ */
  function isDeleted(state, setId, questionId) {
    var mark = (state.deleted || {})[questionKey(setId, questionId)];
    return !!mark && mark.on;
  }

  function markDeleted(state, setId, questionId, on, now) {
    now = now || Date.now();
    if (!state.deleted) state.deleted = {};
    state.deleted[questionKey(setId, questionId)] = { on: on, at: now };
    state.updated = now;
  }

  function deleteQuestion(state, setId, questionId, now) {
    markDeleted(state, setId, questionId, true, now);
  }

  function restoreQuestion(state, setId, questionId, now) {
    markDeleted(state, setId, questionId, false, now);
  }

  /* The set without its deleted questions. A unit left with no question is
   * dropped; a set left with no unit comes back as null. The input is
   * returned unchanged when nothing of it is deleted. */
  function withoutDeleted(state, set) {
    var units = unitsOf(set);
    var changed = false;
    var kept = [];
    units.forEach(function (unit) {
      var questions = unit.questions.filter(function (question) {
        return !isDeleted(state, set.id, question.id);
      });
      if (questions.length !== unit.questions.length) changed = true;
      if (!questions.length) return;
      kept.push(questions.length === unit.questions.length ? unit : {
        id: unit.id,
        title: unit.title,
        description: unit.description || '',
        questions: questions
      });
    });
    if (!changed) return set;
    if (!kept.length) return null;
    var out = withUnits(set, kept);
    if (set.kind) out.kind = set.kind;
    if (typeof set.archivedAt === 'number') out.archivedAt = set.archivedAt;
    return out;
  }

  /* Every deleted question still present in the given sets, newest delete
   * first. Pass browse sets, which still carry deleted questions. */
  function deletedQuestions(state, sets) {
    var rows = [];
    (sets || []).forEach(function (set) {
      unitsOf(set).forEach(function (unit) {
        unit.questions.forEach(function (question) {
          var mark = (state.deleted || {})[questionKey(set.id, question.id)];
          if (!mark || !mark.on) return;
          rows.push({ set: set, unit: unit, q: question, at: mark.at });
        });
      });
    });
    return rows.sort(function (a, b) { return b.at - a.at; });
  }

  /* ------------------------------------------------------------------ *
   * Per-set activity and archive
   * ------------------------------------------------------------------ */
  function setStats(state, set, now) {
    now = now || Date.now();
    var units = unitsOf(set);
    var row = {
      set: set,
      id: set.id,
      title: set.title,
      description: set.description,
      units: units.length,
      unitRows: units.map(function (unit) { return unitStats(state, set, unit, now); }),
      total: 0,
      attempted: 0,
      correctFirstTry: 0,
      due: 0,
      points: masteryOf(state, set.id, questionsOf(set)),
      streak: (state.sets[set.id] || {}).streak || 0
    };
    row.unitRows.forEach(function (unitRow) {
      row.total += unitRow.total;
      row.attempted += unitRow.attempted;
      row.correctFirstTry += unitRow.correctFirstTry;
      row.due += unitRow.due;
    });
    row.accuracy = row.attempted
      ? Math.round((row.correctFirstTry / row.attempted) * 100)
      : 0;
    row.tier = tierOf(row.points, row.attempted);
    row.unseen = row.total - row.attempted;
    row.archived = !!set.archivedAt;
    return row;
  }

  /* One unit of a set. Mastery is the mean share of the unit's own questions,
   * the same formula as the set score, so a unit row can show a score on the
   * same scale. Coverage, first-try accuracy and what is due are scoped to the
   * unit too. */
  function unitStats(state, set, unit, now) {
    now = now || Date.now();
    var row = {
      unit: unit,
      id: unit.id,
      title: unit.title,
      setId: set.id,
      total: unit.questions.length,
      attempted: 0,
      correctFirstTry: 0,
      due: 0,
      points: masteryOf(state, set.id, unit.questions)
    };
    unit.questions.forEach(function (question) {
      var rec = recordFor(state, set.id, question.id);
      if (!rec || rec.a <= 0) return;
      row.attempted += 1;
      row.correctFirstTry += rec.f;
      if (rec.due <= now) row.due += 1;
    });
    row.accuracy = row.attempted
      ? Math.round((row.correctFirstTry / row.attempted) * 100)
      : 0;
    row.tier = tierOf(row.points, row.attempted);
    return row;
  }

  function allSetStats(state, sets, now) {
    return sets.map(function (set) { return setStats(state, set, now); });
  }

  /* Home search: a query matches the set title, its description, or any unit
   * title, case-insensitively, so a set found through one of its units stays
   * visible. Rows are setStats() objects. */
  function filterSetRows(rows, query) {
    var needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!needle) return (rows || []).slice();
    return (rows || []).filter(function (row) {
      if (!row) return false;
      var hay = [row.title, row.description];
      var units = row.set ? unitsOf(row.set) : [];
      units.forEach(function (unit) { hay.push(unit.title); });
      if (!units.length && row.unitRows) {
        row.unitRows.forEach(function (unitRow) { hay.push(unitRow.title); });
      }
      return hay.some(function (value) {
        return String(value == null ? '' : value).toLowerCase().indexOf(needle) >= 0;
      });
    });
  }

  /* Home order. Ties keep source order in every mode: the original index is
   * carried alongside and used as the final tiebreak, so the result does not
   * depend on the engine's sort stability. */
  function sortSetRows(rows, sort) {
    var keyed = (rows || []).map(function (row, i) { return { row: row, i: i }; });
    keyed.sort(function (a, b) {
      var d = 0;
      if (sort === 'title') {
        d = String(a.row.title || '').localeCompare(String(b.row.title || ''));
      } else if (sort === 'mastery') {
        d = (b.row.points || 0) - (a.row.points || 0);
      } else if (sort === 'due') {
        d = (b.row.due || 0) - (a.row.due || 0);
      }
      return d || a.i - b.i;
    });
    return keyed.map(function (entry) { return entry.row; });
  }

  /* Aggregate set rows into the global counters. The rows may come from
   * allSetStats (active plus archived history), which is what overallStats
   * does; keeping the aggregation separate lets a caller reuse it over a row
   * list it already has. */
  function statsFromRows(state, rows, now) {
    now = now || Date.now();
    rows = rows || [];
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

  function overallStats(state, sets, now) {
    now = now || Date.now();
    return statsFromRows(state, allSetStats(state, sets, now), now);
  }

  /* The last `days` local calendar dates, oldest first, ending with the local
   * date containing `now`. Walking a local-noon cursor with setDate() keeps
   * every entry on a distinct local day across DST: subtracting fixed DAY_MS
   * steps would skip the spring-forward date and repeat the fall-back one. */
  function recentDayKeys(now, days) {
    now = typeof now === 'number' ? now : Date.now();
    var count = Math.max(0, Math.floor(Number(days) || 0));
    var cursor = new Date(now);
    cursor.setHours(12, 0, 0, 0);
    var keys = [];
    for (var i = 0; i < count; i++) {
      keys.push(dayKey(cursor.getTime()));
      cursor.setDate(cursor.getDate() - 1);
    }
    return keys.reverse();
  }

  function activity(state, days, now) {
    now = typeof now === 'number' ? now : Date.now();
    return recentDayKeys(now, days).map(function (key) {
      var rec = state.days[key] || { a: 0, c: 0 };
      return { date: key, a: rec.a, c: rec.c };
    });
  }

  /* Consecutive days with at least one answer, counting back from today. A
   * day with no answers yet does not break the streak until it is over, so an
   * untouched today starts the walk at yesterday instead. */
  function streak(state, now) {
    now = typeof now === 'number' ? now : Date.now();
    var cursor = new Date(now);
    cursor.setHours(12, 0, 0, 0);
    var today = state.days[dayKey(cursor.getTime())];
    if (!(today && today.a > 0)) cursor.setDate(cursor.getDate() - 1);
    var count = 0;
    for (var i = 0; i < 400; i++) {
      var rec = state.days[dayKey(cursor.getTime())];
      if (rec && rec.a > 0) count++;
      else break;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  /* Most-missed questions, for the progress screen. */
  function troubleSpots(state, sets, limit) {
    var rows = [];
    sets.forEach(function (set) {
      unitsOf(set).forEach(function (unit) {
        unit.questions.forEach(function (question) {
          var rec = recordFor(state, set.id, question.id);
          if (!rec || rec.a < 2) return;
          var wrong = rec.a - rec.c;
          if (!wrong) return;
          rows.push({
            set: set,
            unit: unit,
            q: question,
            attempts: rec.a,
            correct: rec.c,
            wrong: wrong
          });
        });
      });
    });
    rows.sort(function (a, b) {
      return b.wrong - a.wrong || b.attempts - a.attempts;
    });
    return rows.slice(0, limit || 10);
  }

  /* Archiving a whole set freezes every unit. Unit-level archive entries for
   * that set are absorbed into the snapshot, so restoring the set brings all
   * its units back at once. A caller may pass a filtered set (the active view
   * after a unit was archived); missing archived units are merged back so the
   * set snapshot stays complete. */
  function archiveSet(state, set, now) {
    now = now || Date.now();
    var units = [];
    var seen = {};
    unitsOf(set).forEach(function (unit) {
      var key = unitKey(set.id, unit.id);
      var source = state.archivedUnits[key] || unit;
      if (seen[unit.id]) return;
      seen[unit.id] = true;
      units.push(cloneUnit(source));
    });
    Object.keys(state.archivedUnits || {}).forEach(function (key) {
      var unit = state.archivedUnits[key];
      if (!unit || unit.setId !== set.id || seen[unit.id]) return;
      seen[unit.id] = true;
      units.push(cloneUnit(unit));
    });
    var snapshot = withUnits(set, units);
    snapshot.archivedAt = now;
    snapshot.kind = 'set';
    state.archived[set.id] = snapshot;
    delete state.local[set.id];
    Object.keys(state.archivedUnits || {}).forEach(function (key) {
      if (state.archivedUnits[key].setId === set.id) delete state.archivedUnits[key];
    });
    state.updated = now;
    return snapshot;
  }

  /* Archiving one unit hides it from the set and its practice/review links; the
   * rest of the set stays active. */
  function archiveUnit(state, set, unit, now) {
    now = now || Date.now();
    var snapshot = {
      id: unit.id,
      title: unit.title,
      description: unit.description || '',
      questions: unit.questions.map(cloneQuestion),
      kind: 'unit',
      setId: set.id,
      setTitle: set.title,
      archivedAt: now
    };
    state.archivedUnits[unitKey(set.id, unit.id)] = snapshot;
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

  /* Restore one archived unit. When the source set no longer has it (the folder
   * lost the unit file, or the folder itself is gone), the unit is kept in a
   * browser-local copy of the set, so the restore is never a dead end. */
  function restoreUnit(state, setId, unitId, sourceSet, now) {
    now = now || Date.now();
    var key = unitKey(setId, unitId);
    var snapshot = state.archivedUnits[key];
    if (!snapshot) return null;
    delete state.archivedUnits[key];
    var present = !!sourceSet && sourceSet.id === setId &&
      unitsOf(sourceSet).some(function (unit) { return unit.id === unitId; });
    if (!present) {
      var host = state.local[snapshot.setId];
      if (!host) {
        host = sourceSet && sourceSet.id === snapshot.setId ? cloneSet(sourceSet) : {
          id: snapshot.setId,
          title: snapshot.setTitle || snapshot.setId,
          description: '',
          units: []
        };
      }
      host.units = unitsOf(host).filter(function (unit) { return unit.id !== unitId; });
      host.units.push({
        id: snapshot.id,
        title: snapshot.title,
        description: snapshot.description || '',
        questions: snapshot.questions.map(cloneQuestion)
      });
      state.local[snapshot.setId] = host;
    }
    state.updated = now;
    return snapshot;
  }

  /* Active sets in source order, with archived sets removed and archived units
   * and deleted questions filtered out. A browser-local copy wins over the
   * loaded source for the same set id, because it exists only for content the
   * source no longer carries. */
  function activeSets(state, sourceSets) {
    var out = [];
    browseSets(state, sourceSets).forEach(function (set) {
      var kept = withoutDeleted(state, set);
      if (kept) out.push(kept);
    });
    return out;
  }

  /* The active sets as activeSets() lists them, but with deleted questions
   * still in place: the question browser shows them so they can be restored. */
  function browseSets(state, sourceSets) {
    var byId = {};
    var order = [];
    (sourceSets || []).forEach(function (set) {
      if (!set || !set.id || byId[set.id]) return;
      byId[set.id] = set;
      order.push(set.id);
    });
    Object.keys(state.local || {}).forEach(function (id) {
      if (!byId[id]) order.push(id);
      byId[id] = state.local[id];
    });

    var out = [];
    order.forEach(function (id) {
      var set = byId[id];
      if (!set || state.archived[id]) return;
      var units = unitsOf(set);
      var kept = units.filter(function (unit) {
        return !state.archivedUnits[unitKey(set.id, unit.id)];
      });
      if (!kept.length) return;
      out.push(kept.length === units.length ? set : withUnits(set, kept));
    });
    return out;
  }

  /* Everything in the archive, newest first: whole sets (kind 'set') and single
   * units (kind 'unit'). */
  function archivedSets(state) {
    var out = [];
    Object.keys(state.archived || {}).forEach(function (id) {
      out.push(state.archived[id]);
    });
    Object.keys(state.archivedUnits || {}).forEach(function (key) {
      out.push(state.archivedUnits[key]);
    });
    return out.sort(function (a, b) {
      return (b.archivedAt || 0) - (a.archivedAt || 0);
    });
  }

  /* Every set that still has history worth reporting: active sets plus archived
   * whole sets. Archived units are merged back into their parent set's unit
   * list so stats keep counting their questions. activeSets still filters them
   * out for practice and actionability; this view is for totals only. Rows are
   * never mutated in place: a set that gains archived units is rebuilt with
   * withUnits(), keeping the parent set id so progress keys still resolve. */
  function allSets(state, sourceSets) {
    var out = [];
    var seen = {};
    var archivedUnits = state.archivedUnits || {};

    activeSets(state, sourceSets).forEach(function (set) {
      var units = unitsOf(set);
      var present = {};
      units.forEach(function (unit) { present[unit.id] = true; });
      var merged = units.slice();
      Object.keys(archivedUnits).forEach(function (key) {
        var unit = archivedUnits[key];
        if (!unit || unit.setId !== set.id || present[unit.id]) return;
        present[unit.id] = true;
        merged.push(cloneUnit(unit));
      });
      seen[set.id] = true;
      out.push(merged.length === units.length ? set
        : withoutDeleted(state, withUnits(set, merged)));
    });

    /* A set whose every unit is archived no longer appears in activeSets, but
     * its questions and records still belong to the stats. Synthesize it from
     * the archive entries so the bank size does not shrink. */
    Object.keys(archivedUnits).forEach(function (key) {
      var unit = archivedUnits[key];
      if (!unit || seen[unit.setId] || state.archived[unit.setId]) return;
      var units = [];
      Object.keys(archivedUnits).forEach(function (otherKey) {
        var other = archivedUnits[otherKey];
        if (!other || other.setId !== unit.setId) return;
        units.push(cloneUnit(other));
      });
      seen[unit.setId] = true;
      var synthesized = withoutDeleted(state, withUnits({
        id: unit.setId,
        title: unit.setTitle || unit.setId,
        description: ''
      }, units));
      if (synthesized) out.push(synthesized);
    });

    archivedSets(state).forEach(function (set) {
      if (set.kind === 'unit' || seen[set.id]) return;
      seen[set.id] = true;
      var kept = withoutDeleted(state, set);
      if (kept) out.push(kept);
    });
    return out;
  }

  /* A set for a session: active source or local copy first, then the frozen
   * archived snapshot. */
  function findSet(state, sourceSets, setId) {
    var sets = activeSets(state, sourceSets);
    for (var i = 0; i < sets.length; i++) {
      if (sets[i].id === setId) return sets[i];
    }
    var archived = (state.archived || {})[setId];
    return archived ? withoutDeleted(state, archived) : null;
  }

  /* A set for the question browser: like findSet(), but deleted questions
   * stay in place. */
  function findBrowseSet(state, sourceSets, setId) {
    var sets = browseSets(state, sourceSets);
    for (var i = 0; i < sets.length; i++) {
      if (sets[i].id === setId) return sets[i];
    }
    return (state.archived || {})[setId] || null;
  }

  function dueCount(state, sets, now) {
    return (sets || []).reduce(function (n, set) {
      return n + dueQuestions(state, set.id, questionsOf(set), now).length;
    }, 0);
  }

  /* What the global due counters show: archived sets keep their schedules, but
   * they are not actionable until restored. */
  function activeDueCount(state, sourceSets, now) {
    return dueCount(state, activeSets(state, sourceSets), now);
  }

  /* ------------------------------------------------------------------ *
   * Progress import
   * ------------------------------------------------------------------ */
  /* Read the text of an Import JSON file. A file that does not parse, is not
   * a progress export or comes from another state version is refused with a
   * message the page can show as is; anything else sanitises to a state. */
  function parseProgressImport(raw, now) {
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: 'json', message: 'That file is not valid JSON.' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        parsed.app !== STATE_APP) {
      return {
        ok: false,
        reason: 'not-export',
        message: 'That file is not a Question Trainer progress export.'
      };
    }
    if (parsed.v !== STATE_VERSION) {
      return {
        ok: false,
        reason: 'version',
        message: 'That progress export is from an unsupported version (v=' +
          JSON.stringify(parsed.v === undefined ? null : parsed.v) + ').'
      };
    }
    return { ok: true, state: sanitizeState(parsed, now) };
  }

  /* The counts an import replaces or brings in, for the confirmation and the
   * note after it. */
  function progressSummary(state) {
    return {
      answers: state.totals.a,
      sessions: state.totals.sessions,
      questions: Object.keys(state.q).length,
      archivedSets: Object.keys(state.archived).length,
      archivedUnits: Object.keys(state.archivedUnits).length
    };
  }

  /* ------------------------------------------------------------------ *
   * Page title
   * ------------------------------------------------------------------ */
  /* "Practice · Biology — Question Trainer": what the screen is, then what it
   * is about. Empty parts drop out; with none the title is the app name. */
  function pageTitle(parts) {
    var named = (parts || []).map(text).filter(function (part) { return part; });
    return named.length ? named.join(' · ') + ' — ' + APP_TITLE : APP_TITLE;
  }

  return {
    MASTERY: MASTERY,
    SRS_INTERVALS_DAYS: SRS_INTERVALS_DAYS,
    SRS_LAST_BOX: SRS_LAST_BOX,
    SRS_KNOWN_BOX: SRS_KNOWN_BOX,
    STATE_VERSION: STATE_VERSION,
    STATE_APP: STATE_APP,
    SESSION_LENGTHS: SESSION_LENGTHS,
    DEFAULT_SESSION_LENGTH: DEFAULT_SESSION_LENGTH,
    DAY_MS: DAY_MS,
    DONT_KNOW_CHOICE: DONT_KNOW_CHOICE,
    dayKey: dayKey,
    recentDayKeys: recentDayKeys,
    letterFor: letterFor,
    choicesFor: choicesFor,
    questionKey: questionKey,
    resolveImage: resolveImage,
    normalizeFolder: normalizeFolder,
    normalizeUnit: normalizeUnit,
    buildSet: buildSet,
    unitsOf: unitsOf,
    unitOf: unitOf,
    questionsOf: questionsOf,
    cloneSet: cloneSet,
    cloneUnit: cloneUnit,
    emptyState: emptyState,
    sanitizeState: sanitizeState,
    stampState: stampState,
    mergeStates: mergeStates,
    sessionLength: sessionLength,
    nextTheme: nextTheme,
    applyAnswer: applyAnswer,
    filterSetRows: filterSetRows,
    sortSetRows: sortSetRows,
    tierOf: tierOf,
    masteryOf: masteryOf,
    dueQuestions: dueQuestions,
    selectSession: selectSession,
    makeSessionSnapshot: makeSessionSnapshot,
    endSession: endSession,
    endedEarly: endedEarly,
    restoreSessionSnapshot: restoreSessionSnapshot,
    resetSetProgress: resetSetProgress,
    resetQuestionProgress: resetQuestionProgress,
    isDeleted: isDeleted,
    deleteQuestion: deleteQuestion,
    restoreQuestion: restoreQuestion,
    withoutDeleted: withoutDeleted,
    deletedQuestions: deletedQuestions,
    setStats: setStats,
    unitStats: unitStats,
    allSetStats: allSetStats,
    statsFromRows: statsFromRows,
    overallStats: overallStats,
    activity: activity,
    streak: streak,
    troubleSpots: troubleSpots,
    archiveSet: archiveSet,
    archiveUnit: archiveUnit,
    restoreSet: restoreSet,
    restoreUnit: restoreUnit,
    activeSets: activeSets,
    browseSets: browseSets,
    archivedSets: archivedSets,
    allSets: allSets,
    findSet: findSet,
    findBrowseSet: findBrowseSet,
    dueCount: dueCount,
    activeDueCount: activeDueCount,
    parseProgressImport: parseProgressImport,
    progressSummary: progressSummary,
    pageTitle: pageTitle
  };
});
