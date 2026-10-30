/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 naromil
 *
 * Question Trainer - the app: routing, rendering, storage.
 *
 * Reads questions/index.json and the set files it lists at startup, depends on
 * window.QTCore for the pure logic. Progress lives in localStorage and, when
 * served by serve.py, is mirrored to disk. An in-flight session is kept in
 * sessionStorage, so a reload resumes the same question, selection, clock and
 * graded feedback; every graded answer is also saved to progress.
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
  /* The in-flight session is deliberately separate from progress: it holds the
   * question order, cursor and per-answer reward, and dies with the tab. */
  var SESSION_KEY = 'questiontrainer.session.v1';
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
  /* The last browser cache write and the last disk mirror each report their
   * own health; the notice and Settings read both. */
  var localWriteFailed = false;
  var diskPushFailed = false;
  /* The server answered 500 for the progress file: the browser copy is still
   * trustworthy, and the next save may replace the unreadable file. */
  var diskUnreadable = false;
  var pushRetryPending = false;
  var state = loadState();
  var session = null;
  var timer = null;
  /* Home list controls survive re-renders of the page but not a reload. */
  var homeQuery = '';
  var homeSort = 'index';
  /* Question browser filters; like the home controls, they last until a
   * reload. The set, unit and selected question live in the hash. */
  var browseQuery = '';
  var browseShowDeleted = true;
  /* The browser that is on screen, for the keyboard handler. */
  var browseView = null;
  /* The trouble rows last painted on Progress; the per-set practice buttons
   * reuse them instead of re-walking the bank. */
  var lastTroubleRows = [];
  /* Which hash was on screen for the last full render; a route change moves
   * focus and the scroll position, an in-place re-render keeps both. */
  var lastRenderedHash = null;

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
  /* The line under a mastery bar. Never-attempted rows omit the first-try
   * share: "0% first try" would read like a measured failure. */
  function metaText(row) {
    var text = row.points + '% mastery · ' +
      row.attempted + '/' + row.total + ' answered';
    if (row.attempted > 0) text += ' · ' + row.accuracy + '% first try';
    return text;
  }

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
      localWriteFailed = false;
      return true;
    } catch (err) {
      localWriteFailed = true;
      return false;
    }
  }

  /* Fire-and-forget disk mirror. Posts are serialised so a slow request cannot
   * let an older state overwrite a newer one; answers never wait for it. */
  function pushProgress(retry) {
    if (PERSISTENCE_MODE !== 'disk' || location.protocol === 'file:') return;
    if (pushBusy) { pushQueued = true; return; }
    pushBusy = true;
    var wasFailed = diskPushFailed;
    var wasUnreadable = diskUnreadable;
    var body;
    try { body = JSON.stringify(state); } catch (err) {
      pushBusy = false;
      diskPushFailed = true;
      if (!wasFailed) renderNotice();
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
      if (response.status === 409) {
        /* The disk copy changed underneath this page. Merge it once, then
         * re-post; a second rejection is reported instead of looping. */
        if (retry) {
          diskPushFailed = true;
          return null;
        }
        return resolveProgressConflict();
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      diskPushFailed = false;
      diskUnreadable = false;
    }).catch(function () {
      /* localStorage is still authoritative for this page. */
      diskPushFailed = true;
    }).then(function () {
      pushBusy = false;
      if (wasFailed !== diskPushFailed || wasUnreadable !== diskUnreadable) renderNotice();
      if (pushQueued) {
        pushQueued = false;
        var again = pushRetryPending;
        pushRetryPending = false;
        pushProgress(again);
      }
    });
  }

  /* Read the newer disk copy, fold this page's changes into it, and queue the
   * single re-post. Only chrome is repainted: a full render here would steal
   * focus from whatever the user is doing. */
  function resolveProgressConflict() {
    return fetch(progressUrl(), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (raw) {
      /* sanitizeState() is total: a malformed payload would become an empty
       * state and could erase real progress. Treat it as a failed read. */
      if (!raw || typeof raw !== 'object' || raw.app !== C.STATE_APP ||
          raw.v !== C.STATE_VERSION) {
        throw new Error('invalid progress state');
      }
      var serverState = C.sanitizeState(raw, Date.now());
      state = C.mergeStates(serverState, state, Date.now());
      C.stampState(state, Date.now());
      writeLocal();
      applyTheme();
      renderPills();
      renderNotice();
      pushRetryPending = true;
      pushQueued = true;
    });
  }

  /* Progress is saved in two places; either can fail on its own, so both
   * report through the notice while the page keeps working. */
  function saveState() {
    /* Every local change needs a fresh stamp: a later boot lets the disk copy
     * win ties, so a failed POST would otherwise lose settings/imports. */
    C.stampState(state, Date.now());
    var saved = writeLocal();
    pushProgress();
    renderNotice();
    return saved;
  }

  /* Another tab saved. Adopt its state only when it is newer, and never write
   * back: a storage echo would otherwise ping-pong between tabs. */
  window.addEventListener('storage', function (event) {
    if (event.key !== STATE_KEY || !event.newValue) return;
    var raw = null;
    try {
      raw = JSON.parse(event.newValue);
    } catch (err) {
      return;
    }
    /* sanitizeState() is total: anything that parses but is not a progress
     * state would become an empty state stamped now, wiping this tab. */
    if (!raw || typeof raw !== 'object' || raw.app !== C.STATE_APP ||
        raw.v !== C.STATE_VERSION) return;
    var incoming = C.sanitizeState(raw, Date.now());
    if (!(incoming.updated > state.updated)) return;
    state = incoming;
    applyTheme();
    renderNotice();
    renderPills();
    render();
  });

  function clearStoredState() {
    try { localStorage.removeItem(STATE_KEY); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------ session storage */
  /* Unlike progress, the session snapshot is disposable: it mirrors the
   * in-memory session so a reload can rebuild it without touching progress or
   * replaying applyAnswer. Results carry the reward as it was at answer time,
   * because mastery may have moved on since then. */
  function clearStoredSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
  }

  function persistSession() {
    if (!session) return;
    var snapshot = C.makeSessionSnapshot(session, elapsedMs());
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    } catch (err) {
      /* Private mode or a full quota: the session still runs in memory. */
    }
  }

  /* Rebuild the session from sessionStorage. The bank is already loaded, so
   * every id can be checked against the current set; a session whose ids no
   * longer resolve is dropped rather than half-restored. */
  function restoreStoredSession() {
    var raw = null;
    var stored = null;
    try {
      stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) raw = JSON.parse(stored);
    } catch (err) { clearStoredSession(); return; }
    if (stored == null) return;

    var cfg = raw && raw.cfg;
    var set = C.findSet(state, SOURCE_SETS, cfg && cfg.setId);
    if (!set) { clearStoredSession(); return; }
    var restored = C.restoreSessionSnapshot(raw, set);
    if (!restored) { clearStoredSession(); return; }
    session = restored;
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
      if (response.status === 500) {
        /* The file exists but cannot be read. Keep the browser copy and let
         * the next save replace the file; do not fall back to browser mode. */
        PERSISTENCE_MODE = 'disk';
        diskUnreadable = true;
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
      diskPushFailed = false;
    }
  }

  /* ------------------------------------------------------------ theming */
  /* The top-bar button shows the current theme: half-filled circle for the
   * automatic (system) setting, a sun for light and a moon for dark. Its label
   * names both the current setting and what a click will switch to. */
  function updateThemeToggle() {
    var button = document.getElementById('theme-toggle');
    if (!button) return;
    var theme = state.settings.theme || 'auto';
    var symbol = theme === 'light' ? '☀' : (theme === 'dark' ? '☾' : '◐');
    var icon = document.getElementById('theme-toggle-icon');
    if (icon) icon.textContent = symbol;
    else button.textContent = symbol;
    var label = 'Theme: ' + theme + ' — switch to ' + C.nextTheme(theme);
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme || 'auto');
    updateThemeToggle();
  }

  /* Quick toggle: auto -> light -> dark -> auto. The Settings select goes
   * through applyTheme too, so both controls always agree. */
  (function () {
    var button = document.getElementById('theme-toggle');
    if (!button) return;
    button.addEventListener('click', function () {
      state.settings.theme = C.nextTheme(state.settings.theme || 'auto');
      applyTheme();
      var select = document.getElementById('theme');
      if (select) select.value = state.settings.theme;
      saveState();
    });
  })();

  /* ------------------------------------------------------ feedback effects */
  /* A correct answer is rewarded on three channels that agree with each other:
   * the card pulses (a warmer second ring once a streak is running), sparks
   * burst from the verdict icon, and a synthesised chime lands — brighter for a
   * first-time correct than for a repeat, with a note added every few of a
   * run. A miss keeps the single shake and the low two-tone, so the pair stays
   * legible as opposites.
   *
   * Audio is WebAudio, so no assets ship and nothing plays until the answer
   * click (a user gesture), which is also what autoplay policy wants. Settings
   * can mute the sound; prefers-reduced-motion skips every animation and the
   * spark layer, and the textual reward is identical either way. */
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

  /* How many extra notes a running streak earns. Capped at three: a long run
   * should feel good, not turn every answer into a fanfare. */
  function streakNotes(streak) {
    if (streak >= 8) return 3;
    if (streak >= 5) return 2;
    if (streak >= 3) return 1;
    return 0;
  }

  function playVerdict(reward) {
    if (!state.settings.sound) return;
    var ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    var at = ctx.currentTime + 0.01;
    if (!reward.correct) {
      note(ctx, 196, at, 0.17, 'square', 0.05);
      note(ctx, 147, at + 0.13, 0.22, 'square', 0.05);
      return;
    }
    note(ctx, 660, at, 0.12, 'sine', 0.08);
    note(ctx, 990, at + 0.11, 0.16, 'sine', 0.08);
    /* A first-time correct is the one that pays full mastery, so it lands an
     * octave above the repeat coin: the ear separates "new" from "again"
     * without reading the chip. */
    if (reward.coin === 'new') note(ctx, 1320, at + 0.22, 0.20, 'triangle', 0.05);
    var extra = streakNotes(reward.streak);
    if (extra >= 1) note(ctx, 1188, at + 0.30, 0.14, 'sine', 0.06);
    if (extra >= 2) note(ctx, 1320, at + 0.40, 0.16, 'sine', 0.06);
    if (extra >= 3) note(ctx, 1584, at + 0.52, 0.30, 'sine', 0.05);
  }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* Sparks thrown from the verdict icon. DOM nodes rather than a canvas: a
   * dozen spans for under a second cost nothing, inherit the theme's colours
   * through CSS variables, and leave no resize or DPR handling behind. */
  function burst(anchor, count) {
    if (reduceMotion() || !anchor || !anchor.isConnected) return;
    var rect = anchor.getBoundingClientRect();
    var layer = document.createElement('div');
    layer.className = 'burst';
    layer.setAttribute('aria-hidden', 'true');
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    for (var i = 0; i < count; i++) {
      var dot = document.createElement('span');
      var angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      var dist = 34 + Math.random() * 54;
      var size = 4 + Math.random() * 4;
      dot.className = 'spark spark-' + (i % 3);
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
      dot.style.width = size + 'px';
      dot.style.height = size + 'px';
      dot.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      dot.style.setProperty('--dy', (Math.sin(angle) * dist - 12) + 'px');
      dot.style.setProperty('--fall', Math.round(8 + Math.random() * 28) + 'px');
      dot.style.setProperty('--rot', (Math.random() * 240 - 120) + 'deg');
      dot.style.animationDelay = (i % 4) * 12 + 'ms';
      layer.appendChild(dot);
    }
    document.body.appendChild(layer);
    window.setTimeout(function () {
      if (layer.parentNode) layer.parentNode.removeChild(layer);
    }, 1100);
  }

  /* The mastery total counts up instead of appearing, so the reward reads as a
   * change rather than as a static label. */
  function countUp(el, from, to, suffix) {
    if (!el) return;
    el.textContent = from + suffix;
    if (reduceMotion() || from === to) { el.textContent = to + suffix; return; }
    var start = null;
    var span = 420;
    function step(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / span);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (to - from) * eased) + suffix;
      if (t < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }

  /* The header repeats the live mastery total, so it animates the same way as
   * the reward line and changes colour for the direction of the answer. A
   * restored answer passes animate=false: it shows the recorded totals at
   * once instead of replaying the count-up. */
  function updatePracticeStatus(result, streak, animate) {
    var animated = animate !== false;
    var view = document.getElementById('practice-view');
    if (view) {
      view.setAttribute('data-mood',
        !result.correct ? 'wrong' : (streak >= 3 ? 'streak' : 'right'));
    }
    var chip = document.getElementById('mastery-pill');
    if (chip) {
      chip.classList.remove('is-up', 'is-down');
      if (animated) {
        void chip.offsetWidth;
        if (result.pointsDelta > 0) chip.classList.add('is-up');
        else if (result.pointsDelta < 0) chip.classList.add('is-down');
      }
    }
    var masteryValue = document.getElementById('mastery-pill-value');
    if (animated) {
      countUp(masteryValue, result.pointsBefore, result.pointsAfter, '%');
    } else if (masteryValue) {
      masteryValue.textContent = result.pointsAfter + '%';
    }
    var run = document.getElementById('streak-chip');
    if (!run) return;
    if (streak >= 2) {
      var value = document.getElementById('streak-value');
      if (value) value.textContent = streak;
      run.hidden = false;
      run.classList.toggle('hot', streak >= 5);
      if (animated) {
        run.classList.remove('pop');
        void run.offsetWidth;
        run.classList.add('pop');
      }
    } else {
      run.hidden = true;
    }
  }

  /* The results ring fills from empty to the session score; the number and the
   * conic-gradient share one eased clock so they cannot disagree. */
  function animateScore(percent) {
    var ring = document.getElementById('score-ring');
    var value = document.getElementById('score-value');
    if (!ring || !value) return;
    if (reduceMotion()) {
      ring.style.setProperty('--pct', percent);
      value.textContent = percent + '%';
      return;
    }
    var start = null;
    var span = 720;
    function step(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / span);
      var eased = 1 - Math.pow(1 - t, 3);
      var shown = Math.round(percent * eased);
      ring.style.setProperty('--pct', shown);
      value.textContent = shown + '%';
      if (t < 1) window.requestAnimationFrame(step);
      else ring.classList.add('done');
    }
    window.requestAnimationFrame(step);
  }

  /* A finished session gets a short rising chord; it only plays for a solid
   * score and only when sound is on, so a weak run stays quiet. */
  function playResults(percent) {
    if (!state.settings.sound || percent < 70) return;
    var ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    var at = ctx.currentTime + 0.05;
    var chord = [523.25, 659.25, 783.99];
    for (var i = 0; i < chord.length; i++) {
      note(ctx, chord[i], at + i * 0.09, 0.34, 'sine', 0.055);
    }
    if (percent >= 100) note(ctx, 1046.5, at + 0.3, 0.4, 'triangle', 0.05);
  }

  /* The card carries the effect class for one animation; showQuestion resets
   * the card's className, so the same node replays it on the next question. */
  function flashCard(reward) {
    var card = document.getElementById('qcard');
    if (!card) return;
    card.classList.remove('fx-correct', 'fx-wrong', 'fx-streak');
    if (!reward.correct) { card.classList.add('fx-wrong'); return; }
    card.classList.add('fx-correct');
    if (reward.streak >= 3) card.classList.add('fx-streak');
  }

  /* One call for the whole reward, so the three channels cannot drift apart:
   * card pulse, spark burst, chime — each scaled to what the answer was worth. */
  function celebrate(reward, pointsBefore) {
    flashCard(reward);
    playVerdict(reward);
    if (!reward.correct) return;
    var count = reward.coin === 'new' ? 16 : 10;
    if (reward.streak >= 5) count += 6;
    else if (reward.streak >= 3) count += 3;
    burst(document.querySelector('#feedback .verdict .icon'), count);
    countUp(document.getElementById('mastery-now'), pointsBefore, reward.pointsAfter, '%');
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
    var indexUrl = new URL(BANK_URL, location.href);
    var index;
    try {
      index = await fetchJSON(indexUrl);
    } catch (err) {
      var message = 'Could not read ' + indexUrl.pathname + ': ' + err.message;
      if (location.protocol === 'file:') {
        message += ' Most browsers block reading local JSON from file://; ' +
          'serve the repository with ./qt and open /app/.';
      }
      LOAD_ERRORS.push(message);
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
    var html = '';
    if (LOAD_ERRORS.length) {
      html += '<div class="warnbox"><b>Question data problems</b><ul>' +
        LOAD_ERRORS.map(function (error) { return '<li>' + esc(error) + '</li>'; }).join('') +
        '</ul><p class="small">Edit <code>questions/index.json</code> and the files it lists. ' +
        '<a href="#/format">See the format</a>.</p></div>';
    }
    if (localWriteFailed) {
      html += '<div class="warnbox"><b>Progress could not be saved in this browser</b>' +
        '<p>Browser storage is full or blocked, so answers may be lost on reload. ' +
        'Export your progress from <a href="#/settings">Settings</a>, then free up storage.</p></div>';
    }
    if (PERSISTENCE_MODE === 'disk' && diskPushFailed) {
      html += '<div class="warnbox"><b>Disk mirror failed</b>' +
        '<p>Progress is saved in this browser only; the server mirror did not accept ' +
        'the last write.</p></div>';
    }
    if (PERSISTENCE_MODE === 'disk' && diskUnreadable) {
      html += '<div class="warnbox"><b>Progress file could not be read</b>' +
        '<p>The server could not read the progress file, so your browser copy is safe ' +
        'and in use. The next save replaces the unreadable file after keeping it as ' +
        '<code>.bak</code>. You can repair it now in ' +
        '<a href="#/settings">Settings → Progress data</a>.</p></div>';
    }
    return html;
  }

  function renderNotice() {
    if (noticeEl) noticeEl.innerHTML = noticeHTML();
  }

  /* ------------------------------------------------------------ chrome */
  /* Archived sets keep their review dates, but only active sets drive the
   * global due counters; the Archive page still shows each set's own due. */
  function activeDue(now) {
    return C.activeDueCount(state, SOURCE_SETS, now || Date.now());
  }

  function renderPills() {
    var sets = C.allSets(state, SOURCE_SETS);
    if (!pillsEl) return;
    if (!sets.length) {
      pillsEl.innerHTML = '';
      return;
    }
    var stats = C.overallStats(state, sets);
    var due = activeDue();
    pillsEl.innerHTML =
      '<span class="pill" title="Questions answered at least once">' +
        stats.seen + '/' + stats.bankSize + ' seen</span>' +
      '<span class="pill" title="Questions answered right on the first attempt">' +
        stats.accuracy + '% right</span>' +
      (stats.streak ? '<span class="pill" title="Consecutive days with practice">' +
        plural(stats.streak, 'day') + ' streak</span>' : '') +
      (due ? '<span class="pill" title="Due for spaced review in active sets">↻ ' +
        due + ' due</span>' : '');
  }

  function setActiveNav(path) {
    /* Practice and the browser belong to the set list, not to their own
     * nav entries. */
    var active = path === '/practice' || path === '/browse' ? '/' : path;
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
    el.title = paused
      ? (session && session.checked ? 'Paused while you review this answer'
        : 'Paused while the tab is hidden')
      : 'Time spent answering';
  }

  function resumeTimer() {
    if (!session || session.runningSince || document.hidden) return;
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
    /* Pausing is a natural save point: it also covers a reload while the tab
     * is hidden or the session is being left. */
    if (session) persistSession();
  }

  /* Answering time stops while the tab is hidden. On return it resumes only
   * while an unanswered question is open; reading feedback stays paused. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      pauseTimer();
      return;
    }
    if (parseHash().path === '/practice' && session &&
        session.index < session.questions.length && !session.checked) {
      resumeTimer();
    }
  });

  /* A reload or a closed tab does not fire visibilitychange in every browser;
   * pagehide is the reliable last chance to bank the answering time. */
  window.addEventListener('pagehide', function () {
    pauseTimer();
  });

  /* ------------------------------------------------------------ routing */
  /* Every screen names itself in the tab, the history list and to screen
   * readers: "Practice · <set> — Question Trainer". */
  function setPageTitle(parts) {
    document.title = C.pageTitle(parts);
  }

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
    var hash = location.hash;
    var routeChanged = lastRenderedHash !== null && hash !== lastRenderedHash;
    lastRenderedHash = hash;
    /* A hash navigation swaps the whole page under an unchanged document, so
     * a keyboard or screen-reader user would otherwise be left on a control
     * that no longer exists. Land on the main landmark before painting. */
    if (routeChanged) {
      var main = document.getElementById('main');
      if (main) main.focus({ preventScroll: true });
    }
    setActiveNav(route.path);
    renderNotice();
    renderPills();

    /* Leaving practice abandons the finished session so the same link starts
     * a fresh one next time. Its sessionStorage copy goes with it. */
    if (route.path !== '/practice' && session && session.index >= session.questions.length) {
      session = null;
      clearStoredSession();
    }

    if (route.path === '/archive') renderArchive();
    else if (route.path === '/stats') renderStats();
    else if (route.path === '/settings') renderSettings(route);
    else if (route.path === '/format') renderFormat();
    else if (route.path === '/practice') renderPractice(route.params);
    else if (route.path === '/browse') renderBrowse(route.params);
    else renderHome();
    if (routeChanged) {
      appEl.classList.remove('view-in');
      void appEl.offsetWidth;
      appEl.classList.add('view-in');
      window.scrollTo(0, 0);
    }
  }

  /* ------------------------------------------------------------ home */
  function practiceHref(setId, unitId, mode) {
    var href = '#/practice?set=' + encodeURIComponent(setId);
    if (unitId) href += '&unit=' + encodeURIComponent(unitId);
    if (mode) href += '&mode=' + mode;
    return href;
  }

  function browseHref(setId, unitId, questionId) {
    var href = '#/browse?set=' + encodeURIComponent(setId);
    if (unitId) href += '&unit=' + encodeURIComponent(unitId);
    if (questionId) href += '&q=' + encodeURIComponent(questionId);
    return href;
  }

  /* One unit inside a set card: its mastery and coverage, what is due, and the
   * same three options a set has. */
  function unitRowHTML(row) {
    var meta = metaText(row);
    return '<li class="unit-row">' +
      '<div class="unit-head"><b>' + esc(row.title) + '</b>' +
        (row.due ? '<span class="tag due">' + row.due + ' due</span>' : '') + '</div>' +
      '<div class="bar unit-bar tier-' + row.tier.key + '" title="' + row.points +
        '% mastery"><i style="width:' + row.points + '%"></i></div>' +
      '<div class="meta small">' + meta + '</div>' +
      '<div class="row unit-actions">' +
        '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.setId, row.id, null) +
          '">Practice</a>' +
        '<a class="btn btn-sm" href="' + practiceHref(row.setId, row.id, 'review') +
          '">Review</a>' +
        '<a class="btn btn-sm" href="' + browseHref(row.setId, row.id, null) +
          '">Browse</a>' +
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
        '<div class="meta">' + metaText(row) + (due ? ' ' + due : '') + '</div>' +
        '<div class="row set-actions">' +
          '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.id, null, null) +
            '">Practice</a>' +
          '<a class="btn btn-sm" href="' + practiceHref(row.id, null, 'review') +
            '">Review</a>' +
          '<a class="btn btn-sm" href="' + browseHref(row.id, null, null) +
            '">Browse</a>' +
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

  function bindArchiveButtons(root) {
    $$('[data-archive]', root || appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        archiveSet(button.getAttribute('data-archive'));
      });
    });
    $$('[data-archive-unit]', root || appEl).forEach(function (button) {
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
    /* activeSets() hides archived units, but the snapshot should keep the set's
     * original unit order, so hand archiveSet the unfiltered copy when one is
     * available. A local copy wins over the source, matching activeSets(). */
    var full = state.local[setId] || sourceSet(setId) || set;
    C.archiveSet(state, full, Date.now());
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

  /* Paint only the set list, its count and the no-match state from the rows
   * the controls filter. The search input itself is never replaced, so it
   * keeps focus and the caret while typing. */
  function renderSetRows(activeRows) {
    var list = document.getElementById('set-rows');
    if (!list) return;
    var rows = C.sortSetRows(C.filterSetRows(activeRows, homeQuery), homeSort);
    list.innerHTML = rows.map(setCard).join('');

    var count = document.getElementById('set-list-count');
    if (count) {
      var unitCount = rows.reduce(function (n, row) { return n + row.units; }, 0);
      var heading = homeQuery
        ? rows.length + ' of ' + plural(activeRows.length, 'set') + ' shown'
        : (unitCount !== rows.length
          ? plural(rows.length, 'set') + ' · ' + plural(unitCount, 'unit')
          : plural(rows.length, 'set'));
      count.textContent = ' · ' + heading;
    }

    var empty = document.getElementById('set-empty');
    if (empty) {
      empty.hidden = rows.length > 0;
      empty.innerHTML = rows.length ? '' :
        '<p>No sets match “' + esc(homeQuery) + '”.</p>' +
        '<button type="button" class="btn btn-sm" id="clear-filter">Clear</button>';
      var clear = document.getElementById('clear-filter');
      if (clear) clear.addEventListener('click', function () {
        homeQuery = '';
        var input = document.getElementById('set-filter');
        if (input) { input.value = ''; input.focus(); }
        renderSetRows(activeRows);
      });
    }

    bindArchiveButtons(list);
  }

  function bindHomeControls(activeRows) {
    var input = document.getElementById('set-filter');
    if (input) input.addEventListener('input', function (event) {
      homeQuery = event.target.value;
      renderSetRows(activeRows);
    });
    var select = document.getElementById('set-sort');
    if (select) select.addEventListener('change', function (event) {
      homeSort = event.target.value;
      renderSetRows(activeRows);
    });
  }

  function renderHome() {
    setPageTitle(['Sets']);
    var active = C.activeSets(state, SOURCE_SETS);
    var archived = C.archivedSets(state);
    var all = C.allSets(state, SOURCE_SETS);
    var now = Date.now();
    var allRows = C.allSetStats(state, all, now);
    var stats = C.statsFromRows(state, allRows, now);
    var due = activeDue();
    var rows = active.map(function (set) { return C.setStats(state, set, now); });

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
        '<div class="stat"><b>' + due + '</b><span>due for review</span></div>' +
      '</div></div></div>';

    if (rows.length) {
      var sorts = [
        { value: 'index', label: 'Index order' },
        { value: 'title', label: 'Title A–Z' },
        { value: 'mastery', label: 'Mastery' },
        { value: 'due', label: 'Most due' }
      ];
      html += '<section class="set-list">' +
        '<h2>Question sets<span id="set-list-count" aria-live="polite"></span></h2>' +
        '<div class="set-tools">' +
          '<label class="set-search"><span class="sr-only">Filter sets</span>' +
            '<input type="search" id="set-filter" placeholder="Filter sets" value="' +
              esc(homeQuery) + '" autocomplete="off" spellcheck="false"></label>' +
          '<label class="set-sort">Sort sets <select id="set-sort">' +
            sorts.map(function (option) {
              return '<option value="' + option.value + '"' +
                (homeSort === option.value ? ' selected' : '') + '>' +
                option.label + '</option>';
            }).join('') +
          '</select></label>' +
        '</div>' +
        '<div class="sets" id="set-rows"></div>' +
        '<div class="set-empty" id="set-empty" hidden></div>' +
        '</section>';
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
    if (rows.length) {
      renderSetRows(rows);
      bindHomeControls(rows);
    }
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
    C.restoreUnit(state, setId, unitId, sourceSet(setId), Date.now());
    saveState();
    render();
  }

  function archivedSetCard(entry, now) {
    var row = C.setStats(state, C.withoutDeleted(state, entry) || entry, now);
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
        '<div class="meta">' + metaText(row) +
          (row.due ? ' · ' + row.due + ' due' : '') + '</div>' +
        '<div class="row set-actions">' +
          '<a class="btn btn-sm btn-primary" href="' + practiceHref(row.id, null, null) +
            '">Practice</a>' +
          '<a class="btn btn-sm" href="' + practiceHref(row.id, null, 'review') +
            '">Review</a>' +
          '<a class="btn btn-sm" href="' + browseHref(row.id, null, null) +
            '">Browse</a>' +
          '<button type="button" class="btn btn-sm" data-restore="' + esc(row.id) +
            '">Restore</button>' +
        '</div>' +
      '</div>' +
      (row.units > 1
        ? '<div class="set-units"><h4>Units</h4><ul class="unit-list">' +
          row.unitRows.map(function (unitRow) {
            return '<li class="unit-row"><div class="unit-head"><b>' + esc(unitRow.title) +
              '</b></div><div class="meta small">' + metaText(unitRow) +
              (unitRow.due ? ' · ' + unitRow.due + ' due' : '') +
              '</div></li>';
          }).join('') + '</ul></div>'
        : '') +
      '</article>';
  }

  function archivedUnitCard(entry, now) {
    var kept = C.withoutDeleted(state, { id: entry.setId, title: '', units: [entry] });
    var row = C.unitStats(state, { id: entry.setId }, kept ? C.unitsOf(kept)[0] : entry, now);
    return '<article class="card set-card" data-units="0">' +
      '<div class="set-main">' +
        '<div class="spread"><h3>' + esc(entry.title) + '</h3>' +
          '<span class="tag archived">archived unit</span></div>' +
        '<p class="small muted">Unit of ' + esc(entry.setTitle || entry.setId) + ', archived ' +
          esc(fmtDate(entry.archivedAt)) + '.</p>' +
        '<div class="bar tier-' + row.tier.key + '" title="' + row.points +
          '% mastery"><i style="width:' + row.points + '%"></i></div>' +
        '<div class="meta">' + metaText(row) +
          (row.due ? ' · ' + row.due + ' due' : '') + '</div>' +
        '<div class="row set-actions">' +
          '<button type="button" class="btn btn-sm btn-primary" data-restore-unit="' +
            esc(entry.id) + '" data-set="' + esc(entry.setId) + '">Restore</button>' +
        '</div>' +
      '</div></article>';
  }

  function renderArchive() {
    setPageTitle(['Archive']);
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
    html += deletedSectionHTML();

    appEl.innerHTML = html;
    bindRestoreButtons();
    $$('[data-restore-question]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        C.restoreQuestion(state, button.getAttribute('data-set'),
          button.getAttribute('data-restore-question'), Date.now());
        saveState();
        render();
      });
    });
  }

  /* Deleted questions of active sets, archived sets and archived units alike,
   * each with a way back. */
  function deletedSectionHTML() {
    var sets = C.browseSets(state, SOURCE_SETS);
    C.archivedSets(state).forEach(function (entry) {
      sets.push(entry.kind === 'unit'
        ? { id: entry.setId, title: entry.setTitle || entry.setId, units: [entry] }
        : entry);
    });
    var rows = C.deletedQuestions(state, sets);
    if (!rows.length) return '';
    return '<section class="card deleted-section"><h2>Deleted questions</h2>' +
      '<p class="muted small">Deleted questions are left out of practice, review, mastery ' +
      'and stats. Their files and progress are kept, so a restore brings them back as ' +
      'they were.</p><ul class="deleted-list">' +
      rows.map(function (row) {
        return '<li class="deleted-row"><div class="deleted-text">' +
            '<div class="small muted">' + esc(row.set.title) +
              (C.unitsOf(row.set).length > 1 ? ' · ' + esc(row.unit.title) : '') +
              (row.at ? ' · deleted ' + esc(fmtDate(row.at)) : '') + '</div>' +
            '<div class="deleted-stem">' + esc(row.q.question) + '</div>' +
          '</div><div class="row unit-actions">' +
            '<a class="btn btn-sm" href="' + browseHref(row.set.id, null, row.q.id) +
              '">View</a>' +
            '<button type="button" class="btn btn-sm btn-primary" data-restore-question="' +
              esc(row.q.id) + '" data-set="' + esc(row.set.id) + '">Restore</button>' +
          '</div></li>';
      }).join('') + '</ul></section>';
  }

  /* ------------------------------------------------------------ browse */
  /* Every question of the set in unit order, numbered across the whole set so
   * a number stays put while the list is filtered. */
  function browseEntries(set) {
    var out = [];
    C.unitsOf(set).forEach(function (unit) {
      unit.questions.forEach(function (question) {
        out.push({
          n: out.length + 1,
          unit: unit,
          q: question,
          deleted: C.isDeleted(state, set.id, question.id)
        });
      });
    });
    return out;
  }

  function browseFilter(entries, unitId) {
    var needle = browseQuery.trim().toLowerCase();
    return entries.filter(function (entry) {
      if (unitId && entry.unit.id !== unitId) return false;
      if (entry.deleted && !browseShowDeleted) return false;
      if (!needle) return true;
      var hay = [entry.q.id, entry.q.question, entry.q.passage]
        .concat(entry.q.choices).join('\n').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }

  function questionRecord(setId, questionId) {
    return state.q[C.questionKey(setId, questionId)] || null;
  }

  function recordText(rec, now) {
    if (!rec) return 'Not answered yet';
    return Math.round(rec.s / 10) + '% mastery share · ' + rec.c + '/' + rec.a +
      ' correct · ' + (rec.f ? 'right' : 'missed') + ' on the first try · ' +
      (rec.due <= now ? 'due now' : 'due ' + fmtDate(rec.due));
  }

  /* Point the hash at the shown question without a hashchange: moving through
   * the list repaints the panes in place, so scroll and focus stay put. */
  function syncBrowseHash(setId, unitId, questionId) {
    var hash = browseHref(setId, unitId, questionId);
    if (location.hash !== hash) history.replaceState(null, '', hash);
    lastRenderedHash = location.hash;
  }

  /* The live question set drops a question deleted under it; the answers it
   * already graded are saved, only the cursor is lost. */
  function dropSessionWith(setId, questionId) {
    if (!session || session.cfg.setId !== setId ||
        session.index >= session.questions.length) return;
    var hit = session.questions.some(function (question) { return question.id === questionId; });
    if (!hit) return;
    session = null;
    clearStoredSession();
  }

  function renderBrowse(params) {
    var setId = params.get('set') || '';
    var set = C.findBrowseSet(state, SOURCE_SETS, setId);
    if (!set) { renderMissingSet(setId); return; }
    var units = C.unitsOf(set);
    var unitId = params.get('unit') || '';
    if (unitId && !C.unitOf(set, unitId)) unitId = '';
    var current = params.get('q') || '';
    var browseUnit = unitId ? C.unitOf(set, unitId) : null;
    setPageTitle(['Browse', browseUnit ? set.title + ' · ' + browseUnit.title : set.title]);
    var all = browseEntries(set);
    var deletedCount = all.filter(function (entry) { return entry.deleted; }).length;
    var archived = !!state.archived[set.id];

    appEl.innerHTML =
      '<div class="browse-view">' +
        '<div class="prac-head">' +
          '<a class="btn btn-ghost btn-sm" href="' + (archived ? '#/archive">← Archive' : '#/">← Sets') +
            '</a>' +
          '<h1 class="head-title">' + esc(set.title) +
            ' <span class="muted small head-mode">· Browse</span></h1>' +
          '<span class="muted small">' + plural(all.length, 'question') +
            (deletedCount ? ' · ' + deletedCount + ' deleted' : '') + '</span>' +
        '</div>' +
        '<div class="set-tools">' +
          (units.length > 1
            ? '<label class="set-sort">Unit <select id="browse-unit">' +
              '<option value="">All units</option>' +
              units.map(function (unit) {
                return '<option value="' + esc(unit.id) + '"' +
                  (unit.id === unitId ? ' selected' : '') + '>' + esc(unit.title) + '</option>';
              }).join('') + '</select></label>'
            : '') +
          '<label class="set-search"><span class="sr-only">Filter questions</span>' +
            '<input type="search" id="browse-filter" placeholder="Filter questions" value="' +
              esc(browseQuery) + '" autocomplete="off" spellcheck="false"></label>' +
          '<label class="set-sort"><input type="checkbox" id="browse-deleted"' +
            (browseShowDeleted ? ' checked' : '') + '> Show deleted</label>' +
        '</div>' +
        '<div class="browse-grid">' +
          '<nav class="card browse-nav" aria-label="Questions">' +
            '<p class="small muted" id="browse-count" aria-live="polite"></p>' +
            '<ol class="browse-list" id="browse-list"></ol>' +
          '</nav>' +
          '<section class="card browse-viewer" id="browse-viewer" tabindex="-1" ' +
            'aria-label="Question"></section>' +
        '</div>' +
      '</div>';

    var view = { set: set, unitId: unitId, current: current };
    paintBrowse(view);

    var unitSelect = $('#browse-unit');
    if (unitSelect) unitSelect.addEventListener('change', function (event) {
      view.unitId = event.target.value;
      paintBrowse(view);
    });
    $('#browse-filter').addEventListener('input', function (event) {
      browseQuery = event.target.value;
      paintBrowse(view);
    });
    $('#browse-deleted').addEventListener('change', function (event) {
      browseShowDeleted = event.target.checked;
      paintBrowse(view);
    });
    $('#browse-list').addEventListener('click', function (event) {
      var button = event.target.closest('[data-qid]');
      if (!button) return;
      view.current = button.getAttribute('data-qid');
      paintBrowse(view);
    });
    $('#browse-viewer').addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      if (button.id === 'browse-prev') stepBrowse(view, -1);
      else if (button.id === 'browse-next') stepBrowse(view, 1);
      else if (button.hasAttribute('data-browse-delete')) toggleDeleted(view, true);
      else if (button.hasAttribute('data-browse-restore')) toggleDeleted(view, false);
      else if (button.hasAttribute('data-browse-reset')) resetQuestion(view);
    });
    browseView = view;
  }


  function stepBrowse(view, step) {
    var list = browseFilter(browseEntries(view.set), view.unitId);
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].q.id === view.current) { at = i; break; }
    }
    var next = list[at + step];
    if (!next) return;
    view.current = next.q.id;
    paintBrowse(view);
  }

  function toggleDeleted(view, on) {
    var setId = view.set.id;
    var questionId = view.current;
    if (on) {
      /* With deleted questions hidden, the cursor moves on to a neighbour
       * rather than onto an empty pane. */
      if (!browseShowDeleted) {
        var list = browseFilter(browseEntries(view.set), view.unitId);
        for (var i = 0; i < list.length; i++) {
          if (list[i].q.id !== questionId) continue;
          var neighbour = list[i + 1] || list[i - 1];
          if (neighbour) view.current = neighbour.q.id;
          break;
        }
      }
      C.deleteQuestion(state, setId, questionId, Date.now());
      dropSessionWith(setId, questionId);
    } else {
      C.restoreQuestion(state, setId, questionId, Date.now());
    }
    if (!saveState()) {
      window.alert('The change could not be saved because browser storage is full.');
    }
    syncBrowseHash(setId, view.unitId, view.current);
    render();
    var again = $('#browse-viewer [data-browse-restore], #browse-viewer [data-browse-delete]');
    if (again) again.focus({ preventScroll: true });
  }

  function resetQuestion(view) {
    if (!window.confirm('Reset progress for this question? Its history, mastery share ' +
        'and review date are forgotten.')) return;
    C.resetQuestionProgress(state, view.set.id, view.current, Date.now());
    if (!saveState()) {
      window.alert('The reset could not be saved because browser storage is full.');
    }
    paintBrowse(view);
  }

  /* Repaint the list and the viewer from the view and the filters. Focus on a
   * repainted control is carried over to its replacement. */
  function paintBrowse(view) {
    var listEl = document.getElementById('browse-list');
    var viewer = document.getElementById('browse-viewer');
    if (!listEl || !viewer) return;
    var active = document.activeElement;
    var focusId = active && active.id && viewer.contains(active) ? active.id : '';
    var focusList = !!active && listEl.contains(active);

    var all = browseEntries(view.set);
    var list = browseFilter(all, view.unitId);
    var entry = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].q.id === view.current) { entry = list[i]; break; }
    }
    if (!entry && list.length) entry = list[0];
    var at = entry ? list.indexOf(entry) : -1;
    view.current = entry ? entry.q.id : '';
    syncBrowseHash(view.set.id, view.unitId, view.current);

    var count = document.getElementById('browse-count');
    if (count) {
      var scope = view.unitId ? C.questionsOf(view.set, view.unitId).length : all.length;
      count.textContent = list.length === scope
        ? plural(list.length, 'question')
        : list.length + ' of ' + plural(scope, 'question');
    }
    listEl.innerHTML = list.map(function (item) {
      var rec = questionRecord(view.set.id, item.q.id);
      var badge = item.deleted
        ? '<span class="tag archived">deleted</span>'
        : rec ? '<span class="tag ' + shareTier(rec.s) + '">' + Math.round(rec.s / 10) +
          '%</span>' : '<span class="tag new">new</span>';
      return '<li><button type="button" class="browse-item' +
        (item.deleted ? ' is-deleted' : '') + '" data-qid="' + esc(item.q.id) + '"' +
        (item === entry ? ' aria-current="true"' : '') + '>' +
        '<span class="browse-num">' + item.n + '</span>' +
        '<span class="browse-stem">' + esc(item.q.question) + '</span>' + badge +
        '</button></li>';
    }).join('');

    if (!entry) {
      viewer.innerHTML = '<h2>No questions match</h2><p class="muted">' +
        (all.length ? 'Change the filter or show deleted questions.'
          : 'This set has no questions.') + '</p>';
      return;
    }

    var rec = questionRecord(view.set.id, entry.q.id);
    var multi = C.unitsOf(view.set).length > 1;
    viewer.innerHTML =
      '<div class="spread browse-head">' +
        '<span class="small muted">Question ' + entry.n + ' of ' + all.length +
          (multi ? ' · ' + esc(entry.unit.title) : '') +
          ' · <code>' + esc(entry.q.id) + '</code></span>' +
        '<span class="row browse-step">' +
          '<button type="button" class="btn btn-sm" id="browse-prev"' +
            (at <= 0 ? ' disabled' : '') + ' aria-label="Previous question">←</button>' +
          '<span class="small muted">' + (at + 1) + '/' + list.length + '</span>' +
          '<button type="button" class="btn btn-sm" id="browse-next"' +
            (at >= list.length - 1 ? ' disabled' : '') + ' aria-label="Next question">→</button>' +
        '</span>' +
      '</div>' +
      '<p class="small muted browse-record">' +
        (entry.deleted ? '<span class="tag archived">deleted</span> ' : '') +
        esc(recordText(rec, Date.now())) + '</p>' +
      '<div class="row browse-actions">' +
        (entry.deleted
          ? '<button type="button" class="btn btn-sm btn-primary" id="browse-restore" ' +
            'data-browse-restore>Restore question</button>'
          : '<button type="button" class="btn btn-sm btn-danger" id="browse-delete" ' +
            'data-browse-delete>Delete question</button>') +
        '<button type="button" class="btn btn-sm btn-ghost is-danger" id="browse-reset" ' +
          'data-browse-reset' + (rec ? '' : ' disabled') + '>Reset progress</button>' +
        (entry.deleted ? '' : '<a class="btn btn-sm" href="' +
          practiceHref(view.set.id, multi ? entry.unit.id : null, null) + '">Practice ' +
          (multi ? 'this unit' : 'this set') + '</a>') +
      '</div>' +
      '<div class="browse-question">' + staticQuestionHTML(entry.q) + '</div>';

    var selected = listEl.querySelector('[aria-current="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
      if (focusList) selected.focus({ preventScroll: true });
    }
    if (focusId) {
      var again = document.getElementById(focusId);
      if (again && !again.disabled) again.focus({ preventScroll: true });
      else viewer.focus({ preventScroll: true });
    }
  }

  function shareTier(share) {
    return C.tierOf(Math.round(share / 10), 1).key;
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
    persistSession();
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
    setPageTitle(['Set not found']);
    appEl.innerHTML = '<div class="card"><h2>Question set not found</h2>' +
      '<p>No set with id <code>' + esc(setId) + '</code> is loaded from ' +
      '<code>questions/index.json</code> or archived.</p>' +
      '<p><a class="btn btn-primary" href="#/">Back to sets</a></p></div>';
  }

  function renderMissingUnit(set, unitId) {
    setPageTitle(['Unit not found', set.title]);
    appEl.innerHTML = '<div class="card"><h2>Unit not found</h2>' +
      '<p>' + esc(set.title) + ' has no unit with id <code>' + esc(unitId) +
      '</code>. It may have been archived or removed from the folder.</p>' +
      '<p><a class="btn btn-primary" href="#/">Back to sets</a></p></div>';
  }

  function renderEmptySession() {
    setPageTitle([session ? modeLabel(session.cfg.mode) : 'Practice', sessionTitle()]);
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

    setPageTitle([modeLabel(session.cfg.mode), sessionTitle()]);
    var record = state.sets[set.id] || {};
    var questions = C.questionsOf(set);
    var mastery = C.masteryOf(state, set.id, questions);
    var run = record.streak || 0;

    appEl.innerHTML =
      '<div class="practice-view" id="practice-view">' +
        '<div class="prac-head">' +
          '<a class="btn btn-ghost btn-sm" href="#/">← Sets</a>' +
          '<h1 class="head-title">' + esc(sessionTitle()) +
            ' <span class="muted small head-mode">· ' +
            esc(modeLabel(session.cfg.mode)) + '</span></h1>' +
          '<div class="prac-tools">' +
            '<span class="pill mastery-pill" id="mastery-pill" title="Mastery of ' +
              esc(set.title) + ' averaged over all ' + questions.length + ' questions — ' +
              'first-try answers count most; repeats add, misses take away">Mastery ' +
              '<b id="mastery-pill-value">' + mastery + '%</b></span>' +
            '<span class="pill streak-chip" id="streak-chip"' +
              (run >= 2 ? '' : ' hidden') + ' title="Correct answers in a row in this set">' +
              '🔥 <b id="streak-value">' + run + '</b></span>' +
            '<span class="pill timer-pill" id="timer">0:00</span>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="end-session"' +
              ' title="Stop here and see the results for the questions answered so far">' +
              'End session</button>' +
          '</div>' +
        '</div>' +
        '<div class="dots" id="dots" aria-hidden="true"></div>' +
        '<div class="card" id="qcard"></div>' +
      '</div>';

    /* A repaint of a session with progress must not reset the cursor: leaving
     * for another route and coming back keeps the selection, the graded
     * feedback and the crossed-out choices. A new session's first, untouched
     * question still takes the entrance animation. */
    var keep = session.index > 0 || session.checked || session.selected != null ||
      Object.keys(session.excluded).length > 0 || session.results.length > 0;
    document.getElementById('end-session').addEventListener('click', endSessionEarly);
    showQuestion(session.index, keep);
  }

  /* Stop before the last question. With answers to show this is the results
   * screen; with none there is nothing to summarise, so it returns to the
   * sets. Answers already given were saved when they were checked. */
  function endSessionEarly() {
    if (!session || session.index >= session.questions.length) return;
    if (!session.results.length) {
      session = null;
      clearStoredSession();
      location.hash = '#/';
      return;
    }
    C.endSession(session);
    persistSession();
    renderResults();
    window.scrollTo(0, 0);
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
      '<button type="button" class="choice" role="radio" aria-checked="false" data-i="' +
        index + '">' +
        '<span class="letter">' + letter + '</span>' +
        '<span class="choice-text">' + esc(text) + '</span></button>' +
      '<span class="choice-flag" aria-hidden="true"></span>' +
      elimHTML(index, letter) + '</div>';
  }

  function showQuestion(index, keepState, focusStem) {
    var question = session.questions[index];
    if (!keepState) {
      session.selected = null;
      session.checked = false;
      session.excluded = {};
    }
    /* A fast key sequence can reach the next question while the last burst is
     * still in the air; drop those layers so sparks never trail onto a fresh
     * question. */
    $$('.burst').forEach(function (layer) {
      if (layer.parentNode) layer.parentNode.removeChild(layer);
    });
    renderDots();

    var choices = C.choicesFor(question).map(function (text, i) {
      return '<li class="choice-item" style="--i:' + i + '">' +
        choiceHTML(i, question, text) + '</li>';
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
      '<div class="stem" tabindex="-1">' + esc(question.question) + '</div>' +
      '<ul class="choices" id="choices" role="radiogroup" aria-label="Answer choices">' +
        choices + '</ul>' +
      '<div class="actions">' +
        '<button type="button" class="btn btn-primary" id="action" disabled>' +
          'Check answer</button>' +
        '<span class="kbdhint"><kbd>A</kbd>–<kbd>Z</kbd> / <kbd>1</kbd>–<kbd>9</kbd> choose · ' +
          '<kbd>Shift</kbd>+letter cross out · <kbd>Enter</kbd> check / next</span>' +
        '<button type="button" class="shortcut-help" id="shortcut-help"' +
          ' aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>' +
      '</div>' +
      '<div id="feedback" aria-live="polite"></div>';

    /* A fresh question slides in and its choices cascade; the stage halo
     * returns to neutral until this question is graded. A restored question
     * is not new, so it appears as it was left. */
    if (!keepState) card.classList.add('q-enter');
    var view = document.getElementById('practice-view');
    if (view) view.removeAttribute('data-mood');

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
    var shortcutHelp = document.getElementById('shortcut-help');
    if (shortcutHelp) {
      shortcutHelp.addEventListener('click', function () {
        openShortcuts(shortcutHelp);
      });
    }

    if (session.checked) {
      var record = resultAt(index);
      if (record) {
        renderGraded(record, false);
        /* The clock stays frozen at the answering time. */
        paintTimer();
        return;
      }
      /* Defensive: a checked cursor with no record cannot show feedback. */
      session.checked = false;
      session.selected = null;
      session.excluded = {};
    }
    syncChoices();
    /* A new question is announced by landing focus on its stem; the card was
     * just rebuilt, so the previous focus target is gone. */
    if (focusStem) {
      var stem = $('.stem', card);
      if (stem) stem.focus({ preventScroll: true });
    }
    resumeTimer();
  }

  /* Re-paint every row from the session state, including the cross-out buttons.
   * The radiogroup keeps one tab stop: the chosen choice, or the first one
   * that can still be chosen, so Tab enters the group instead of walking
   * every option. */
  function syncChoices() {
    var question = session.questions[session.index];
    var count = C.choicesFor(question).length;
    var tabStop = session.selected != null ? session.selected : -1;
    for (var j = 0; tabStop < 0 && j < count; j++) {
      if (!session.excluded[j]) tabStop = j;
    }
    $$('#choices .choice-row').forEach(function (row, i) {
      var letter = letterFor(i);
      var excluded = !!session.excluded[i];
      var label = (excluded ? 'Include' : 'Exclude') + ' choice ' + letter;
      row.className = rowClass(i, question);
      var choice = $('.choice', row);
      choice.setAttribute('aria-checked', String(i === session.selected));
      choice.tabIndex = !session.checked && i === tabStop ? 0 : -1;
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
    persistSession();
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
    persistSession();
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
    var choices = C.choicesFor(question).map(function (text, i) {
      var letter = letterFor(i);
      var cls = i === question.answer ? ' is-correct' : ' dimmed';
      return '<li class="choice-item"><div class="choice-row is-static' + cls + '">' +
        '<div class="choice"><span class="letter">' + letter + '</span>' +
        '<span class="choice-text">' + esc(text) + '</span></div>' +
        '<span class="choice-flag" aria-hidden="true"></span></div>' +
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

  /* Paint the graded question: rows, per-choice notes, action label and the
   * feedback card. A live answer animates the reward; a restored one passes
   * animate=false so nothing is replayed and progress is never touched. */
  function renderGraded(record, animate) {
    var question = record.question;
    var streak = record.streak;

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

    /* The reward line: the mastery delta with the new total, the streak once
     * there is one to show, and when the item comes back. */
    var signed = (record.pointsDelta > 0 ? '+' : '') + record.pointsDelta;
    var masteryClass = record.pointsDelta > 0 ? 'up'
      : (record.pointsDelta < 0 ? 'down' : 'flat');
    var mastery = '<span class="mastery-delta ' + masteryClass + '">' +
      (record.pointsDelta === 0 ? 'no change' : signed) + '</span>' +
      ' <span class="muted">mastery now <b class="mastery-now ' + masteryClass +
        '" id="mastery-now">' + record.pointsAfter + '%</b></span>';

    var gapDays = C.SRS_INTERVALS_DAYS[record.boxAfter];
    var when = gapDays === 0
      ? 'back in the next review session'
      : 'next review in ' + plural(gapDays, 'day');

    var streakBadge = (record.correct && streak >= 2)
      ? ' <span class="streak-badge' + (streak >= 5 ? ' hot' : '') + '">🔥 ' +
        streak + ' in a row</span>'
      : '';

    document.getElementById('feedback').innerHTML =
      '<div class="feedback ' + (record.correct ? 'correct' : 'incorrect') + '">' +
        '<div class="verdict"><span class="icon" aria-hidden="true">' +
          (record.correct ? '✓' : '✗') + '</span>' +
          (record.correct
            ? 'Correct' + (record.coin === 'repeat' ? ' — you had this one right before' : '')
            : 'Not quite — the answer is ' + record.expected +
              (record.chosen !== record.expected ? ' (you chose ' + record.chosen + ')' : '')) +
          streakBadge +
        '</div>' +
        explanationHTML(question) +
        '<div class="reward small">' + mastery +
          '<span class="review-chip">↻ ' + when + '</span>' +
        '</div>' +
      '</div>';
    updatePracticeStatus(record, streak, animate);
    renderDots();
    /* core's answer result carries what the answer was worth; the streak lives
     * on the set record and was copied into the result at answer time. */
    if (animate) {
      celebrate({
        correct: record.correct,
        coin: record.coin,
        streak: streak,
        pointsAfter: record.pointsAfter
      }, record.pointsBefore);
    }
  }

  function checkAnswer() {
    if (session.checked || session.selected == null) return;
    var question = session.questions[session.index];
    var questions = C.questionsOf(session.set);
    var pointsBefore = C.masteryOf(state, session.set.id, questions);
    var result = C.applyAnswer(state, session.set.id, question, session.selected, Date.now());
    var pointsAfter = C.masteryOf(state, session.set.id, questions);
    session.checked = true;
    var record = {
      index: session.index,
      questionId: question.id,
      question: question,
      chosen: result.chosen,
      correct: result.correct,
      expected: result.expected,
      pointsDelta: pointsAfter - pointsBefore,
      coin: result.coin,
      pointsBefore: pointsBefore,
      pointsAfter: pointsAfter,
      boxBefore: result.boxBefore,
      boxAfter: result.boxAfter,
      streak: (state.sets[session.set.id] || {}).streak || 0
    };
    session.results.push(record);
    /* pauseTimer() both records the answering time and saves the session. */
    pauseTimer();
    saveState();
    renderPills();
    renderGraded(record, true);
  }

  function nextQuestion() {
    if (!session.checked) return;
    session.index += 1;
    if (session.index >= session.questions.length) {
      renderResults();
    } else {
      showQuestion(session.index, false, true);
      persistSession();
    }
    window.scrollTo(0, 0);
  }

  function renderResults() {
    setPageTitle(['Results', sessionTitle()]);
    pauseTimer();
    var results = session.results.slice().sort(function (a, b) { return a.index - b.index; });
    var correct = results.filter(function (r) { return r.correct; }).length;
    var missed = results.filter(function (r) { return !r.correct; });
    var percent = results.length ? Math.round((correct / results.length) * 100) : 0;
    var early = C.endedEarly(session);

    var delta = results.reduce(function (sum, r) { return sum + r.pointsDelta; }, 0);
    var deltas = delta === 0 ? ''
      : '<span class="tag ' + (delta > 0 ? 'mastered' : 'warn') + '">' +
        esc(sessionTitle()) + ' ' + (delta > 0 ? '+' : '') + delta + '</span>';

    var rows = results.map(function (r, i) {
      var question = r.question;
      return '<div class="result-row" style="--i:' + i + '">' +
        '<span class="n">' + (i + 1) + '</span>' +
        '<span class="' + (r.correct ? 'ok' : 'no') + '" aria-hidden="true">' +
          (r.correct ? '✓' : '✗') + '</span>' +
        '<span class="sr-only">' + (r.correct ? 'Correct' : 'Incorrect') + '</span>' +
        '<span class="grow">' + esc(question.question.slice(0, 80)) +
          (question.question.length > 80 ? '…' : '') + '</span>' +
        '<span class="muted small"><span class="sr-only">your answer </span>' + r.chosen +
          (r.correct ? '' : ' <span aria-hidden="true">→</span>' +
            '<span class="sr-only">, correct answer </span>' + r.expected) + '</span>' +
      '</div>';
    }).join('');

    var review = missed.map(function (r) {
      return '<div class="review-item"><div class="q-meta"><span class="tag">' +
        esc(sessionTitle()) + '</span><span class="tag warn">you chose ' + r.chosen +
        '</span></div>' + staticQuestionHTML(r.question) + '</div>';
    }).join('');

    var scoreTier = percent >= 80 ? 'high' : (percent >= 50 ? 'mid' : 'low');
    var deltaClass = delta > 0 ? 'ok' : (delta < 0 ? 'no' : '');
    var time = fmtTime(elapsedMs());
    appEl.innerHTML =
      '<div class="card"><div class="results-head"><div>' +
        '<h1 id="results-title" tabindex="-1">' +
          (early ? 'Session ended' : 'Session complete') + '</h1><div class="muted">' +
        esc(sessionTitle()) + ' · ' +
        esc(modeLabel(session.cfg.mode)) + ' · ' + time +
        (early ? ' · ' + results.length + ' of ' + session.questions.length + ' answered' : '') +
        '</div></div>' +
        '<div class="score-ring tier-' + scoreTier + '" id="score-ring">' +
          '<div class="score-inner"><b id="score-value">0%</b><span>score</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + correct + '/' + results.length +
          '</b><span>correct</span></div>' +
        '<div class="stat"><b>' + missed.length + '</b><span>coming back in review</span></div>' +
        '<div class="stat"><b class="' + deltaClass + '">' +
          (delta > 0 ? '+' : '') + delta + '</b><span>mastery this session</span></div>' +
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
      '<div class="card"><h2>Question by question</h2>' + rows + '</div>' +
      (review ? '<div class="card"><h2>Review your misses</h2>' + review + '</div>' : '');

    animateScore(percent);
    playResults(percent);
    if (percent >= 80) {
      window.setTimeout(function () {
        burst(document.getElementById('score-ring'), percent >= 100 ? 34 : 24);
      }, 420);
    }
    var again = document.getElementById('again');
    if (again) {
      again.addEventListener('click', function () {
        /* Start from the clean practice URL: the results may belong to a retry
         * run, whose mode and question count must not leak into the new one. */
        var setId = session.set.id;
        var unitId = session.cfg.unitId || '';
        var target = practiceHref(setId, unitId, null);
        session = null;
        clearStoredSession();
        if (location.hash === target) {
          render();
          window.scrollTo(0, 0);
          focusQuestionOrMain();
        } else location.hash = target;
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
        var target = '#/practice?set=' + encodeURIComponent(setId) +
          (unitId ? '&unit=' + encodeURIComponent(unitId) : '') +
          '&mode=retry&n=' + questions.length;
        /* The hashchange handler renders the retry session; render directly
         * only when the URL is already the same and no event would fire. */
        if (location.hash === target) {
          render();
          window.scrollTo(0, 0);
          focusQuestionOrMain();
        } else location.hash = target;
      });
    }

    /* The session view this replaces had focus on an action that no longer
     * exists; land on the results heading so the outcome is announced. */
    var title = document.getElementById('results-title');
    if (title) title.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ stats */
  function resetSetProgress(setId) {
    var set = C.findSet(state, SOURCE_SETS, setId);
    var title = set ? set.title : setId;
    if (!window.confirm('Reset progress for "' + title + '"? Per-question history, ' +
        'mastery and review dates are forgotten. Daily activity and all-time totals ' +
        'are kept.')) return;
    C.resetSetProgress(state, setId, Date.now());
    if (!saveState()) {
      window.alert('The reset could not be saved because browser storage is full.');
    }
    render();
  }

  /* Trouble rows come from allSets(), archived history included. A practice
   * button may only offer questions the resolved set still exposes: an
   * archived unit of an active set (or a fully archived set) would otherwise
   * build a preselected session that a reload cannot restore. */
  function troublePracticeBySet() {
    var groups = {};
    lastTroubleRows.forEach(function (row) {
      var set = C.findSet(state, SOURCE_SETS, row.set.id);
      if (!set) return;
      var questions = C.questionsOf(set);
      var found = false;
      for (var i = 0; i < questions.length; i++) {
        if (questions[i].id === row.q.id) { found = true; break; }
      }
      if (!found) return;
      if (!groups[set.id]) groups[set.id] = [];
      groups[set.id].push(row);
    });
    return groups;
  }

  function bindStatsButtons() {
    $$('[data-reset-set]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        resetSetProgress(button.getAttribute('data-reset-set'));
      });
    });
    $$('[data-practice-set]', appEl).forEach(function (button) {
      button.addEventListener('click', function () {
        var setId = button.getAttribute('data-practice-set');
        var rows = troublePracticeBySet()[setId] || [];
        var questions = rows.map(function (row) { return row.q; });
        if (!questions.length) return;
        var created = createSession({
          setId: setId,
          unitId: '',
          mode: 'retry',
          length: questions.length
        }, questions);
        if (!created) return;
        var hash = '#/practice?set=' + encodeURIComponent(setId) +
          '&mode=retry&n=' + questions.length;
        if (location.hash === hash) render();
        else location.hash = hash;
      });
    });
  }

  function renderStats() {
    setPageTitle(['Progress']);
    var sets = C.allSets(state, SOURCE_SETS);
    var now = Date.now();
    var rows = C.allSetStats(state, sets, now);
    var stats = C.statsFromRows(state, rows, now);
    var days = C.activity(state, 14);
    var peak = days.reduce(function (n, day) { return Math.max(n, day.a); }, 0);
    var trouble = C.troubleSpots(state, sets, 8);
    var due = activeDue();
    /* The chart is a 14-day window; its total must be the sum of those days,
     * not the all-time answer count shown elsewhere on the page. */
    var fortnight = days.reduce(function (n, day) { return n + day.a; }, 0);
    var busiest = days.reduce(function (best, day) { return day.a > best.a ? day : best; }, days[0]);

    var activity = '<div class="spark" aria-hidden="true">' + days.map(function (day) {
      var h = peak ? Math.round((day.a / peak) * 100) : 0;
      return '<div class="' + (day.a ? 'has' : '') + '" style="height:' + Math.max(h, 6) +
        '%" title="' + day.date + ': ' + plural(day.a, 'question') + ', ' + day.c +
        ' right"></div>';
    }).join('') + '</div>' +
    '<div class="spark-legend"><span>' + days[0].date + '</span>' +
      '<span>' + plural(fortnight, 'answer') + ' in 14 days</span>' +
      '<span>today</span></div>' +
    '<p class="sr-only">Last 14 days: ' + plural(fortnight, 'answer') + '; busiest day ' +
      busiest.date + ' with ' + plural(busiest.a, 'answer') + '.</p>';

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
        '<td class="num">' + (row.due || '—') + '</td>' +
        '<td class="num"><button type="button" class="btn btn-ghost btn-sm is-danger" ' +
          'data-reset-set="' + esc(row.id) + '" aria-label="Reset progress for ' +
          esc(row.title) + '">Reset</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted">No sets loaded.</td></tr>';

    lastTroubleRows = trouble;
    var practiceGroups = troublePracticeBySet();
    var troubleSets = Object.keys(practiceGroups).map(function (setId) {
      var groupRows = practiceGroups[setId];
      return { id: setId, title: groupRows[0].set.title, n: groupRows.length };
    });
    var troubleButtons = troubleSets.map(function (entry) {
      var label = entry.n === 1
        ? 'Practice this question'
        : 'Practice these ' + entry.n;
      var aria = entry.n === 1
        ? 'Practice this trouble question from ' + esc(entry.title)
        : 'Practice these ' + entry.n + ' trouble questions from ' + esc(entry.title);
      return '<button type="button" class="btn btn-sm" data-practice-set="' +
        esc(entry.id) + '" aria-label="' + aria + '">' + label + '</button>';
    }).join('');

    var troubleHTML = (troubleButtons
      ? '<div class="row" style="margin-bottom:.7rem">' + troubleButtons + '</div>'
      : '') + (trouble.length ? trouble.map(function (row) {
      var where = esc(row.set.title) +
        (row.unit && row.unit.title !== row.set.title ? ' · ' + esc(row.unit.title) : '');
      return '<details class="review-item"><summary>' + where + ' — missed ' +
        row.wrong + ' of ' + row.attempts + ' attempts</summary>' +
        '<div style="margin-top:.7rem">' + staticQuestionHTML(row.q) + '</div></details>';
    }).join('') : '<p class="muted small">No repeated misses yet.</p>');

    appEl.innerHTML =
      '<div class="card"><h1>Your progress</h1>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + stats.answered + '</b><span>answers given</span></div>' +
        '<div class="stat"><b>' + stats.accuracy + '%</b><span>first-try correct</span></div>' +
        '<div class="stat"><b>' + stats.seen + '/' + stats.bankSize +
          '</b><span>questions seen</span></div>' +
        '<div class="stat"><b>' + stats.mastered + '</b><span>sets mastered</span></div>' +
        '<div class="stat"><b>' + stats.streak + '</b><span>day streak</span></div>' +
        '<div class="stat"><b>' + due + '</b><span>due now</span></div>' +
      '</div></div>' +
      '<div class="card"><h2>Last 14 days</h2>' + activity + '</div>' +
      '<div class="card"><h2>Sets</h2>' +
        '<div class="table-scroll" role="region" aria-label="Set progress table" tabindex="-1">' +
        '<table class="sets-table">' +
        '<thead><tr>' +
        '<th scope="col">Set</th><th scope="col"><span class="sr-only">Mastery bar</span></th>' +
        '<th class="num" scope="col">Mastery</th><th scope="col">Tier</th>' +
        '<th class="num" scope="col">Seen</th><th class="num" scope="col">First try</th>' +
        '<th class="num" scope="col">Due</th>' +
        '<th scope="col"><span class="sr-only">Actions</span></th>' +
        '</tr></thead><tbody>' + table + '</tbody></table></div>' +
        '<p class="table-hint small muted" aria-hidden="true">' +
          'Scroll sideways for more columns →</p></div>' +
      '<div class="card"><h2>Trouble spots</h2>' + troubleHTML + '</div>';
    bindStatsButtons();
    syncTableHint();
  }

  /* A sideways-scrolling table is only reachable by keyboard when it actually
   * overflows; the hint next to it follows the same condition. */
  function syncTableHint() {
    var wrap = document.querySelector('.table-scroll');
    if (!wrap) return;
    var overflows = wrap.scrollWidth > wrap.clientWidth + 1;
    wrap.setAttribute('tabindex', overflows ? '0' : '-1');
    var hint = document.querySelector('.table-hint');
    if (hint) hint.classList.toggle('show', overflows);
  }

  /* ------------------------------------------------------------ settings */
  function persistenceHTML() {
    var html = '';
    if (localWriteFailed) {
      html += '<p class="small warnline">Browser storage is full or blocked, so answers ' +
        'may be lost on reload. Export your progress now, then free up storage.</p>';
    }
    if (PERSISTENCE_MODE === 'disk') {
      if (diskUnreadable) {
        html += '<p class="small warnline">The progress file at <code>' +
          esc(PROGRESS_PATH || 'progress/progress.json') +
          '</code> could not be read. Your browser copy is safe and is being used. ' +
          'The next save replaces the unreadable file after keeping it as ' +
          '<code>.bak</code>.</p>' +
          '<div class="row"><button type="button" class="btn" id="repair-progress">' +
          'Replace with browser copy</button></div>';
      }
      html += diskPushFailed
        ? '<p class="small muted">Saved in this browser only; the server mirror at <code>' +
          esc(PROGRESS_PATH || 'progress/progress.json') +
          '</code> did not accept the last write.</p>'
        : '<p class="small muted">Saved to disk at <code>' +
          esc(PROGRESS_PATH || 'progress/progress.json') +
          '</code> and cached in this browser.</p>';
      return html;
    }
    html += '<p class="small muted">Browser-only: this page cannot reach the progress API. ' +
      'Start the trainer with <code>./qt</code> (or <code>python3 serve.py</code>) to save ' +
      'progress to disk.</p>';
    return html;
  }

  /* "12 answers, 3 sessions, 1 archived set": what a progress state holds, as
   * the import confirmation and its note name it. */
  function summaryText(summary) {
    var parts = [
      plural(summary.answers, 'answer'),
      plural(summary.sessions, 'session'),
      plural(summary.archivedSets, 'archived set')
    ];
    if (summary.archivedUnits) parts.push(plural(summary.archivedUnits, 'archived unit'));
    return parts.join(', ');
  }

  function renderSettings(route) {
    setPageTitle(['Settings']);
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
      '<h2 class="section-label">Session</h2>' +
      '<label class="field"><span class="field-text">Questions per session</span>' +
        '<select id="length">' + lengths + '</select></label>' +
      '<label class="field check"><input type="checkbox" id="practice-all"' +
        (state.settings.practiceAll !== false ? ' checked' : '') + '>' +
        '<span class="field-text">Practice every question in a set with 30 or fewer ' +
        'questions, regardless of the session length ' +
        '<span class="muted small">(spaced review always serves only what is due)' +
        '</span></span></label>' +
      '<label class="field"><span class="field-text">Theme</span>' +
        '<select id="theme">' +
        ['auto', 'light', 'dark'].map(function (theme) {
          return '<option value="' + theme + '"' +
            (state.settings.theme === theme ? ' selected' : '') + '>' + theme + '</option>';
        }).join('') + '</select></label>' +
      '<h2 class="section-label" style="margin-top:1.1rem">Feedback</h2>' +
      '<label class="field check"><input type="checkbox" id="s-sound"' +
        (state.settings.sound ? ' checked' : '') + '>' +
        '<span class="field-text">Sound effect on a correct and on a wrong answer ' +
        '<span class="muted small">(a right answer also pulses the card, throws ' +
        'sparks from the tick, counts the new mastery up and chimes a note longer once a ' +
        'streak is running; the clock pauses while you read the feedback either way)' +
        '</span></span></label>' +
      '</div>' +
      '<div class="card"><h2>Question data</h2>' +
      '<p class="small muted">Loaded <b>' + SOURCE_SETS.length + '</b> ' +
        (SOURCE_SETS.length === 1 ? 'set' : 'sets') + ' with <b>' +
        SOURCE_SETS.reduce(function (n, set) { return n + C.unitsOf(set).length; }, 0) +
        ' units</b> from <code>questions/index.json</code>.' +
        (LOAD_ERRORS.length ? ' <b>' + LOAD_ERRORS.length + '</b> data ' +
          plural(LOAD_ERRORS.length, 'problem') + ' — see the banner at the top.' : '') +
        ' <a href="#/format">JSON format</a>.</p>' +
      '<p class="small muted">There is no mixed practice: each session draws only from the ' +
        'set or unit you choose.</p></div>' +
      '<div class="card"><h2>Progress data</h2>' +
      persistenceHTML() +
      '<p class="muted small">Back it up as JSON if you switch machines or clear site ' +
        'data. Archived sets are included in the export.</p>' +
      '<div class="row"><button type="button" class="btn" id="export">Export JSON</button>' +
        '<button type="button" class="btn" id="import-btn">Import JSON</button>' +
        '<button type="button" class="btn btn-danger" id="reset">Reset all data</button>' +
        '<input type="file" id="import-file" accept="application/json" hidden></div>' +
      '<p class="small muted" id="note" role="status" style="margin-top:.7rem"></p>' +
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
      /* Switching it on chimes once, so the setting proves itself with the same
       * reward a first-time correct earns. */
      if (state.settings.sound) playVerdict({ correct: true, coin: 'new', streak: 0 });
    });
    var repair = document.getElementById('repair-progress');
    if (repair) repair.addEventListener('click', function () {
      diskUnreadable = false;
      diskPushFailed = false;
      pushProgress();
      renderSettings(route);
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
      var input = event.target;
      var file = input.files[0];
      /* Clear the input now, so picking the same file again (after a refusal,
       * a cancelled confirmation or a fix to the file) still fires a change. */
      input.value = '';
      if (!file) return;
      file.text().then(function (text) {
        var result = C.parseProgressImport(text, Date.now());
        if (!result.ok) {
          note.textContent = result.message;
          return;
        }
        if (!window.confirm('Replace your current progress (' +
            summaryText(C.progressSummary(state)) + ') with the progress in "' + file.name +
            '" (' + summaryText(C.progressSummary(result.state)) + ')? ' +
            'Everything here now is overwritten; export it first to keep a copy.')) {
          note.textContent = 'Import cancelled. Your progress is unchanged.';
          return;
        }
        state = result.state;
        var saved = saveState();
        applyTheme();
        renderPills();
        /* The controls above show the old settings; repaint them from the
         * imported ones, then report on the fresh page. */
        renderSettings(route);
        document.getElementById('note').textContent = 'Imported: ' +
          summaryText(C.progressSummary(state)) + '.' +
          (saved ? '' : ' The browser could not save it (storage is full).');
      }, function (err) {
        note.textContent = 'Could not read "' + file.name + '"' +
          (err && err.message ? ': ' + err.message : '') + '. Your progress is unchanged.';
      });
    });
    $('#reset').addEventListener('click', function () {
      if (!window.confirm('Delete all practice history, progress and archived copies? ' +
          'Your source sets stay in questions/index.json.')) return;
      clearStoredState();
      state = C.emptyState(Date.now());
      session = null;
      clearStoredSession();
      saveState();
      applyTheme();
      renderPills();
      renderSettings(route);
      document.getElementById('main').focus({ preventScroll: true });
    });
  }

  /* ------------------------------------------------------------ format */
  function renderFormat() {
    setPageTitle(['Format']);
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
      '<h2>Set folder index fields</h2><table><thead><tr>' +
        '<th scope="col">Field</th><th scope="col"></th>' +
      '<th scope="col">Meaning</th></tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>optional</td><td>Stable, unique set id. Progress ' +
        'and archiving are keyed by it; it defaults to the folder name.</td></tr>' +
      '<tr><td><code>title</code></td><td>required</td><td>Name shown on the set card.</td></tr>' +
      '<tr><td><code>description</code></td><td>optional</td><td>Short line under the title.</td></tr>' +
      '<tr><td><code>units</code></td><td>required</td><td>One or more bare unit file names ' +
        'in the same folder, in display order.</td></tr></tbody></table>' +
      '<h2>Unit fields</h2><table><thead><tr><th scope="col">Field</th>' +
      '<th scope="col"></th><th scope="col">Meaning</th>' +
      '</tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>required</td><td>Unique within the set.</td></tr>' +
      '<tr><td><code>title</code></td><td>required</td><td>Name shown on the unit row.</td></tr>' +
      '<tr><td><code>description</code></td><td>optional</td><td>Short line under the title.</td></tr>' +
      '<tr><td><code>questions</code></td><td>required</td><td>Non-empty array of question ' +
        'objects. Question ids must be unique across the whole set, because progress is ' +
        'keyed by set id plus question id.</td></tr></tbody></table>' +
      '<h2>Question fields</h2><table><thead><tr><th scope="col">Field</th>' +
      '<th scope="col"></th><th scope="col">Meaning</th>' +
      '</tr></thead><tbody>' +
      '<tr><td><code>id</code></td><td>required</td><td>Unique within the set. Stable ids ' +
        'keep progress attached when you edit the file.</td></tr>' +
      '<tr><td><code>question</code></td><td>required</td><td>The question stem.</td></tr>' +
      '<tr><td><code>choices</code></td><td>required</td><td>Two or more choice strings. ' +
        'Labels A, B, C … are generated from their order. The app appends a final ' +
        '<b>I don\'t know</b> choice, which is always graded wrong and is not part of ' +
        'the JSON.</td></tr>' +
      '<tr><td><code>answer</code></td><td>required</td><td>0-based index of the correct ' +
        'authored choice. The example answer <code>1</code> means the second choice. ' +
        'The automatic <b>I don\'t know</b> choice can never be the answer.</td></tr>' +
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
      '<tr><td><code>explanations</code></td><td>optional</td><td>One entry per authored ' +
        'choice (string or <code>null</code>); each non-empty entry is shown under that ' +
        'choice.</td></tr>' +
      '</tbody></table>' +
      '<p class="small muted">A broken unit file is skipped and reported in the banner with ' +
      'its folder and file name; the rest of the set still loads. Duplicate or missing set ' +
      'ids are reported too.</p></div>' +
      '<div class="card"><h2>Running it</h2>' +
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

  /* ------------------------------------------------------------ shortcuts */
  /* The skip link must not rewrite the hash: the router reads it, so
   * href="#main" would leave the current page (and render the set list). It
   * scrolls to the top and lands focus on the main landmark instead. */
  (function () {
    var skip = document.querySelector('a.skip');
    if (!skip) return;
    skip.addEventListener('click', function (event) {
      var main = document.getElementById('main');
      if (!main) return;
      event.preventDefault();
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  })();

  var shortcutsOpener = null;

  function openShortcuts(opener) {
    var dialog = document.getElementById('shortcuts');
    if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
    shortcutsOpener = opener || document.activeElement;
    dialog.showModal();
    var close = document.getElementById('shortcuts-close');
    if (close) close.focus();
    else dialog.focus();
  }

  (function () {
    var dialog = document.getElementById('shortcuts');
    if (!dialog) return;
    dialog.addEventListener('click', function (event) {
      /* A click on the backdrop reports the dialog itself as the target, but so
       * does a click in the dialog's own padding; only a point outside the
       * dialog box is a backdrop click. */
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) {
        dialog.close();
      }
    });
    /* Covers the Close button and Esc alike; focus returns to what opened it. */
    dialog.addEventListener('close', function () {
      var opener = shortcutsOpener;
      shortcutsOpener = null;
      if (opener && opener !== document.body && opener !== document.documentElement &&
          typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus();
        return;
      }
      var main = document.getElementById('main');
      if (main) main.focus();
    });
  })();

  /* `?` opens the help from any route, but never while typing or editing. The
   * practice key handler ignores it, so it cannot choose a letter as well. */
  document.addEventListener('keydown', function (event) {
    if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
    var target = event.target || {};
    var tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' ||
        target.isContentEditable) return;
    var dialog = document.getElementById('shortcuts');
    if (dialog && dialog.open) return;
    event.preventDefault();
    openShortcuts(document.activeElement);
  });

  /* ------------------------------------------------------------ keyboard */
  /* In the browser, ← → and J K step through the filtered list. */
  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (parseHash().path !== '/browse' || !browseView) return;
    if (document.querySelector('dialog[open]')) return;
    var tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    var key = event.key;
    var step = key === 'ArrowLeft' || key === 'k' ? -1
      : key === 'ArrowRight' || key === 'j' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    stepBrowse(browseView, step);
  });

  function focusChoice(index) {
    var button = $('#choices .choice[data-i="' + index + '"]');
    if (button && !button.disabled) button.focus();
  }

  /* Arrow keys behave like a native radio group: they select as they move.
   * Crossed-out choices are skipped, because they cannot be chosen. */
  function moveChoice(from, step) {
    var count = C.choicesFor(session.questions[session.index]).length;
    for (var i = 1; i <= count; i++) {
      var next = ((from + step * i) % count + count) % count;
      if (session.excluded[next]) continue;
      selectChoice(next);
      focusChoice(next);
      return;
    }
  }

  function edgeChoice(fromEnd) {
    var count = C.choicesFor(session.questions[session.index]).length;
    for (var i = 0; i < count; i++) {
      var index = fromEnd ? count - 1 - i : i;
      if (session.excluded[index]) continue;
      selectChoice(index);
      focusChoice(index);
      return;
    }
  }

  /* The choice a key names: A–Z, or 1–9. Caps Lock still types a letter that
   * chooses; with Shift held a digit key reports its symbol (Shift+1 is "!"),
   * so digits are read from the physical key instead. */
  function choiceKeyIndex(event) {
    var key = (event.key || '').toUpperCase();
    if (key.length === 1 && key >= 'A' && key <= 'Z') return key.charCodeAt(0) - 65;
    var number = '123456789'.indexOf(key);
    if (number >= 0) return number;
    var digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code || '');
    return digit && event.shiftKey ? parseInt(digit[1], 10) - 1 : -1;
  }

  function focusQuestionOrMain() {
    var stem = document.querySelector('#qcard .stem');
    if (stem) { stem.focus({ preventScroll: true }); return; }
    var main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', function (event) {
    /* Browser and OS shortcuts such as Ctrl+A or Alt+B must never pick a
     * choice. Shift is ours: Shift with a choice key crosses that choice out. */
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (parseHash().path !== '/practice' || !session ||
        session.index >= session.questions.length) return;
    /* The help dialog is modal: its key events must not answer questions. */
    if (document.querySelector('dialog[open]')) return;
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

    if (cls.contains('choice') && !session.checked) {
      var from = parseInt(event.target.getAttribute('data-i'), 10);
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        moveChoice(from, 1);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        moveChoice(from, -1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        edgeChoice(event.key === 'End');
        return;
      }
    }

    var index = choiceKeyIndex(event);
    if (index >= 0 && index < C.choicesFor(session.questions[session.index]).length) {
      event.preventDefault();
      if (event.shiftKey) {
        toggleExcluded(index);
        return;
      }
      selectChoice(index);
      /* A letter shortcut also puts the keyboard in the group, so the arrow
       * keys and Tab continue from the chosen option. */
      if (session.selected === index) focusChoice(index);
    }
  });

  /* ------------------------------------------------------------ boot */
  async function init() {
    applyTheme();
    appEl.innerHTML = '<div class="card"><p class="muted">Loading question sets…</p></div>';
    await loadBank();
    await initProgress();
    restoreStoredSession();
    window.addEventListener('hashchange', render);
    window.addEventListener('resize', syncTableHint);
    render();
  }

  init();
})();
