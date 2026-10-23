/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 naromil
 *
 * Question Trainer - the app: routing, rendering, storage.
 *
 * Reads questions/index.json and the set files it lists at startup, depends on
 * window.QTCore for the pure logic. Progress lives in localStorage and, when
 * served by serve.py, is mirrored to disk. An in-flight session is only in
 * memory: a reload restarts the session, but every graded answer is saved.
 */
(function () {
  'use strict';

  var C = window.QTCore;
  var appEl = document.getElementById('app');
  var noticeEl = document.getElementById('notice');
  var pillsEl = document.getElementById('pills');

  if (!C) {
    appEl.innerHTML = '<div class="card"><h2>Could not load the trainer logic</h2>' +
      '<p>Expected <code>core.js</code> next to this page.</p></div>';
    return;
  }

  var STATE_KEY = 'questiontrainer.state.v1';
  var BANK_URL = '../questions/index.json';
  /* Bare image paths are relative to the questions/ directory, not to the
   * page or to the set file, so an archived copy resolves the same way. */
  var IMAGE_BASE = new URL('.', new URL(BANK_URL, location.href)).href;
  var SOURCE_SETS = [];
  var LOAD_ERRORS = [];
  var LOCAL_STATE_PRESENT = false;
  var PERSISTENCE_MODE = 'browser';
  var PROGRESS_PATH = '';
  var pushBusy = false;
  var pushQueued = false;
  var state = loadState();
  var session = null;
  var timer = null;

  /* ------------------------------------------------------------ helpers */
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ESCAPES[ch];
    });
  }
  function $(selector, root) { return (root || document).querySelector(selector); }
  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /* Image error events do not bubble, but they can be captured at the
   * document. A failed question image gets a readable line instead of only
   * the browser's broken-image icon. */
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.classList ||
        !img.classList.contains('q-figure-img')) return;
    if (img.parentNode && img.parentNode.classList) img.parentNode.classList.add('is-broken');
  }, true);
  function fmtTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ':' + ('0' + (total % 60)).slice(-2);
  }
  function fmtDate(ms) {
    try {
      return new Date(ms).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch (err) {
      return '';
    }
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function clampInt(n, lo, hi) { return Math.min(hi, Math.max(lo, n | 0)); }
  function letterFor(index) { return C.letterFor(index); }

  /* ------------------------------------------------------------ storage */
  function loadState() {
    var raw = null;
    try {
      var stored = localStorage.getItem(STATE_KEY);
      if (stored) {
        raw = JSON.parse(stored);
        LOCAL_STATE_PRESENT = !!raw && raw.app === C.STATE_APP && raw.v === C.STATE_VERSION;
      }
    } catch (err) { raw = null; }
    return C.sanitizeState(raw, Date.now());
  }

  function progressUrl() {
    return new URL('../api/progress', location.href).href;
  }

  function writeLocal() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* Fire-and-forget disk mirror. Posts are serialised so a slow request cannot
   * let an older state overwrite a newer one; answers never wait for it. */
  function pushProgress() {
    if (PERSISTENCE_MODE !== 'disk' || location.protocol === 'file:') return;
    if (pushBusy) { pushQueued = true; return; }
    pushBusy = true;
    var body;
    try { body = JSON.stringify(state); } catch (err) {
      pushBusy = false;
      return;
    }
    fetch(progressUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      cache: 'no-store'
    }).then(function (response) {
      var path = response.headers.get('X-Progress-Path');
      if (path) PROGRESS_PATH = path;
      if (!response.ok) throw new Error('HTTP ' + response.status);
    }).catch(function () {
      /* localStorage is still authoritative for this page. */
    }).then(function () {
      pushBusy = false;
      if (pushQueued) { pushQueued = false; pushProgress(); }
    });
  }

  function saveState() {
    var saved = writeLocal();
    pushProgress();
    return saved;
  }

  function clearStoredState() {
    try { localStorage.removeItem(STATE_KEY); } catch (err) { /* ignore */ }
  }

  /* Read the server's copy at boot. A newer (or equal) disk state wins; a 204
   * or an older copy means this browser's state is pushed immediately. */
  async function initProgress() {
    if (location.protocol === 'file:' || typeof fetch !== 'function') return;
    try {
      var response = await fetch(progressUrl(), { cache: 'no-store' });
      var path = response.headers.get('X-Progress-Path');
      if (path) PROGRESS_PATH = path;
      if (response.status === 204) {
        PERSISTENCE_MODE = 'disk';
        pushProgress();
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var raw = await response.json();
      PERSISTENCE_MODE = 'disk';
      if (!raw || typeof raw !== 'object' || raw.app !== C.STATE_APP ||
          raw.v !== C.STATE_VERSION) {
        pushProgress();
        return;
      }
      var serverState = C.sanitizeState(raw, Date.now());
      var localUpdated = LOCAL_STATE_PRESENT ? state.updated : -Infinity;
      if (serverState.updated >= localUpdated) {
        state = serverState;
        writeLocal();
        applyTheme();
        return;
      }
      pushProgress();
    } catch (err) {
      /* Plain static server or file://: keep working from localStorage. */
      PERSISTENCE_MODE = 'browser';
    }
  }

  /* ------------------------------------------------------------ theming */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme || 'auto');
  }

  /* ------------------------------------------------------ feedback effects */
  /* Right and wrong are signalled twice: a one-shot animation on the question
   * card, and a short synthesised tone. The tone is generated with WebAudio,
   * so there are no audio assets to ship, and it is only ever created from the
   * answer click (a user gesture), which is also what autoplay policy wants.
   * Settings can mute it; motion follows prefers-reduced-motion in the CSS. */
  var audioCtx = null;
  var hasAudioCtx = false;

  function audio() {
    if (hasAudioCtx) return audioCtx;
    hasAudioCtx = true;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    try { audioCtx = Ctor ? new Ctor() : null; } catch (err) { audioCtx = null; }
    return audioCtx;
  }

  /* One enveloped note; `at` is an absolute AudioContext time. */
  function note(ctx, freq, at, dur, type, peak) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.012);
    gain.gain.setValueAtTime(peak, at + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function playVerdict(correct) {
    if (!state.settings.sound) return;
    var ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    var at = ctx.currentTime + 0.01;
    if (correct) {
      note(ctx, 660, at, 0.12, 'sine', 0.08);
      note(ctx, 990, at + 0.11, 0.16, 'sine', 0.08);
    } else {
      note(ctx, 196, at, 0.17, 'square', 0.05);
      note(ctx, 147, at + 0.13, 0.22, 'square', 0.05);
    }
  }

  /* The card carries the effect class for one animation; showQuestion drops it
   * again, so the same node can replay it on the next question. */
  function flashCard(correct) {
    var card = document.getElementById('qcard');
    if (card) card.classList.add(correct ? 'fx-correct' : 'fx-wrong');
  }

  /* ------------------------------------------------------------ data load */
  /* A set is a directory under questions/. questions/index.json names the
   * directories; each one has an index.json naming its unit files. Every error
   * is prefixed with the path it came from. */
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      return response.text();
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('invalid JSON: ' + err.message);
      }
    });
  }

  function fetchUnit(name, file, folderUrl) {
    return fetchJSON(new URL(file, folderUrl)).then(function (raw) {
      return { file: name + '/' + file, raw: raw };
    }).catch(function (err) {
      return { file: name + '/' + file, error: err.message };
    });
  }

  /* Read one set directory: its index.json, then every unit it lists. A bad
   * unit is reported and dropped; a bad directory index drops the whole set. */
  async function loadFolder(name, indexUrl) {
    var folderUrl = new URL(name + '/', indexUrl);
    var descriptor;
    try {
      descriptor = await fetchJSON(new URL('index.json', folderUrl));
    } catch (err) {
      return { set: null, errors: [name + '/index.json: ' + err.message] };
    }

    var folder;
    try {
      folder = C.normalizeFolder(descriptor, name);
    } catch (err) {
      return { set: null, errors: [name + '/index.json: ' + err.message] };
    }

    var entries = await Promise.all(folder.units.map(function (file) {
      return fetchUnit(name, file, folderUrl);
    }));
    var built = C.buildSet(folder, entries);
    return { set: built.set, errors: built.errors };
  }

  async function loadBank() {
    SOURCE_SETS = [];
    LOAD_ERRORS = [];
    if (location.protocol === 'file:') {
      LOAD_ERRORS.push('This page was opened from disk. Browsers block reading ' +
        'questions/index.json over file://. Serve the repository root over HTTP and open /app/.');
      return;
    }
    var indexUrl = new URL(BANK_URL, location.href);
    var index;
    try {
      index = await fetchJSON(indexUrl);
    } catch (err) {
      LOAD_ERRORS.push('Could not read ' + indexUrl.pathname + ': ' + err.message);
      return;
    }
    if (!index || typeof index !== 'object' || Array.isArray(index) ||
        !Array.isArray(index.sets)) {
      LOAD_ERRORS.push('questions/index.json must be an object with a "sets" array of ' +
        'set directory names.');
      return;
    }

    var names = [];
    index.sets.forEach(function (value) {
      var name = typeof value === 'string' ? value.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        LOAD_ERRORS.push('questions/index.json: ' + JSON.stringify(value) +
          ' is not a set directory name.');
        return;
      }
      names.push(name);
    });

    var results = await Promise.all(names.map(function (name) {
      return loadFolder(name, indexUrl);
    }));
    var seen = {};
    results.forEach(function (result, i) {
      LOAD_ERRORS = LOAD_ERRORS.concat(result.errors);
      if (!result.set) return;
      if (seen[result.set.id]) {
        LOAD_ERRORS.push(names[i] + ': duplicate set id "' + result.set.id +
          '" (already loaded from another directory).');
        return;
      }
      seen[result.set.id] = true;
      SOURCE_SETS.push(result.set);
    });
  }

  function noticeHTML() {
    if (!LOAD_ERRORS.length) return '';
    return '<div class="warnbox"><b>Question data problems</b><ul>' +
      LOAD_ERRORS.map(function (error) { return '<li>' + esc(error) + '</li>'; }).join('') +
      '</ul><p class="small">Edit <code>questions/index.json</code> and the files it lists. ' +
      '<a href="#/format">See the format</a>.</p></div>';
  }

  function renderNotice() {
    if (noticeEl) noticeEl.innerHTML = noticeHTML();
  }

  /* ------------------------------------------------------------ chrome */
  function renderPills() {
    var sets = C.allSets(state, SOURCE_SETS);
    if (!pillsEl) return;
    if (!sets.length) {
      pillsEl.innerHTML = '';
      return;
    }
    var stats = C.overallStats(state, sets);
    pillsEl.innerHTML =
      '<span class="pill" title="Questions answered at least once">' +
        stats.seen + '/' + stats.bankSize + ' seen</span>' +
      '<span class="pill" title="Questions answered right on the first attempt">' +
        stats.accuracy + '% right</span>' +
      (stats.streak ? '<span class="pill" title="Consecutive days with practice">' +
        plural(stats.streak, 'day') + ' streak</span>' : '') +
      (stats.due ? '<span class="pill" title="Due for spaced review">↻ ' +
        stats.due + ' due</span>' : '');
  }

  function setActiveNav(path) {
    /* Practice belongs to the set list, not to its own nav entry. */
    var active = path === '/practice' ? '/' : path;
    $$('#nav a').forEach(function (link) {
      if (link.getAttribute('data-route') === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* The session clock measures answering time: it runs while a question is
   * open and stops the moment the answer is graded, so reading the explanation
   * never counts. `elapsed` holds the accumulated milliseconds. */
  function elapsedMs() {
    if (!session) return 0;
    return session.elapsed + (session.runningSince ? Date.now() - session.runningSince : 0);
  }

  function paintTimer() {
    var el = document.getElementById('timer');
    if (!el) return;
    var paused = !(session && session.runningSince);
    el.textContent = (paused ? '⏸ ' : '') + fmtTime(elapsedMs());
    el.classList.toggle('is-paused', paused);
    el.title = paused ? 'Paused while you review this answer' : 'Time spent answering';
  }

  function resumeTimer() {
    if (!session || session.runningSince) return;
    session.runningSince = Date.now();
    stopTimer();
    paintTimer();
    timer = setInterval(paintTimer, 1000);
  }

  function pauseTimer() {
    if (session && session.runningSince) {
      session.elapsed += Date.now() - session.runningSince;
      session.runningSince = null;
    }
    stopTimer();
    paintTimer();
  }

  /* ------------------------------------------------------------ routing */
  function parseHash() {
    var raw = location.hash.replace(/^#/, '') || '/';
    var cut = raw.indexOf('?');
    return {
      path: cut < 0 ? raw : raw.slice(0, cut),
      params: new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1))
    };
  }

  function render() {
    pauseTimer();
    var route = parseHash();
    setActiveNav(route.path);
    renderNotice();
    renderPills();

    /* Leaving practice abandons the finished session so the same link starts
     * a fresh one next time. */
    if (route.path !== '/practice' && session && session.index >= session.questions.length) {
      session = null;
    }

    if (route.path === '/archive') renderArchive();
    else if (route.path === '/stats') renderStats();
    else if (route.path === '/settings') renderSettings(route);
    else if (route.path === '/format') renderFormat();
    else if (route.path === '/practice') renderPractice(route.params);
    else renderHome();
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------ home */
  function practiceHref(setId, unitId, mode) {
    var href = '#/practice?set=' + encodeURIComponent(setId);
    if (unitId) href += '&unit=' + encodeURIComponent(unitId);
    if (mode) href += '&mode=' + mode;
    return href;
  }

  /* One unit inside a set card: its coverage, what is due, and the same three
   * options a set has. */
  function unitRowHTML(row) {
    var meta = row.attempted + '/' + row.total + ' answered' +
      (row.attempted ? ' · ' + row.accuracy + '% first try' : '');
    return '<li class="unit-row">' +
      '<div class="unit-head"><b>' + esc(row.title) + '</b>' +
        (row.due ? '<span class="tag due">' + row.due + ' due</span>' : '') + '</div>' +
      '<div class="bar unit-bar"><i style="width:' + row.coverage + '%"></i></div>' +
      '<div class="meta small">' + meta + '</div>' +
      '<div class="row unit-actions">' +
        '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.setId, row.id, null) +
          '">Practice</a>' +
        '<a class="btn btn-sm" href="' + practiceHref(row.setId, row.id, 'review') +
          '">Review</a>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-archive-unit="' +
          esc(row.id) + '" data-set="' + esc(row.setId) + '">Archive</button>' +
      '</div></li>';
  }

  /* A set card is a long row, not a tile. A set made of several units also gets
   * a units panel on its right, each unit carrying its own three options. */
  function setCard(row) {
    var tier = row.tier;
    var multi = row.units > 1;
    var due = row.due ? '<span class="tag due">' + row.due + ' due</span>' : '';
    return '<article class="card set-card" data-units="' + row.units + '"' +
      (multi ? ' data-multi="1"' : '') + '>' +
      '<div class="set-main">' +
        '<div class="spread"><h3>' + esc(row.title) + '</h3>' +
          '<span class="row">' +
            '<span class="tag ' + tier.key + '">' + tier.label + '</span>' +
            (multi ? '<span class="tag units">' + plural(row.units, 'unit') + '</span>' : '') +
          '</span></div>' +
        (row.description ? '<p class="muted small">' + esc(row.description) + '</p>' : '') +
        '<div class="bar tier-' + tier.key + '"><i style="width:' + row.points + '%"></i></div>' +
        '<div class="meta">' + row.points + '% mastery · ' +
          row.attempted + '/' + row.total + ' answered · ' +
          row.accuracy + '% first try ' + due + '</div>' +
        '<div class="row set-actions">' +
          '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.id, null, null) +
            '">Practice</a>' +
          '<a class="btn btn-sm" href="' + practiceHref(row.id, null, 'review') +
            '">Review</a>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-archive="' + esc(row.id) +
            '">Archive</button>' +
        '</div>' +
      '</div>' +
      (multi
        ? '<div class="set-units"><h4>Units</h4><ul class="unit-list">' +
          row.unitRows.map(unitRowHTML).join('') + '</ul></div>'
        : '') +
      '</article>';
  }

  function bindArchiveButtons() {
    $$('[data-archive]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        archiveSet(button.getAttribute('data-archive'));
      });
    });
    $$('[data-archive-unit]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        archiveUnit(button.getAttribute('data-set'), button.getAttribute('data-archive-unit'));
      });
    });
  }

  function archiveSet(setId) {
    var set = C.findSet(state, SOURCE_SETS, setId);
    if (!set) return;
    if (!window.confirm('Archive "' + set.title + '"? You can restore it from the Archive page.')) {
      return;
    }
    C.archiveSet(state, set, Date.now());
    if (!saveState()) {
      window.alert('The archive could not be saved because browser storage is full.');
    }
    render();
  }

  function archiveUnit(setId, unitId) {
    var set = C.findSet(state, SOURCE_SETS, setId);
    var unit = set ? C.unitOf(set, unitId) : null;
    if (!unit) return;
    if (!window.confirm('Archive the unit "' + unit.title + '" of ' + set.title +
        '? You can restore it from the Archive page.')) {
      return;
    }
    C.archiveUnit(state, set, unit, Date.now());
    if (!saveState()) {
      window.alert('The archive could not be saved because browser storage is full.');
    }
    render();
  }

  function renderHome() {
    var active = C.activeSets(state, SOURCE_SETS);
    var archived = C.archivedSets(state);
    var all = C.allSets(state, SOURCE_SETS);
    var stats = C.overallStats(state, all);
    var rows = active.map(function (set) { return C.setStats(state, set, Date.now()); });
    var unitCount = rows.reduce(function (n, row) { return n + row.units; }, 0);

    var html = '<div class="hero">' +
      '<div class="card"><h1>Question Trainer</h1>' +
      '<p class="muted">Pick one question set and work through it. A set is a folder of one ' +
      'or more units; practice it whole or one unit at a time. Every session stays inside ' +
      'that set; there is no mixed practice. Correct answers build mastery, ' +
      'spaced review brings questions back, and finished sets or units can be archived.</p>' +
      '</div>' +
      '<div class="card"><div class="statgrid">' +
        '<div class="stat"><b>' + stats.seen + '<span class="muted">/' +
          stats.bankSize + '</span></b><span>questions seen</span></div>' +
        '<div class="stat"><b>' + stats.accuracy + '%</b><span>first-try correct</span></div>' +
        '<div class="stat"><b>' + stats.mastered + '</b><span>sets mastered</span></div>' +
        '<div class="stat"><b>' + stats.due + '</b><span>due for review</span></div>' +
      '</div></div></div>';

    if (rows.length) {
      var heading = unitCount !== rows.length
        ? plural(rows.length, 'set') + ' · ' + plural(unitCount, 'unit')
        : plural(rows.length, 'set');
      html += '<section class="set-list"><h2>Question sets · ' + heading +
        '</h2><div class="sets">' + rows.map(setCard).join('') + '</div></section>';
    } else {
      html += '<div class="card"><h2>' +
        (archived.length ? 'All sets are archived' : 'No question sets loaded') + '</h2>' +
        '<p class="muted">' + (archived.length
          ? 'Restore a set from the Archive to practice it again.'
          : 'Add your sets to <code>questions/index.json</code>, then reload the page. ' +
            'The format is on the <a href="#/format">format page</a>.') + '</p>' +
        (archived.length ? '<p><a class="btn btn-primary" href="#/archive">Open Archive</a></p>' : '') +
        '</div>';
    }

    appEl.innerHTML = html;
    bindArchiveButtons();
  }

  /* ------------------------------------------------------------ archive */
  function sourceSet(setId) {
    for (var i = 0; i < SOURCE_SETS.length; i++) {
      if (SOURCE_SETS[i].id === setId) return SOURCE_SETS[i];
    }
    return null;
  }

  function bindRestoreButtons() {
    $$('[data-restore]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        restoreSet(button.getAttribute('data-restore'));
      });
    });
    $$('[data-restore-unit]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        restoreUnit(button.getAttribute('data-set'), button.getAttribute('data-restore-unit'));
      });
    });
  }

  function restoreSet(setId) {
    C.restoreSet(state, setId, sourceSet(setId), Date.now());
    saveState();
    render();
  }

  function restoreUnit(setId, unitId) {
    C.restoreUnit(state, unitId, sourceSet(setId), Date.now());
    saveState();
    render();
  }

  function archivedSetCard(entry, now) {
    var row = C.setStats(state, entry, now);
    var inSource = !!sourceSet(entry.id);
    return '<article class="card set-card" data-units="' + row.units + '"' +
      (row.units > 1 ? ' data-multi="1"' : '') + '>' +
      '<div class="set-main">' +
        '<div class="spread"><h3>' + esc(row.title) + '</h3>' +
          '<span class="tag archived">archived</span></div>' +
        '<div class="set-text">' +
          (row.description ? '<p class="muted small">' + esc(row.description) + '</p>' : '') +
          '<p class="small muted">Archived ' + esc(fmtDate(entry.archivedAt)) + ' · ' +
            plural(row.units, 'unit') + '. ' +
            (inSource
              ? 'The source folder is still listed in <code>questions/index.json</code>.'
              : 'The source folder is no longer listed; the archived copy is kept in this browser.') +
          '</p>' +
        '</div>' +
        '<div class="bar tier-' + row.tier.key + '"><i style="width:' + row.points +
          '%"></i></div>' +
        '<div class="meta">' + row.points + '% mastery · ' +
          row.attempted + '/' + row.total + ' answered · ' +
          row.accuracy + '% first try' + (row.due ? ' · ' + row.due + ' due' : '') + '</div>' +
        '<div class="row set-actions">' +
          '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.id, null, null) +
            '">Practice</a>' +
          '<a class="btn btn-sm" href="' + practiceHref(row.id, null, 'review') +
            '">Review</a>' +
          '<button type="button" class="btn btn-sm" data-restore="' + esc(row.id) +
            '">Restore</button>' +
        '</div>' +
      '</div>' +
      (row.units > 1
        ? '<div class="set-units"><h4>Units</h4><ul class="unit-list">' +
          row.unitRows.map(function (unitRow) {
            return '<li class="unit-row"><div class="unit-head"><b>' + esc(unitRow.title) +
              '</b></div><div class="meta small">' + unitRow.attempted + '/' +
              unitRow.total + ' answered' + (unitRow.due ? ' · ' + unitRow.due + ' due' : '') +
              '</div></li>';
          }).join('') + '</ul></div>'
        : '') +
      '</article>';
  }

  function archivedUnitCard(entry, now) {
    var row = C.unitStats(state, { id: entry.setId }, entry, now);
    return '<article class="card set-card" data-units="0">' +
      '<div class="set-main">' +
        '<div class="spread"><h3>' + esc(entry.title) + '</h3>' +
          '<span class="tag archived">archived unit</span></div>' +
        '<p class="small muted">Unit of ' + esc(entry.setTitle || entry.setId) + ', archived ' +
          esc(fmtDate(entry.archivedAt)) + '.</p>' +
        '<div class="bar"><i style="width:' + row.coverage + '%"></i></div>' +
        '<div class="meta">' + row.attempted + '/' + row.total + ' answered' +
          (row.attempted ? ' · ' + row.accuracy + '% first try' : '') +
          (row.due ? ' · ' + row.due + ' due' : '') + '</div>' +
        '<div class="row set-actions">' +
          '<button type="button" class="btn btn-sm btn-primary" data-restore-unit="' +
            esc(entry.id) + '" data-set="' + esc(entry.setId) + '">Restore</button>' +
        '</div>' +
      '</div></article>';
  }

  function renderArchive() {
    var rows = C.archivedSets(state);
    var now = Date.now();
    var html = '<div class="card"><h1>Archive</h1>' +
      '<p class="muted">Archived sets and units keep their question copy and progress in this ' +
      'browser (mirrored to disk when served with <code>./qt</code>). Restore one to put it ' +
      'back on the set list.</p></div>';

    if (!rows.length) {
      html += '<div class="card"><h2>Nothing archived</h2>' +
        '<p class="muted">Archive a finished set or unit from its card on the ' +
        '<a href="#/">set list</a>.</p>' +
        '</div>';
    } else {
      html += '<div class="sets">' + rows.map(function (entry) {
        return entry.kind === 'unit'
          ? archivedUnitCard(entry, now)
          : archivedSetCard(entry, now);
      }).join('') + '</div>';
    }

    appEl.innerHTML = html;
    bindRestoreButtons();
  }

  /* ------------------------------------------------------------ practice */
  function sameCfg(a, b) {
    return a && a.setId === b.setId && a.mode === b.mode && a.length === b.length &&
      (a.unitId || '') === (b.unitId || '');
  }

  function createSession(cfg, preselect) {
    var set = C.findSet(state, SOURCE_SETS, cfg.setId);
    if (!set) return null;
    var questions = preselect || C.selectSession(state, set.id, C.questionsOf(set, cfg.unitId), {
      mode: cfg.mode === 'review' ? 'review' : 'practice',
      length: cfg.length,
      now: Date.now()
    });
    session = {
      cfg: cfg,
      set: set,
      questions: questions,
      index: 0,
      results: [],
      selected: null,
      excluded: {},
      checked: false,
      elapsed: 0,
      runningSince: null
    };
    if (session.questions.length) {
      state.totals.sessions += 1;
      saveState();
    }
    return session;
  }

  function modeLabel(mode) {
    if (mode === 'review') return 'Spaced review';
    if (mode === 'retry') return 'Retry misses';
    return 'Practice';
  }

  function sessionTitle() {
    if (!session) return '';
    var unit = C.unitOf(session.set, session.cfg.unitId);
    return unit ? session.set.title + ' · ' + unit.title : session.set.title;
  }

  function renderMissingSet(setId) {
    appEl.innerHTML = '<div class="card"><h2>Question set not found</h2>' +
      '<p>No set with id <code>' + esc(setId) + '</code> is loaded from ' +
      '<code>questions/index.json</code> or archived.</p>' +
      '<p><a class="btn btn-primary" href="#/">Back to sets</a></p></div>';
  }

  function renderMissingUnit(set, unitId) {
    appEl.innerHTML = '<div class="card"><h2>Unit not found</h2>' +
      '<p>' + esc(set.title) + ' has no unit with id <code>' + esc(unitId) +
      '</code>. It may have been archived or removed from the folder.</p>' +
      '<p><a class="btn btn-primary" href="#/">Back to sets</a></p></div>';
  }

  function renderEmptySession() {
    var review = session && session.cfg.mode === 'review';
    appEl.innerHTML = '<div class="card"><h2>' +
      (review ? 'Nothing is due for review' : 'Nothing to practice here') + '</h2>' +
      '<p class="muted">' + (review
        ? 'Every question here that you have answered is scheduled for a later date. ' +
          'Missed questions come back immediately; the rest come back within a day or two.'
        : 'This has no questions to serve.') + '</p>' +
      '<div class="row">' +
        '<a class="btn btn-primary" href="' + practiceHref(
          session ? session.cfg.setId : '', session ? session.cfg.unitId : '', null) +
          '">Practice this again</a>' +
        '<a class="btn" href="#/">Back to sets</a>' +
      '</div></div>';
  }

  function renderPractice(params) {
    var setId = params.get('set') || '';
    var unitId = params.get('unit') || '';
    var set = C.findSet(state, SOURCE_SETS, setId);
    if (!set) { renderMissingSet(setId); return; }
    /* A unit link names a unit of this set, archived or not. */
    if (unitId && !C.unitOf(set, unitId)) { renderMissingUnit(set, unitId); return; }

    var mode = params.get('mode');
    if (mode !== 'review' && mode !== 'retry') mode = 'practice';
    if (mode === 'retry' && (!session || session.cfg.setId !== setId ||
        session.cfg.mode !== 'retry')) {
      mode = 'practice';
    }
    /* Practice honours the practice-all switch; review ignores it and keeps
     * the chosen length as the cap on what is due. A retry link carries its
     * own count. The count is over the questions this session can serve: the
     * unit's own list, or the whole set. */
    var pool = C.questionsOf(set, unitId);
    var requested = parseInt(params.get('n'), 10);
    var defaultLength = mode === 'review'
      ? state.settings.length
      : C.sessionLength(state.settings, pool.length);
    var cfg = {
      setId: set.id,
      unitId: unitId,
      mode: mode,
      length: clampInt(requested > 0 ? requested : defaultLength, 1, 50)
    };
    if (!session || !sameCfg(session.cfg, cfg)) createSession(cfg);

    if (!session || !session.questions.length) { renderEmptySession(); return; }
    if (session.index >= session.questions.length) { renderResults(); return; }

    appEl.innerHTML =
      '<div class="practice-view">' +
        '<div class="prac-head">' +
          '<a class="btn btn-ghost btn-sm" href="#/">← Sets</a>' +
          '<div class="head-title"><b>' + esc(sessionTitle()) + '</b> <span class="muted small">· ' +
            esc(modeLabel(session.cfg.mode)) + '</span></div>' +
          '<div class="dots" id="dots"></div>' +
          '<span class="pill" id="timer">0:00</span>' +
        '</div>' +
        '<div class="card" id="qcard"></div>' +
      '</div>';

    showQuestion(session.index);
  }

  function resultAt(index) {
    for (var i = 0; i < session.results.length; i++) {
      if (session.results[i].index === index) return session.results[i];
    }
    return null;
  }

  function renderDots() {
    var dots = document.getElementById('dots');
    if (!dots) return;
    dots.innerHTML = session.questions.map(function (question, i) {
      var result = resultAt(i);
      var cls = result ? (result.correct ? 'correct' : 'wrong')
        : (i === session.index && !session.checked ? 'current' : '');
      var status = result ? (result.correct ? 'correct' : 'incorrect') : 'not answered';
      var title = 'Question ' + (i + 1) + ' · ' + status + ' · ' +
        question.question.slice(0, 60);
      return '<span class="dot ' + cls + '" title="' + esc(title) + '"></span>';
    }).join('');
  }

  /* The row carries every state class; the choice button inside it chooses the
   * answer and the trailing button is the cross-out toggle. */
  function rowClass(index, question) {
    var cls = session.checked ? 'choice-row' : 'choice-row live';
    if (session.excluded[index]) cls += ' is-excluded';
    if (!session.checked) return cls + (index === session.selected ? ' selected' : '');
    if (index === question.answer) return cls + ' is-correct';
    if (index === session.selected) return cls + ' is-wrong';
    return cls + ' dimmed';
  }

  /* Option eliminator: cross out the choices you have ruled out. It is
   * undoable and never changes the answer by itself. */
  function elimHTML(index, letter) {
    var excluded = !!session.excluded[index];
    var label = (excluded ? 'Include' : 'Exclude') + ' choice ' + letter;
    return '<button type="button" class="elim" data-exclude="' + index + '"' +
      ' aria-pressed="' + (excluded ? 'true' : 'false') + '" aria-label="' + label +
      '" title="' + label + '"><span aria-hidden="true">✕</span></button>';
  }

  function choiceHTML(index, question, text) {
    var letter = letterFor(index);
    return '<div class="' + rowClass(index, question) + '">' +
      '<button type="button" class="choice" data-i="' + index + '" aria-pressed="false">' +
        '<span class="letter">' + letter + '</span>' +
        '<span class="choice-text">' + esc(text) + '</span></button>' +
      elimHTML(index, letter) + '</div>';
  }

  function showQuestion(index) {
    var question = session.questions[index];
    session.selected = null;
    session.checked = false;
    session.excluded = {};
    renderDots();

    var choices = question.choices.map(function (text, i) {
      return '<li class="choice-item">' + choiceHTML(i, question, text) + '</li>';
    }).join('');

    var card = document.getElementById('qcard');
    card.className = 'card';
    card.innerHTML =
      '<div class="q-meta">' +
        '<span class="tag">' + esc(session.set.title) + '</span>' +
        (session.cfg.unitId ? '<span class="tag units">' +
          esc((C.unitOf(session.set, session.cfg.unitId) || {}).title || '') + '</span>' : '') +
        '<span class="tag">' + (index + 1) + ' of ' + session.questions.length + '</span>' +
      '</div>' +
      passageHTML(question.passage) +
      figureHTML(question) +
      '<div class="stem">' + esc(question.question) + '</div>' +
      '<ul class="choices" id="choices">' + choices + '</ul>' +
      '<div class="actions">' +
        '<button type="button" class="btn btn-primary" id="action" disabled>' +
          'Check answer</button>' +
        '<span class="kbdhint"><kbd>A</kbd>–<kbd>Z</kbd> choose · ' +
          '<kbd>1</kbd>–<kbd>9</kbd> choose · <kbd>Enter</kbd> check / next</span>' +
      '</div>' +
      '<div id="feedback" aria-live="polite"></div>';

    $$('#choices .choice').forEach(function (button) {
      button.addEventListener('click', function () {
        selectChoice(parseInt(button.getAttribute('data-i'), 10));
      });
    });
    $$('#choices .elim').forEach(function (button) {
      button.addEventListener('click', function () {
        toggleExcluded(parseInt(button.getAttribute('data-exclude'), 10));
      });
    });
    document.getElementById('action').addEventListener('click', action);
    resumeTimer();
  }

  /* Re-paint every row from the session state, including the cross-out buttons. */
  function syncChoices() {
    var question = session.questions[session.index];
    $$('#choices .choice-row').forEach(function (row, i) {
      var letter = letterFor(i);
      var excluded = !!session.excluded[i];
      var label = (excluded ? 'Include' : 'Exclude') + ' choice ' + letter;
      row.className = rowClass(i, question);
      var choice = $('.choice', row);
      choice.setAttribute('aria-pressed', String(i === session.selected));
      choice.disabled = session.checked;
      var elim = $('.elim', row);
      elim.disabled = session.checked;
      elim.setAttribute('aria-pressed', String(excluded));
      elim.setAttribute('aria-label', label);
      elim.setAttribute('title', label);
    });
    document.getElementById('action').disabled = session.selected == null;
  }

  function selectChoice(index) {
    /* A crossed-out choice is out of the running; undo the cross-out first. */
    if (session.checked || session.excluded[index]) return;
    session.selected = index;
    syncChoices();
  }

  /* Crossing out is a note to self, so a choice can never be both chosen and
   * crossed out: excluding the selected choice clears the selection. */
  function toggleExcluded(index) {
    if (session.checked) return;
    if (session.excluded[index]) delete session.excluded[index];
    else {
      session.excluded[index] = true;
      if (session.selected === index) session.selected = null;
    }
    syncChoices();
  }

  function action() {
    if (!session.checked) checkAnswer();
    else nextQuestion();
  }

  function textWithBreaks(value) {
    return esc(value).replace(/\n/g, '<br>');
  }

  function whyBlockHTML(question, index) {
    var text = question.explanations ? question.explanations[index] : '';
    if (!text) return '';
    var letter = letterFor(index);
    return '<div class="choice-why"><b>Choice ' + letter + ' is ' +
      (index === question.answer ? 'correct' : 'incorrect') + '.</b> ' +
      textWithBreaks(text) + '</div>';
  }

  function explanationHTML(question) {
    if (!question.explanation) return '';
    return '<div class="explanation">' +
      question.explanation.split(/\n{2,}/).map(function (block) {
        return '<p>' + textWithBreaks(block) + '</p>';
      }).join('') + '</div>';
  }

  /* Read-only rendering of a question, used in review lists. */
  function staticQuestionHTML(question) {
    var choices = question.choices.map(function (text, i) {
      var letter = letterFor(i);
      var cls = i === question.answer ? ' is-correct' : ' dimmed';
      return '<li class="choice-item"><div class="choice-row is-static' + cls + '">' +
        '<div class="choice"><span class="letter">' + letter + '</span>' +
        '<span class="choice-text">' + esc(text) + '</span></div></div>' +
        whyBlockHTML(question, i) + '</li>';
    }).join('');
    return passageHTML(question.passage) +
      figureHTML(question) +
      '<div class="stem">' + esc(question.question) + '</div>' +
      '<ul class="choices">' + choices + '</ul>' +
      explanationHTML(question);
  }

  /* The stimulus block: blank lines separate paragraphs, lines starting with a
   * bullet become a list, and consecutive lines join into one paragraph. */
  function passageHTML(text) {
    if (!text) return '';
    return '<div class="stimulus">' + richTextHTML(text) + '</div>';
  }

  /* Optional question figure, placed between the passage and the stem. The
   * error text is revealed only if the browser fails to load the image. */
  function figureHTML(question) {
    if (!question.image) return '';
    var src = C.resolveImage(question.image, IMAGE_BASE);
    if (!src) return '';
    return '<figure class="q-figure">' +
      '<img class="q-figure-img" src="' + esc(src) + '" alt="' +
        esc(question.imageAlt || '') + '" loading="lazy" decoding="async">' +
      '<div class="figure-error">Image could not be loaded.</div>' +
      (question.imageCaption
        ? '<figcaption>' + esc(question.imageCaption) + '</figcaption>' : '') +
    '</figure>';
  }

  function richTextHTML(value) {
    var html = '';
    value.split(/\n{2,}/).forEach(function (block) {
      var parts = [];
      block.split('\n').forEach(function (raw) {
        var line = raw.trim();
        if (!line) return;
        var bullet = /^[•‣▪]\s*/.exec(line);
        if (bullet) {
          parts.push({ kind: 'li', text: line.slice(bullet[0].length) });
          return;
        }
        var last = parts[parts.length - 1];
        if (last && last.kind === 'p') last.text += ' ' + line;
        else parts.push({ kind: 'p', text: line });
      });
      var inList = false;
      parts.forEach(function (part) {
        if (part.kind === 'li') {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + esc(part.text) + '</li>';
          return;
        }
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + esc(part.text) + '</p>';
      });
      if (inList) html += '</ul>';
    });
    return html;
  }

  function checkAnswer() {
    if (session.checked || session.selected == null) return;
    var question = session.questions[session.index];
    var result = C.applyAnswer(state, session.set.id, question, session.selected, Date.now());
    session.checked = true;
    pauseTimer();

    var record = {
      index: session.index,
      question: question,
      chosen: result.chosen,
      correct: result.correct,
      expected: result.expected,
      pointsDelta: result.pointsDelta
    };
    session.results.push(record);
    saveState();
    renderPills();

    syncChoices();
    $$('#choices .choice-item').forEach(function (item, i) {
      if (question.explanations && question.explanations[i]) {
        item.insertAdjacentHTML('beforeend', whyBlockHTML(question, i));
      }
    });

    var last = session.index === session.questions.length - 1;
    var actionBtn = document.getElementById('action');
    actionBtn.textContent = last ? 'See results' : 'Next question';
    actionBtn.disabled = false;

    var mastery = result.pointsDelta === 0
      ? '<span class="muted">mastery unchanged (already at 0 or 100)</span>'
      : (result.pointsDelta > 0 ? '+' : '') + result.pointsDelta + ' mastery in ' +
        esc(session.set.title) + ' → ' + result.pointsAfter + '%';

    var gapDays = C.SRS_INTERVALS_DAYS[result.boxAfter];
    var when = gapDays === 0
      ? 'back in the next review session'
      : 'next review in ' + plural(gapDays, 'day');

    document.getElementById('feedback').innerHTML =
      '<div class="feedback ' + (result.correct ? 'correct' : 'incorrect') + '">' +
        '<div class="verdict"><span class="icon">' + (result.correct ? '✓' : '✗') + '</span>' +
          (result.correct
            ? 'Correct' + (result.coin === 'repeat' ? ' (already answered right before)' : '')
            : 'Not quite — the answer is ' + result.expected +
              (result.chosen !== result.expected ? ' (you chose ' + result.chosen + ')' : '')) +
        '</div>' +
        explanationHTML(question) +
        '<div class="small muted" style="margin-top:.6rem">' + mastery + ' · ' + when +
        '</div>' +
      '</div>';
    renderDots();
    flashCard(result.correct);
    playVerdict(result.correct);
  }

  function nextQuestion() {
    if (!session.checked) return;
    session.index += 1;
    if (session.index >= session.questions.length) renderResults();
    else showQuestion(session.index);
    window.scrollTo(0, 0);
  }

  function renderResults() {
    pauseTimer();
    var results = session.results.slice().sort(function (a, b) { return a.index - b.index; });
    var correct = results.filter(function (r) { return r.correct; }).length;
    var missed = results.filter(function (r) { return !r.correct; });
    var percent = results.length ? Math.round((correct / results.length) * 100) : 0;

    var delta = results.reduce(function (sum, r) { return sum + r.pointsDelta; }, 0);
    var deltas = delta === 0 ? ''
      : '<span class="tag ' + (delta > 0 ? 'mastered' : 'warn') + '">' +
        esc(sessionTitle()) + ' ' + (delta > 0 ? '+' : '') + delta + '</span>';

    var rows = results.map(function (r, i) {
      var question = r.question;
      return '<div class="result-row">' +
        '<span class="n">' + (i + 1) + '</span>' +
        '<span class="' + (r.correct ? 'ok' : 'no') + '">' + (r.correct ? '✓' : '✗') + '</span>' +
        '<span class="grow">' + esc(question.question.slice(0, 80)) +
          (question.question.length > 80 ? '…' : '') + '</span>' +
        '<span class="muted small">' + r.chosen +
          (r.correct ? '' : ' → ' + r.expected) + '</span>' +
      '</div>';
    }).join('');

    var review = missed.map(function (r) {
      return '<div class="review-item"><div class="q-meta"><span class="tag">' +
        esc(sessionTitle()) + '</span><span class="tag warn">you chose ' + r.chosen +
        '</span></div>' + staticQuestionHTML(r.question) + '</div>';
    }).join('');

    var time = fmtTime(elapsedMs());
    appEl.innerHTML =
      '<div class="card"><div class="spread"><h1>Session complete</h1>' +
        '<span class="muted">' + esc(sessionTitle()) + ' · ' +
        esc(modeLabel(session.cfg.mode)) + ' · ' + time + '</span></div>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + correct + '/' + results.length +
          '</b><span>correct</span></div>' +
        '<div class="stat"><b>' + percent + '%</b><span>this session</span></div>' +
        '<div class="stat"><b>' + missed.length + '</b><span>coming back in review</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:.9rem">' +
        (missed.length ? '<button class="btn btn-primary" id="retry">Retry the ' +
          plural(missed.length, 'missed question') + '</button>' : '') +
        '<button type="button" class="btn" id="again">Practice again</button>' +
        '<a class="btn btn-ghost" href="#/">Back to sets</a>' +
      '</div>' +
      (deltas ? '<div class="row" style="margin-top:.7rem">' +
        '<span class="muted small">Mastery:</span>' + deltas + '</div>' : '') +
      '</div>' +
      '<div class="card"><h3>Question by question</h3>' + rows + '</div>' +
      (review ? '<div class="card"><h3>Review your misses</h3>' + review + '</div>' : '');

    var again = document.getElementById('again');
    if (again) {
      again.addEventListener('click', function () {
        session = null;
        render();
      });
    }

    var retry = document.getElementById('retry');
    if (retry) {
      retry.addEventListener('click', function () {
        var setId = session.set.id;
        var unitId = session.cfg.unitId || '';
        var questions = missed.map(function (r) { return r.question; });
        createSession({ setId: setId, unitId: unitId, mode: 'retry', length: questions.length },
          questions);
        location.hash = '#/practice?set=' + encodeURIComponent(setId) +
          (unitId ? '&unit=' + encodeURIComponent(unitId) : '') +
          '&mode=retry&n=' + questions.length;
        render();
      });
    }
  }

  /* ------------------------------------------------------------ stats */
  function renderStats() {
    var sets = C.allSets(state, SOURCE_SETS);
    var stats = C.overallStats(state, sets);
    var rows = C.allSetStats(state, sets);
    var days = C.activity(state, 14);
    var peak = days.reduce(function (n, day) { return Math.max(n, day.a); }, 0);
    var trouble = C.troubleSpots(state, sets, 8);

    var activity = '<div class="spark">' + days.map(function (day) {
      var h = peak ? Math.round((day.a / peak) * 100) : 0;
      return '<div class="' + (day.a ? 'has' : '') + '" style="height:' + Math.max(h, 6) +
        '%" title="' + day.date + ': ' + plural(day.a, 'question') + ', ' + day.c +
        ' right"></div>';
    }).join('') + '</div>' +
    '<div class="spark-legend"><span>' + days[0].date + '</span>' +
      '<span>' + stats.answered + ' answers total</span>' +
      '<span>today</span></div>';

    var table = rows.length ? rows.map(function (row) {
      return '<tr><td>' + esc(row.title) +
        (row.archived ? ' <span class="tag">archived</span>' : '') +
        (row.units > 1 ? ' <span class="tag units">' + plural(row.units, 'unit') + '</span>' : '') +
        '</td>' +
        '<td><div class="bar tier-' + row.tier.key + '"><i style="width:' + row.points +
          '%"></i></div></td>' +
        '<td class="num">' + row.points + '%</td>' +
        '<td><span class="tag ' + row.tier.key + '">' + row.tier.label + '</span></td>' +
        '<td class="num">' + row.attempted + '/' + row.total + '</td>' +
        '<td class="num">' + (row.attempted ? row.accuracy + '%' : '—') + '</td>' +
        '<td class="num">' + (row.due || '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No sets loaded.</td></tr>';

    var troubleHTML = trouble.length ? trouble.map(function (row) {
      var where = esc(row.set.title) +
        (row.unit && row.unit.title !== row.set.title ? ' · ' + esc(row.unit.title) : '');
      return '<details class="review-item"><summary>' + where + ' — missed ' +
        row.wrong + ' of ' + row.attempts + ' attempts</summary>' +
        '<div style="margin-top:.7rem">' + staticQuestionHTML(row.q) + '</div></details>';
    }).join('') : '<p class="muted small">No repeated misses yet.</p>';

    appEl.innerHTML =
      '<div class="card"><h1>Your progress</h1>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + stats.answered + '</b><span>answers given</span></div>' +
        '<div class="stat"><b>' + stats.accuracy + '%</b><span>first-try correct</span></div>' +
        '<div class="stat"><b>' + stats.seen + '/' + stats.bankSize +
          '</b><span>questions seen</span></div>' +
        '<div class="stat"><b>' + stats.mastered + '</b><span>sets mastered</span></div>' +
        '<div class="stat"><b>' + stats.streak + '</b><span>day streak</span></div>' +
        '<div class="stat"><b>' + stats.due + '</b><span>due now</span></div>' +
      '</div></div>' +
      '<div class="card"><h3>Last 14 days</h3>' + activity + '</div>' +
      '<div class="card"><h3>Sets</h3><table><thead><tr><th>Set</th><th></th>' +
        '<th class="num">Mastery</th><th>Tier</th><th class="num">Seen</th>' +
        '<th class="num">First try</th><th class="num">Due</th></tr></thead><tbody>' +
        table + '</tbody></table></div>' +
      '<div class="card"><h3>Trouble spots</h3>' + troubleHTML + '</div>';
  }

  /* ------------------------------------------------------------ settings */
  function persistenceHTML() {
    if (PERSISTENCE_MODE === 'disk') {
      return '<p class="small muted">Saved to disk at <code>' +
        esc(PROGRESS_PATH || 'progress/progress.json') + '</code> and cached in this browser.' +
        '</p>';
    }
    return '<p class="small muted">Browser-only: this page cannot reach the progress API. ' +
      'Start the trainer with <code>./qt</code> (or <code>python3 serve.py</code>) to save ' +
      'progress to disk.</p>';
  }

  function renderSettings(route) {
    var lengthValues = C.SESSION_LENGTHS.slice();
    /* Keep an imported legacy length visible instead of showing a select whose
     * value does not exist; the next change replaces it with a current one. */
    if (lengthValues.indexOf(state.settings.length) < 0) {
      lengthValues.push(state.settings.length);
    }
    var lengths = lengthValues.map(function (n) {
      return '<option value="' + n + '"' + (state.settings.length === n ? ' selected' : '') +
        '>' + n + '</option>';
    }).join('');

    appEl.innerHTML =
      '<div class="card"><h1>Settings</h1>' +
      '<h4>Session</h4>' +
      '<label class="field">Questions per session <select id="length">' +
        lengths + '</select></label>' +
      '<label class="field"><input type="checkbox" id="practice-all"' +
        (state.settings.practiceAll !== false ? ' checked' : '') + '> Practice every ' +
        'question in a set with 30 or fewer questions, regardless of the session length ' +
        '<span class="muted small">(spaced review always serves only what is due)</span>' +
        '</label>' +
      '<label class="field">Theme <select id="theme">' +
        ['auto', 'light', 'dark'].map(function (theme) {
          return '<option value="' + theme + '"' +
            (state.settings.theme === theme ? ' selected' : '') + '>' + theme + '</option>';
        }).join('') + '</select></label>' +
      '<h4 style="margin-top:1.1rem">Feedback</h4>' +
      '<label class="field"><input type="checkbox" id="s-sound"' +
        (state.settings.sound ? ' checked' : '') + '> Sound effect on a correct and on a ' +
        'wrong answer <span class="muted small">(right and wrong also flash the card; the ' +
        'clock pauses while you read the feedback either way)</span></label>' +
      '</div>' +
      '<div class="card"><h3>Question data</h3>' +
      '<p class="small muted">Loaded <b>' + SOURCE_SETS.length + '</b> ' +
        (SOURCE_SETS.length === 1 ? 'set' : 'sets') + ' with <b>' +
        SOURCE_SETS.reduce(function (n, set) { return n + C.unitsOf(set).length; }, 0) +
        ' units</b> from <code>questions/index.json</code>.' +
        (LOAD_ERRORS.length ? ' <b>' + LOAD_ERRORS.length + '</b> data ' +
          plural(LOAD_ERRORS.length, 'problem') + ' — see the banner at the top.' : '') +
        ' <a href="#/format">JSON format</a>.</p>' +
      '<p class="small muted">There is no mixed practice: each session draws only from the ' +
        'set or unit you choose.</p></div>' +
      '<div class="card"><h3>Progress data</h3>' +
      persistenceHTML() +
      '<p class="muted small">Back it up as JSON if you switch machines or clear site ' +
        'data. Archived sets are included in the export.</p>' +
      '<div class="row"><button class="btn" id="export">Export JSON</button>' +
        '<button class="btn" id="import-btn">Import JSON</button>' +
        '<button class="btn" id="reset">Reset all data</button>' +
        '<input type="file" id="import-file" accept="application/json" hidden></div>' +
      '<p class="small muted" id="note" style="margin-top:.7rem"></p>' +
      '</div>';

    var note = document.getElementById('note');
    $('#length').addEventListener('change', function (event) {
      state.settings.length = parseInt(event.target.value, 10);
      saveState();
    });
    $('#practice-all').addEventListener('change', function (event) {
      state.settings.practiceAll = event.target.checked;
      saveState();
    });
    $('#theme').addEventListener('change', function (event) {
      state.settings.theme = event.target.value;
      applyTheme();
      saveState();
    });
    $('#s-sound').addEventListener('change', function (event) {
      state.settings.sound = event.target.checked;
      saveState();
      /* Switching it on plays the chime once, so the setting proves itself. */
      if (state.settings.sound) playVerdict(true);
    });
    $('#export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'question-trainer-progress.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
    $('#import-btn').addEventListener('click', function () {
      $('#import-file').click();
    });
    $('#import-file').addEventListener('change', function (event) {
      var file = event.target.files[0];
      if (!file) return;
      file.text().then(function (text) {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || parsed.app !== C.STATE_APP ||
            parsed.v !== C.STATE_VERSION) {
          note.textContent = 'That file is not a progress export from this version.';
          return;
        }
        state = C.sanitizeState(parsed, Date.now());
        var saved = saveState();
        applyTheme();
        renderPills();
        note.textContent = 'Imported: ' + state.totals.a + ' answers, ' +
          state.totals.sessions + ' sessions, ' +
          Object.keys(state.archived).length + ' archived sets.' +
          (saved ? '' : ' The browser could not save it (storage is full).');
      });
    });
    $('#reset').addEventListener('click', function () {
      if (!window.confirm('Delete all practice history, progress and archived copies? ' +
          'Your source sets stay in questions/index.json.')) return;
      clearStoredState();
      state = C.emptyState(Date.now());
      session = null;
      saveState();
      applyTheme();
      renderPills();
      renderSettings(route);
    });
  }

  /* ------------------------------------------------------------ format */
  function renderFormat() {
    var indexExample = JSON.stringify({ sets: ['example-set'] }, null, 2);
    var folderExample = JSON.stringify({
      id: 'example-set',
      title: 'Example Set',
      description: 'Optional one-line description.',
      units: ['unit-1.json', 'unit-2.json']
    }, null, 2);
    var unitExample = JSON.stringify({
      id: 'unit-1',
      title: 'Unit 1',
      questions: [
        {
          id: 'q1',
          passage: 'Optional context or passage.',
          image: 'images/australia-map.png',
          imageAlt: 'Map of Australia with Canberra marked.',
          imageCaption: 'Optional caption under the image.',
          question: 'What is the capital of Australia?',
          choices: ['Sydney', 'Canberra', 'Melbourne', 'Perth'],
          answer: 1,
          explanation: 'Canberra is the capital of Australia.',
          explanations: [
            'Sydney is the largest city, but it is not the capital.',
            'Canberra is the capital of Australia.',
            'Melbourne is a large city, but it is not the capital.',
            'Perth is the capital of Western Australia, not of the country.'
          ]
        }
      ]
    }, null, 2);

    appEl.innerHTML =
      '<div class="card"><h1>Question JSON format</h1>' +
      '<p>A question set is a <b>folder</b> under <code>questions/</code>. The app fetches ' +
      '<code>questions/index.json</code> at startup; it lists the set folders by name:</p>' +
      '<pre class="code">' + esc(indexExample) + '</pre>' +
      '<p>Each folder has its own <code>index.json</code> that names the set and the unit ' +
      'files that make it up:</p>' +
      '<pre class="code">' + esc(folderExample) + '</pre>' +
      '<p>Each unit file holds the questions. A set with one unit needs just one file. A set ' +
      'with several units gets a single card on the set list, with its units on the right; ' +
      'each unit is practised, reviewed and archived on its own, and the set as a whole has ' +
      'the same three options:</p>' +
      '<pre class="code">' + esc(unitExample) + '</pre>' +
      '<h3>Set folder index fields</h3><table><thead><tr><th>Field</th><th></th>' +
      '<th>Meaning</th></tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>required</td><td>Stable, unique set id. Progress ' +
        'and archiving are keyed by it; it defaults to the folder name.</td></tr>' +
      '<tr><td><code>title</code></td><td>required</td><td>Name shown on the set card.</td></tr>' +
      '<tr><td><code>description</code></td><td>optional</td><td>Short line under the title.</td></tr>' +
      '<tr><td><code>units</code></td><td>required</td><td>One or more bare unit file names ' +
        'in the same folder, in display order.</td></tr></tbody></table>' +
      '<h3>Unit fields</h3><table><thead><tr><th>Field</th><th></th><th>Meaning</th>' +
      '</tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>required</td><td>Unique within the set.</td></tr>' +
      '<tr><td><code>title</code></td><td>required</td><td>Name shown on the unit row.</td></tr>' +
      '<tr><td><code>description</code></td><td>optional</td><td>Short line under the title.</td></tr>' +
      '<tr><td><code>questions</code></td><td>required</td><td>Non-empty array of question ' +
        'objects. Question ids must be unique across the whole set, because progress is ' +
        'keyed by set id plus question id.</td></tr></tbody></table>' +
      '<h3>Question fields</h3><table><thead><tr><th>Field</th><th></th><th>Meaning</th>' +
      '</tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>required</td><td>Unique within the set. Stable ids ' +
        'keep progress attached when you edit the file.</td></tr>' +
      '<tr><td><code>question</code></td><td>required</td><td>The question stem.</td></tr>' +
      '<tr><td><code>choices</code></td><td>required</td><td>Two or more choice strings. ' +
        'Labels A, B, C … are generated from their order.</td></tr>' +
      '<tr><td><code>answer</code></td><td>required</td><td>0-based index of the correct ' +
        'choice. The example answer <code>1</code> means the second choice.</td></tr>' +
      '<tr><td><code>passage</code></td><td>optional</td><td>Context shown above the question. ' +
        'Blank lines separate paragraphs; lines starting with • become a list.</td></tr>' +
      '<tr><td><code>image</code></td><td>optional</td><td>Image shown between the passage ' +
        'and the stem. Bare paths resolve against <code>questions/</code>; absolute URLs ' +
        'and <code>data:</code> URIs also work.</td></tr>' +
      '<tr><td><code>imageAlt</code></td><td>optional</td><td>Alt text for the image; without ' +
        'it the image has no text alternative for screen readers.</td></tr>' +
      '<tr><td><code>imageCaption</code></td><td>optional</td><td>Caption shown under the ' +
        'image.</td></tr>' +
      '<tr><td><code>explanation</code></td><td>optional</td><td>Overall explanation shown ' +
        'after answering.</td></tr>' +
      '<tr><td><code>explanations</code></td><td>optional</td><td>One entry per choice ' +
        '(string or <code>null</code>); each non-empty entry is shown under that choice.</td></tr>' +
      '</tbody></table>' +
      '<p class="small muted">A broken unit file is skipped and reported in the banner with ' +
      'its folder and file name; the rest of the set still loads. Duplicate or missing set ' +
      'ids are reported too.</p></div>' +
      '<div class="card"><h3>Running it</h3>' +
      '<p>Start the trainer from the repository root:</p>' +
      '<pre class="code">./qt' + '\n' +
      'http://127.0.0.1:8765/app/</pre>' +
      '<p><code>qt</code> serves the repository and opens the app. It also writes progress ' +
      'to <code>progress/progress.json</code>; use <code>--no-open</code>, <code>--port</code>, ' +
      '<code>--host</code> or <code>--progress</code> to change that. The app reads ' +
      '<code>questions/index.json</code> with <code>fetch</code>, so opening ' +
      '<code>index.html</code> directly from disk does not work in browsers that block ' +
      '<code>file://</code> reads.</p>' +
      '<p>A plain static server still works (for example ' +
      '<code>python3 -m http.server 8765</code>): progress then stays in this browser only, ' +
      'and Settings says so. <b>Archive</b> moves a set off the active list and keeps a copy ' +
      'of its questions and progress; <b>Restore</b> brings it back, even if the source file ' +
      'no longer lists it.</p></div>';
  }

  /* ------------------------------------------------------------ keyboard */
  document.addEventListener('keydown', function (event) {
    if (parseHash().path !== '/practice' || !session ||
        session.index >= session.questions.length) return;
    var tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') return;
    var cls = event.target.classList || { contains: function () { return false; } };

    if (event.key === 'Enter' || event.key === ' ') {
      /* A focused choice: Enter checks/advances; Space selects natively. */
      if (cls.contains('choice')) {
        if (event.key === 'Enter') {
          event.preventDefault();
          action();
        }
        return;
      }
      /* The cross-out button and the action button handle their own activation. */
      if (cls.contains('elim') || event.target.id === 'action' || tag === 'button') return;
      if (session.checked || session.selected != null) {
        event.preventDefault();
        action();
      }
      return;
    }
    var key = event.key.toUpperCase();
    var index = -1;
    if (key.length === 1 && key >= 'A' && key <= 'Z') index = key.charCodeAt(0) - 65;
    var number = '123456789'.indexOf(key);
    if (number >= 0) index = number;
    if (index >= 0 && index < session.questions[session.index].choices.length) {
      event.preventDefault();
      selectChoice(index);
    }
  });

  /* ------------------------------------------------------------ boot */
  async function init() {
    applyTheme();
    appEl.innerHTML = '<div class="card"><p class="muted">Loading question sets…</p></div>';
    await loadBank();
    await initProgress();
    window.addEventListener('hashchange', render);
    render();
  }

  init();
})();
