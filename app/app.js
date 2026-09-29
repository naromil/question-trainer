/* SAT Hard Mode - the app: routing, rendering, storage.
 *
 * Depends on window.SATBANK (generated data) and window.SATCore (pure logic).
 * All progress lives in localStorage. An in-flight session is only in memory:
 * a reload restarts the session, but every graded answer is already saved.
 */
(function () {
  'use strict';

  var C = window.SATCore;
  var DATA = window.SATBANK;
  var appEl = document.getElementById('app');
  var navEl = document.getElementById('nav');
  var pillsEl = document.getElementById('pills');

  if (!C || !DATA) {
    appEl.innerHTML = '<div class="card"><h2>Could not load the trainer data</h2>' +
      '<p>Expected <code>data/questions.js</code> next to this page. Regenerate it with ' +
      '<code>python3 tools/build_app_data.py</code>.</p></div>';
    return;
  }

  var STATE_KEY = 'sattrainer.state.v1';
  var QUESTIONS = DATA.questions;
  var META = DATA.meta;
  var BY_ID = {};
  QUESTIONS.forEach(function (q) { BY_ID[q.id] = q; });

  var state = loadState();
  var session = null;
  var timer = null;
  var VERDICT = ['A', 'B', 'C', 'D'];

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
  function pct(n) { return Math.round(n) + '%'; }
  function fmtTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ':' + ('0' + (total % 60)).slice(-2);
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function clampInt(n, lo, hi) { return Math.min(hi, Math.max(lo, n | 0)); }

  function filters() {
    return {
      excludeFigure: state.settings.excludeFigure,
      excludeUnderline: state.settings.excludeUnderline,
      excludeRisky: state.settings.excludeRisky
    };
  }

  /* ------------------------------------------------------------ storage */
  function loadState() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(STATE_KEY)); } catch (err) { raw = null; }
    return C.sanitizeState(raw, Date.now());
  }

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (err) { /* quota/private mode */ }
  }

  function clearStoredState() {
    try { localStorage.removeItem(STATE_KEY); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------ theming */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme || 'auto');
  }

  /* ------------------------------------------------------------ stimulus */
  /* Escape first, then turn the OCR blank rules into a visible blank. */
  function inline(text) {
    return esc(text).replace(/_{4,}/g, '<span class="blank" aria-hidden="true"></span>');
  }

  /* Stimulus text keeps the OCR line breaks: single newlines are wraps inside
   * a paragraph or bullet, blank lines separate blocks. */
  function stimulusHTML(text) {
    var html = '';
    text.split(/\n{2,}/).forEach(function (block) {
      var parts = [];
      block.split('\n').forEach(function (raw) {
        var line = raw.trim();
        if (!line) return;
        if (/^[•‣▪]/.test(line)) {
          parts.push({ kind: 'li', text: line.replace(/^[•‣▪]\s*/, '') });
          return;
        }
        if (/^Text \d+$/.test(line)) {
          parts.push({ kind: 'label', text: line });
          return;
        }
        var last = parts[parts.length - 1];
        if (last && (last.kind === 'p' || last.kind === 'li')) last.text += ' ' + line;
        else parts.push({ kind: 'p', text: line });
      });
      var inList = false;
      parts.forEach(function (part) {
        if (part.kind === 'li') {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + inline(part.text) + '</li>';
          return;
        }
        if (inList) { html += '</ul>'; inList = false; }
        html += part.kind === 'label'
          ? '<p class="text-label">' + esc(part.text) + '</p>'
          : '<p>' + inline(part.text) + '</p>';
      });
      if (inList) html += '</ul>';
    });
    return html;
  }

  /* Caveat badges for source-data problems the trainer cannot fix. */
  function warningHTML(question) {
    var flags = question.flags || [];
    var notes = [];
    if (flags.indexOf('figure') >= 0) {
      notes.push('refers to a graph, table or figure — chart geometry is not in the ' +
        'text data, so read the stem carefully');
    }
    if (flags.indexOf('underline') >= 0) {
      notes.push('refers to an underlined portion that OCR did not capture');
    }
    if (flags.indexOf('low-confidence') >= 0 || flags.indexOf('ocr-disagreement') >= 0) {
      notes.push('carries OCR-quality warnings (see the Data page)');
    }
    if (!notes.length) return '';
    return '<div class="warnbox">Source-data caveat: this item ' + esc(notes.join('; ')) +
      '.</div>';
  }

  function rationaleHTML(question, chosenIndex) {
    var parsed = C.parseRationale(question.analysis, question.answer);
    var chosen = chosenIndex == null ? null : VERDICT[chosenIndex];
    var html = '<div class="rationale">';

    if (parsed.parsed) {
      html += '<div class="choice-why"><b>Why ' + parsed.best + ' is correct.</b> ' +
        esc(parsed.bestText) + '</div>';
      if (chosen && chosen !== question.answer && parsed.wrong[chosen]) {
        html += '<div class="choice-why"><b>Why ' + chosen + ' is incorrect.</b> ' +
          esc(parsed.wrong[chosen]) + '</div>';
      }
      html += '<details><summary>Full explanation</summary>';
      VERDICT.forEach(function (letter) {
        if (letter === parsed.best) return;
        if (!parsed.wrong[letter]) return;
        html += '<div class="choice-why"><b>' + letter + '.</b> ' +
          esc(parsed.wrong[letter]) + '</div>';
      });
      html += '</details>';
    } else {
      html += '<p>' + esc(question.analysis).replace(/\n{2,}/g, '</p><p>') + '</p>';
    }
    return html + '</div>';
  }

  /* Read-only rendering of a question, used in review lists. */
  function staticQuestionHTML(question) {
    var choices = question.choices.map(function (text, i) {
      var letter = VERDICT[i];
      var cls = letter === question.answer ? ' is-correct' : ' dimmed';
      return '<li class="choice' + cls + '"><span class="letter">' + letter +
        '</span><span>' + inline(text) + '</span></li>';
    }).join('');
    return '<div class="stimulus">' + stimulusHTML(question.stimulus) + '</div>' +
      '<div class="stem">' + esc(question.stem) + '</div>' +
      '<ul class="choices">' + choices + '</ul>' +
      warningHTML(question) + rationaleHTML(question, null);
  }

  /* ------------------------------------------------------------ chrome */
  function renderPills() {
    var stats = C.overallStats(state, QUESTIONS);
    pillsEl.innerHTML =
      '<span class="pill" title="Questions answered at least once">' +
        stats.seen + '/' + stats.bankSize + ' seen</span>' +
      '<span class="pill" title="First-answer accuracy across all attempts">' +
        stats.accuracy + '% right</span>' +
      (stats.streak ? '<span class="pill" title="Consecutive days with practice">' +
        plural(stats.streak, 'day') + ' streak</span>' : '') +
      (stats.due ? '<span class="pill" title="Due for spaced review">↻ ' +
        stats.due + ' due</span>' : '');
  }

  function setActiveNav(path) {
    /* The practice screen lives under /practice but belongs to "Practice". */
    var active = path === '/practice' ? '/' : path;
    $$('#nav a').forEach(function (link) {
      if (link.getAttribute('data-route') === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
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
    stopTimer();
    var route = parseHash();
    setActiveNav(route.path);
    renderPills();

    /* Leaving practice abandons the finished session so the same link starts
     * a fresh one next time. */
    if (route.path !== '/practice' && session && session.index >= session.ids.length) {
      session = null;
    }

    if (route.path === '/stats') renderStats();
    else if (route.path === '/settings') renderSettings(route);
    else if (route.path === '/about') renderAbout();
    else if (route.path === '/practice') renderPractice(route.params);
    else renderHome();
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------ home */
  function skillCard(row) {
    var tier = row.tier;
    var due = row.due
      ? '<span class="tag due">' + row.due + ' due</span>'
      : '';
    return '<article class="card skill">' +
      '<div class="spread"><h4>' + esc(row.skill) + '</h4>' +
        '<span class="tag ' + tier.key + '">' + tier.label + '</span></div>' +
      '<div class="bar tier-' + tier.key + '"><i style="width:' + row.points + '%"></i></div>' +
      '<div class="meta">' + row.points + '% mastery · ' +
        row.attempted + '/' + row.total + ' attempted · ' +
        row.accuracy + '% first try ' + due + '</div>' +
      '<div class="row">' +
        '<a class="btn btn-sm btn-primary" href="#/practice?skill=' +
          encodeURIComponent(row.skill) + '">Practice</a>' +
        '<a class="btn btn-sm" href="#/practice?skill=' + encodeURIComponent(row.skill) +
          '&mode=review">Review</a>' +
        '<a class="btn btn-ghost btn-sm" href="#/practice?skill=' +
          encodeURIComponent(row.skill) + '&mode=weak">Mixed drill</a>' +
      '</div></article>';
  }

  function renderHome() {
    var stats = C.overallStats(state, QUESTIONS);
    var rows = C.skillStats(state, QUESTIONS);
    var byDomain = [];
    rows.forEach(function (row) {
      var group = byDomain.filter(function (g) { return g.domain === row.domain; })[0];
      if (!group) { group = { domain: row.domain, rows: [] }; byDomain.push(group); }
      group.rows.push(row);
    });

    var html = '<div class="hero">' +
      '<div class="card"><h1>Hard questions only</h1>' +
      '<p class="muted">' + META.count + ' ' + esc(META.section) + ' items at the ' +
      '<b>' + esc(META.difficulty) + '</b> difficulty tier, every one with the official ' +
      'College Board rationale. Answer, get graded, read why — then let spaced review ' +
      'bring it back until it sticks.</p>' +
      '<div class="row">' +
        '<a class="btn btn-primary" href="#/practice">Mixed practice</a>' +
        '<a class="btn" href="#/practice?mode=review">' +
          (stats.due ? 'Review due (' + stats.due + ')' : 'Review') + '</a>' +
        '<a class="btn" href="#/practice?mode=weak">Weakest skills</a>' +
      '</div></div>' +
      '<div class="card"><div class="statgrid">' +
        '<div class="stat"><b>' + stats.seen + '<span class="muted">/' +
          stats.bankSize + '</span></b><span>questions seen</span></div>' +
        '<div class="stat"><b>' + stats.accuracy + '%</b><span>correct</span></div>' +
        '<div class="stat"><b>' + stats.mastered + '</b><span>skills mastered</span></div>' +
        '<div class="stat"><b>' + stats.due + '</b><span>due for review</span></div>' +
      '</div></div></div>';

    byDomain.forEach(function (group) {
      html += '<section class="domain"><h3>' + esc(group.domain) + '</h3>' +
        '<div class="skills">' + group.rows.map(skillCard).join('') + '</div></section>';
    });
    appEl.innerHTML = html;
  }

  /* ------------------------------------------------------------ practice */
  function sameCfg(a, b) {
    return a && a.skill === b.skill && a.mode === b.mode && a.length === b.length;
  }

  function createSession(cfg, preselect) {
    var questions = preselect || C.selectSession(state, QUESTIONS, {
      skill: cfg.skill,
      mode: cfg.mode,
      length: cfg.length,
      filters: filters(),
      now: Date.now()
    });
    session = {
      cfg: cfg,
      ids: questions.map(function (q) { return q.id; }),
      index: 0,
      results: [],
      selected: null,
      checked: false,
      startedAt: Date.now(),
      retry: !!preselect
    };
    if (session.ids.length) {
      state.totals.sessions += 1;
      saveState();
    }
    return session;
  }

  function modeLabel(mode) {
    if (mode === 'review') return 'Spaced review';
    if (mode === 'weak') return 'Weakest skills';
    if (mode === 'retry') return 'Retry misses';
    return 'Practice';
  }

  function sessionTitle() {
    return session.cfg.skill || 'Mixed — all 10 skills';
  }

  function renderPractice(params) {
    var cfg = {
      skill: params.get('skill') || null,
      mode: params.get('mode') || 'practice',
      length: clampInt(parseInt(params.get('n'), 10) || state.settings.length, 1, 50)
    };
    if (!session || !sameCfg(session.cfg, cfg)) createSession(cfg);

    if (!session.ids.length) {
      var nothingDue = session.cfg.mode === 'review';
      appEl.innerHTML = '<div class="card"><h2>' +
        (nothingDue ? 'Nothing is due for review' : 'Nothing to practice here') + '</h2>' +
        '<p class="muted">' + (nothingDue
          ? 'Every question you have answered is scheduled for a later date. Missed ' +
            'questions come back immediately; the rest come back within a day or two.'
          : 'No questions match this filter combination.') + '</p>' +
        '<p><a class="btn btn-primary" href="#/">Back to practice</a>' +
        (nothingDue ? '' : ' <a class="btn" href="#/settings">Change filters</a>') +
        '</p></div>';
      return;
    }
    if (session.index >= session.ids.length) { renderResults(); return; }

    appEl.innerHTML =
      '<div class="prac-head">' +
        '<a class="btn btn-ghost btn-sm" href="#/">← Exit</a>' +
        '<div><b>' + esc(sessionTitle()) + '</b> <span class="muted small">· ' +
          esc(modeLabel(session.cfg.mode)) + '</span></div>' +
        '<div class="dots" id="dots"></div>' +
        '<span class="pill" id="timer">0:00</span>' +
      '</div>' +
      '<div class="card" id="qcard"></div>';

    startTimer();
    showQuestion(session.index);
  }

  function startTimer() {
    stopTimer();
    var el = document.getElementById('timer');
    if (!el) return;
    var tick = function () {
      el.textContent = fmtTime(Date.now() - session.startedAt);
    };
    tick();
    timer = setInterval(tick, 1000);
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
    dots.innerHTML = session.ids.map(function (id, i) {
      var result = resultAt(i);
      var cls = result ? (result.correct ? 'correct' : 'wrong')
        : (i === session.index && !session.checked ? 'current' : '');
      var question = BY_ID[id];
      return '<span class="dot ' + cls + '" title="' + esc(question.skill + ' · ' +
        question.set + ' #' + question.number) + '"></span>';
    }).join('');
  }

  function choiceClass(letter, index, question) {
    var chosen = index === session.selected;
    if (!session.checked) return 'choice' + (chosen ? ' selected' : '');
    if (letter === question.answer) return 'choice is-correct';
    if (chosen) return 'choice is-wrong';
    return 'choice dimmed';
  }

  function showQuestion(index) {
    var question = BY_ID[session.ids[index]];
    session.selected = null;
    session.checked = false;
    renderDots();

    var choices = question.choices.map(function (text, i) {
      var letter = VERDICT[i];
      return '<li><button type="button" class="' + choiceClass(letter, i, question) +
        '" data-i="' + i + '"><span class="letter">' + letter + '</span>' +
        '<span>' + inline(text) + '</span></button></li>';
    }).join('');

    var card = document.getElementById('qcard');
    card.innerHTML =
      '<div class="q-meta">' +
        '<span class="tag">' + esc(question.skill) + '</span>' +
        '<span class="tag">' + esc(question.set) + ' · Q' + esc(question.number) + '</span>' +
        '<span class="tag">' + (index + 1) + ' of ' + session.ids.length + '</span>' +
      '</div>' +
      warningHTML(question) +
      '<div class="stimulus">' + stimulusHTML(question.stimulus) + '</div>' +
      '<div class="stem">' + esc(question.stem) + '</div>' +
      '<ul class="choices" id="choices">' + choices + '</ul>' +
      '<div class="actions">' +
        '<button type="button" class="btn btn-primary" id="action" disabled>' +
          'Check answer</button>' +
        '<span class="kbdhint"><kbd>A</kbd>–<kbd>D</kbd> choose · ' +
          '<kbd>Enter</kbd> check / next</span>' +
      '</div>' +
      '<div id="feedback" aria-live="polite"></div>';

    $$('#choices .choice').forEach(function (button) {
      button.addEventListener('click', function () {
        selectChoice(parseInt(button.getAttribute('data-i'), 10));
      });
    });
    document.getElementById('action').addEventListener('click', action);
  }

  function selectChoice(index) {
    if (session.checked) return;
    session.selected = index;
    var question = BY_ID[session.ids[session.index]];
    $$('#choices .choice').forEach(function (button, i) {
      button.setAttribute('aria-pressed', String(i === index));
      button.className = choiceClass(VERDICT[i], i, question);
    });
    document.getElementById('action').disabled = false;
  }

  function action() {
    if (!session.checked) checkAnswer();
    else nextQuestion();
  }

  function checkAnswer() {
    if (session.checked || session.selected == null) return;
    var question = BY_ID[session.ids[session.index]];
    var result = C.applyAnswer(state, question, session.selected, Date.now());
    session.checked = true;

    var record = {
      index: session.index,
      id: question.id,
      skill: question.skill,
      chosen: result.chosen,
      correct: result.correct,
      expected: result.expected,
      pointsDelta: result.pointsDelta,
      pointsBefore: result.pointsBefore,
      pointsAfter: result.pointsAfter,
      coin: result.coin
    };
    session.results.push(record);
    saveState();
    renderPills();

    $$('#choices .choice').forEach(function (button, i) {
      var letter = VERDICT[i];
      button.disabled = true;
      button.className = choiceClass(letter, i, question);
    });

    var last = session.index === session.ids.length - 1;
    var actionBtn = document.getElementById('action');
    actionBtn.textContent = last ? 'See results' : 'Next question';
    actionBtn.disabled = false;

    var mastery = result.pointsDelta === 0
      ? '<span class="muted">mastery unchanged (already at 0 or 100)</span>'
      : (result.pointsDelta > 0 ? '+' : '') + result.pointsDelta + ' mastery in ' +
        esc(question.skill) + ' → ' + result.pointsAfter + '%';

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
        rationaleHTML(question, session.selected) +
        '<div class="small muted" style="margin-top:.6rem">' + mastery + ' · ' + when +
        '</div>' +
      '</div>';
    renderDots();
  }

  function nextQuestion() {
    if (!session.checked) return;
    session.index += 1;
    if (session.index >= session.ids.length) renderResults();
    else showQuestion(session.index);
    window.scrollTo(0, 0);
  }

  function renderResults() {
    stopTimer();
    var results = session.results.slice().sort(function (a, b) { return a.index - b.index; });
    var correct = results.filter(function (r) { return r.correct; }).length;
    var missed = results.filter(function (r) { return !r.correct; });
    var percent = results.length ? Math.round((correct / results.length) * 100) : 0;

    var bySkill = {};
    results.forEach(function (r) {
      bySkill[r.skill] = (bySkill[r.skill] || 0) + r.pointsDelta;
    });
    var deltas = Object.keys(bySkill).map(function (skill) {
      var delta = bySkill[skill];
      return '<span class="tag ' + (delta > 0 ? 'mastered' : delta < 0 ? 'warn' : '') + '">' +
        esc(skill) + ' ' + (delta > 0 ? '+' : '') + delta + '</span>';
    }).join(' ');

    var rows = results.map(function (r, i) {
      var question = BY_ID[r.id];
      return '<div class="result-row">' +
        '<span class="n">' + (i + 1) + '</span>' +
        '<span class="' + (r.correct ? 'ok' : 'no') + '">' + (r.correct ? '✓' : '✗') + '</span>' +
        '<span class="grow">' + esc(question.skill) + ' — ' + esc(question.stem.slice(0, 70)) +
          (question.stem.length > 70 ? '…' : '') + '</span>' +
        '<span class="muted small">' + r.chosen +
          (r.correct ? '' : ' → ' + r.expected) + '</span>' +
      '</div>';
    }).join('');

    var review = missed.map(function (r) {
      var question = BY_ID[r.id];
      return '<div class="review-item"><div class="q-meta"><span class="tag">' +
        esc(question.skill) + '</span><span class="tag">' + esc(question.set) + ' · Q' +
        esc(question.number) + '</span><span class="tag warn">you chose ' + r.chosen +
        '</span></div>' + staticQuestionHTML(question) + '</div>';
    }).join('');

    var time = fmtTime(Date.now() - session.startedAt);

    appEl.innerHTML =
      '<div class="card"><div class="spread"><h1>Session complete</h1>' +
        '<span class="muted">' + esc(sessionTitle()) + ' · ' + esc(modeLabel(session.cfg.mode)) +
        ' · ' + time + '</span></div>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + correct + '/' + results.length + '</b><span>correct</span></div>' +
        '<div class="stat"><b>' + percent + '%</b><span>this session</span></div>' +
        '<div class="stat"><b>' + missed.length + '</b><span>coming back in review</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:.9rem">' +
        (missed.length ? '<button class="btn btn-primary" id="retry">Retry the ' +
          plural(missed.length, 'missed question') + '</button>' : '') +
        '<a class="btn" href="#/practice?skill=' + encodeURIComponent(session.cfg.skill || '') +
          '&mode=' + esc(session.cfg.mode) + '">Practice again</a>' +
        '<a class="btn btn-ghost" href="#/">Back to skills</a>' +
      '</div>' +
      (deltas ? '<div class="row" style="margin-top:.7rem">' +
        '<span class="muted small">Mastery:</span>' + deltas + '</div>' : '') +
      '</div>' +
      '<div class="card"><h3>Question by question</h3>' + rows + '</div>' +
      (review ? '<div class="card"><h3>Review your misses</h3>' + review + '</div>' : '');

    var retry = document.getElementById('retry');
    if (retry) {
      retry.addEventListener('click', function () {
        var questions = missed.map(function (r) { return BY_ID[r.id]; });
        var skill = session.cfg.skill;
        createSession({ skill: skill, mode: 'retry', length: questions.length }, questions);
        location.hash = '#/practice?skill=' + encodeURIComponent(skill || '') +
          '&mode=retry&n=' + questions.length;
        render();
      });
    }
  }

  /* ------------------------------------------------------------ stats */
  function renderStats() {
    var stats = C.overallStats(state, QUESTIONS);
    var rows = C.skillStats(state, QUESTIONS);
    var days = C.activity(state, 14);
    var peak = days.reduce(function (n, day) { return Math.max(n, day.a); }, 0);
    var trouble = C.troubleSpots(state, QUESTIONS, 8);

    var activity = '<div class="spark">' + days.map(function (day) {
      var h = peak ? Math.round((day.a / peak) * 100) : 0;
      return '<div class="' + (day.a ? 'has' : '') + '" style="height:' + Math.max(h, 6) +
        '%" title="' + day.date + ': ' + plural(day.a, 'question') + ', ' + day.c +
        ' right"></div>';
    }).join('') + '</div>' +
    '<div class="spark-legend"><span>' + days[0].date + '</span>' +
      '<span>' + stats.answered + ' answers total</span>' +
      '<span>today</span></div>';

    var table = rows.map(function (row) {
      return '<tr><td>' + esc(row.skill) + '</td>' +
        '<td><div class="bar tier-' + row.tier.key + '"><i style="width:' + row.points +
          '%"></i></div></td>' +
        '<td class="num">' + row.points + '%</td>' +
        '<td><span class="tag ' + row.tier.key + '">' + row.tier.label + '</span></td>' +
        '<td class="num">' + row.attempted + '/' + row.total + '</td>' +
        '<td class="num">' + (row.attempted ? row.accuracy + '%' : '—') + '</td>' +
        '<td class="num">' + (row.due || '—') + '</td></tr>';
    }).join('');

    var troubleHTML = trouble.length ? trouble.map(function (row) {
      return '<details class="review-item"><summary>' + esc(row.q.skill) + ' · Q' +
        esc(row.q.number) + ' — missed ' + row.wrong + ' of ' + row.attempts +
        ' attempts</summary><div style="margin-top:.7rem">' +
        staticQuestionHTML(row.q) + '</div></details>';
    }).join('') : '<p class="muted small">No repeated misses yet.</p>';

    appEl.innerHTML =
      '<div class="card"><h1>Your progress</h1>' +
      '<div class="statgrid">' +
        '<div class="stat"><b>' + stats.answered + '</b><span>answers given</span></div>' +
        '<div class="stat"><b>' + stats.accuracy + '%</b><span>first-try correct</span></div>' +
        '<div class="stat"><b>' + stats.seen + '/' + stats.bankSize +
          '</b><span>questions seen</span></div>' +
        '<div class="stat"><b>' + stats.mastered + '</b><span>skills mastered</span></div>' +
        '<div class="stat"><b>' + stats.streak + '</b><span>day streak</span></div>' +
        '<div class="stat"><b>' + stats.due + '</b><span>due now</span></div>' +
      '</div></div>' +
      '<div class="card"><h3>Last 14 days</h3>' + activity + '</div>' +
      '<div class="card"><h3>Skills</h3><table><thead><tr><th>Skill</th><th></th>' +
        '<th class="num">Mastery</th><th>Tier</th><th class="num">Seen</th>' +
        '<th class="num">First try</th><th class="num">Due</th></tr></thead><tbody>' +
        table + '</tbody></table></div>' +
      '<div class="card"><h3>Trouble spots</h3>' + troubleHTML + '</div>';
  }

  /* ------------------------------------------------------------ settings */
  function filterCount(predicate) {
    return QUESTIONS.filter(predicate).length;
  }

  function renderSettings(route) {
    var risky = filterCount(function (q) { return C.isExcluded(q, { excludeRisky: true }); });
    var figures = filterCount(function (q) { return C.isExcluded(q, { excludeFigure: true }); });
    var underlines = filterCount(function (q) { return C.isExcluded(q, { excludeUnderline: true }); });

    appEl.innerHTML =
      '<div class="card"><h1>Settings</h1>' +
      '<h4>Session</h4>' +
      '<label class="field">Questions per session <select id="length">' +
        [4, 8, 12, 20].map(function (n) {
          return '<option value="' + n + '"' + (state.settings.length === n ? ' selected' : '') +
            '>' + n + '</option>';
        }).join('') + '</select></label>' +
      '<label class="field">Theme <select id="theme">' +
        ['auto', 'light', 'dark'].map(function (theme) {
          return '<option value="' + theme + '"' +
            (state.settings.theme === theme ? ' selected' : '') + '>' + theme + '</option>';
        }).join('') + '</select></label>' +
      '<h4 style="margin-top:1.1rem">Question filters</h4>' +
      '<p class="muted small">Items are excluded from every session (practice, review and ' +
        'drills) when a filter is on.</p>' +
      '<label class="field"><input type="checkbox" id="f-figure"' +
        (state.settings.excludeFigure ? ' checked' : '') + '> Skip items that refer to a ' +
        'graph, table or figure <span class="muted small">(' + figures + ')</span></label>' +
      '<label class="field"><input type="checkbox" id="f-underline"' +
        (state.settings.excludeUnderline ? ' checked' : '') + '> Skip items that refer to an ' +
        'underlined portion <span class="muted small">(' + underlines + ')</span></label>' +
      '<label class="field"><input type="checkbox" id="f-risky"' +
        (state.settings.excludeRisky ? ' checked' : '') + '> Skip items with OCR warnings ' +
        '<span class="muted small">(' + risky + ')</span></label>' +
      '</div>' +
      '<div class="card"><h3>Progress data</h3>' +
      '<p class="muted small">Everything is stored in this browser only. Back it up as JSON ' +
        'if you switch machines or clear site data.</p>' +
      '<div class="row"><button class="btn" id="export">Export JSON</button>' +
        '<button class="btn" id="import-btn">Import JSON</button>' +
        '<button class="btn" id="reset">Reset progress</button>' +
        '<input type="file" id="import-file" accept="application/json" hidden></div>' +
      '<p class="small muted" id="note" style="margin-top:.7rem"></p>' +
      '</div>' +
      '<div class="card"><h3>Question bank</h3>' +
      '<p class="small muted">' + META.count + ' hard ' + esc(META.section) + ' items · ' +
        'source <code>' + esc(META.source) + '</code> · generated ' +
        esc(META.generated) + ' · ' + META.answers_recovered_from_rationale +
        ' answers recovered from rationales. See <a href="#/about">Data</a>.</p></div>';

    var note = document.getElementById('note');
    $('#length').addEventListener('change', function (event) {
      state.settings.length = parseInt(event.target.value, 10);
      saveState();
    });
    $('#theme').addEventListener('change', function (event) {
      state.settings.theme = event.target.value;
      applyTheme();
      saveState();
    });
    [['f-figure', 'excludeFigure'], ['f-underline', 'excludeUnderline'],
      ['f-risky', 'excludeRisky']].forEach(function (pair) {
      $('#' + pair[0]).addEventListener('change', function (event) {
        state.settings[pair[1]] = event.target.checked;
        saveState();
        renderSettings(route);
      });
    });
    $('#export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'sat-hard-mode-progress.json';
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
        if (!parsed || typeof parsed !== 'object') {
          note.textContent = 'That file is not valid JSON.';
          return;
        }
        state = C.sanitizeState(parsed, Date.now());
        saveState();
        renderPills();
        note.textContent = 'Imported: ' + state.totals.a + ' answers, ' +
          state.totals.sessions + ' sessions.';
      });
    });
    $('#reset').addEventListener('click', function () {
      if (!window.confirm('Delete all practice history in this browser?')) return;
      clearStoredState();
      state = C.emptyState(Date.now());
      session = null;
      applyTheme();
      renderPills();
      renderSettings(route);
    });
  }

  /* ------------------------------------------------------------ about */
  function renderAbout() {
    var flagCounts = {};
    QUESTIONS.forEach(function (q) {
      (q.flags || []).forEach(function (flag) {
        flagCounts[flag] = (flagCounts[flag] || 0) + 1;
      });
    });
    var flags = Object.keys(flagCounts).sort(function (a, b) {
      return flagCounts[b] - flagCounts[a];
    }).map(function (flag) {
      return '<span class="tag">' + esc(flag) + ' · ' + flagCounts[flag] + '</span>';
    }).join(' ');

    var skills = META.skills.map(function (entry) {
      return '<tr><td>' + esc(entry.domain) + '</td><td>' + esc(entry.skill) + '</td>' +
        '<td class="num">' + entry.count + '</td><td class="muted small">' +
        esc(entry.sets.join(', ')) + '</td></tr>';
    }).join('');

    appEl.innerHTML =
      '<div class="card"><h1>Where this data comes from</h1>' +
      '<p>Every question here is one of the <b>' + META.count + ' ' +
        esc(META.section) + ' items at the ' + esc(META.difficulty) +
        ' difficulty tier</b> of the question bank export in ' +
        '<code>' + esc(META.source) + '</code>.</p>' +
      '<ul><li><b>Question text, choices:</b> OCR (tesseract) of the original ' +
        'screenshot-per-row sheets, so the wording can carry OCR slips — each item keeps ' +
        'its OCR warning flags below.</li>' +
      '<li><b>Answer letter:</b> the official key PDFs for 224 of the items. The remaining ' +
        '29 (the whole <i>Inferences 3</i> set, whose key PDF is byte-identical to the ' +
        'question PDF) are recovered from the bank rationale, which always opens with ' +
        '"Choice X is the best answer" — that recovery agrees with the key on all 224 ' +
        'keyed items, so it is a checked derivation, not a guess.</li>' +
      '<li><b>Difficulty and rationale:</b> the College Board Educator Question Bank API ' +
        '(<code>qbank-api.collegeboard.org</code>), joined on the 8-hex question id. The ' +
        'rationales are official.</li>' +
      '<li><b>Figures:</b> bar and line chart geometry does not survive OCR. Items that ' +
        'mention a figure carry a caveat badge; filter them out in Settings if the stem ' +
        'is unanswerable without the chart.</li>' +
      '<li><b>Underlining and italics</b> are not captured at all, which matters for the ' +
        'handful of items that ask about an underlined portion.</li></ul>' +
      '<h4>Source-quality flags on these ' + META.count + ' items</h4>' +
      '<p>' + flags + '</p></div>' +
      '<div class="card"><h3>How mastery and review work</h3>' +
      '<p>Mastery is a 0–100 point total per skill, the same shape Khan Academy uses. A ' +
        'question answered correctly for the first time is worth <b>+' +
        C.MASTERY.firstCorrect + '</b>; the same question answered right again is worth ' +
        '<b>+' + C.MASTERY.repeatCorrect + '</b>; a miss costs <b>' +
        C.MASTERY.wrong + '</b>. Tiers: ' +
        C.MASTERY.tiers.map(function (tier) {
          return '<b>' + tier.label + '</b> ≥ ' + tier.min;
        }).reverse().join(', ') + '.</p>' +
      '<p>Review is a Leitner box system: each correct answer moves the question up a box, ' +
        'while a miss sends it back to box 0 and makes it due immediately. Box gaps: ' +
        C.SRS_INTERVALS_DAYS.slice(1).join(', ') + ' days. The ' +
        '<b>Review due</b> button serves only the questions that are due.</p>' +
      '<p><b>Practice</b> walks the skill least-seen-first; <b>Mixed drill</b> starts with ' +
        'your weakest skill. Filters in Settings apply to all three.</p></div>' +
      '<div class="card"><h3>Contents</h3><table><thead><tr><th>Domain</th><th>Skill</th>' +
        '<th class="num">Hard items</th><th>Sets</th></tr></thead><tbody>' + skills +
      '</tbody></table>' +
      '<p class="small muted" style="margin-top:.8rem">Regenerate this data with ' +
        '<code>python3 tools/build_app_data.py</code>; the extraction pipeline lives in ' +
        '<code>SAT Question Bank JSON/tools/</code>.</p></div>';
  }

  /* ------------------------------------------------------------ keyboard */
  document.addEventListener('keydown', function (event) {
    if (parseHash().path !== '/practice' || !session || session.index >= session.ids.length) return;
    var tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (event.key === 'Enter' || event.key === ' ') {
      if (session.checked || session.selected != null) {
        event.preventDefault();
        action();
      }
      return;
    }
    var key = event.key.toUpperCase();
    var byLetter = VERDICT.indexOf(key);
    var byNumber = '1234'.indexOf(key);
    var index = byLetter >= 0 ? byLetter : byNumber;
    if (index >= 0) {
      event.preventDefault();
      selectChoice(index);
    }
  });

  window.addEventListener('hashchange', render);
  applyTheme();
  render();
})();
