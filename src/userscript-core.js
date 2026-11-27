// ---- Patio Solver (userscript): socket hook + phone-friendly panel ----
// ENGINE (your solver) and PatioTracker are defined above this point.

function slim(r) {
  var sc = function (s) {
    return s && {
      kind: s.kind, label: s.label, sizeLabel: s.sizeLabel || '', amount: s.amount,
      ev: s.ev, se: s.se, foldPct: s.foldPct || 0, reraisedPct: s.reraisedPct || 0,
      equityWhenCalled: s.equityWhenCalled, freq: s.freq
    };
  };
  return {
    street: r.street, pot: r.pot, toCall: r.toCall, stack: isFinite(r.stack) ? r.stack : null,
    bigBlind: r.bigBlind, inPosition: r.inPosition, lookahead: !!r.lookahead,
    best: sc(r.best), runnerUp: sc(r.runnerUp), ranked: r.ranked.map(sc),
    margin: isFinite(r.margin) ? r.margin : null, close: r.close, mix: r.mix, solver: r.solver, allinTie: r.allinTie || null,
    equity: r.equity, potOdds: r.potOdds, hero: r.hero, impliedOddsNeeded: r.impliedOddsNeeded,
    opponents: r.opponents.map(function (o) {
      return {
        name: o.name, pending: o.pending, aggressor: o.aggressor,
        type: { key: o.type.key, label: o.type.label, tip: o.type.tip },
        stats: {
          hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, af: o.stats.af, foldToBet: o.stats.foldToBet, confidence: o.stats.confidence,
          // The per-player reads the hand log keeps (tracker noteAdvice), as the extension's slim passes them (v1.8.45).
          exploitWeight: o.stats.exploitWeight, accuracy: o.stats.accuracy, strengthBias: o.stats.strengthBias, callBig: o.stats.callBig,
          tiltAgg: o.stats.tiltAgg, tiltPas: o.stats.tiltPas, tiltHero: o.stats.tiltHero, mwBet: o.stats.mwBet,
          tiltCheckBet: o.stats.tiltCheckBet ? { tilt: o.stats.tiltCheckBet.tilt, n: o.stats.tiltCheckBet.n } : undefined,
          predAccuracy: o.stats.predAccuracy || undefined, rangeNoise: o.stats.rangeNoise, certainty: o.stats.certainty,
          heroPotOwn: o.stats.heroPotOwn ? { tilt: o.stats.heroPotOwn.tilt, n: o.stats.heroPotOwn.n } : undefined,
          tiltRaise: o.stats.tiltRaise ? { tilt: o.stats.tiltRaise.tilt, n: o.stats.tiltRaise.n } : undefined,
          chipTilt: o.stats.chipTilt ? { tilt: o.stats.chipTilt.tilt, slope: o.stats.chipTilt.slope, n: o.stats.chipTilt.n } : undefined,
          vsRaiseRead: o.stats.vsRaiseRead ? { odds: o.stats.vsRaiseRead.odds, nCold: o.stats.vsRaiseRead.nCold, mult: o.stats.vsRaiseRead.mult, nBet: o.stats.vsRaiseRead.nBet } : undefined,
          betRecent: o.stats.betRecent ? { odds: o.stats.betRecent.odds, n: o.stats.betRecent.n, on: !!o.stats.betRecent.on } : undefined,
          pfRecent: o.stats.pfRecent ? { raise: o.stats.pfRecent.raise, fold: o.stats.pfRecent.fold, n: o.stats.pfRecent.n, on: !!o.stats.pfRecent.on } : undefined
        },
        topClasses: o.grid.topClasses.slice(0, 8).map(function (c) { return c.name; }),
        heroVs: o.heroVs, foldToBest: o.foldToBest, summary: o.summary || '', bluffChance: o.bluffChance
      };
    })
  };
}

(function () {
  'use strict';
  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__patioSolverUS) return;
  W.__patioSolverUS = true;

  var VERSION = typeof PATIO_VERSION !== 'undefined' ? PATIO_VERSION : '';

  // ---------- storage ----------
  // The reads and the hand log live in the site's IndexedDB (database "patio-solver-phone"): one record for the reads
  // and one per hand, kept by PatioHandLog (extension/handlog.js) as the computer keeps them in chrome.storage: the
  // newest 1,000 hands, each with its raw events. Until v1.8.50 everything sat under one localStorage key, which the
  // game shares and Safari caps at about 5 MB, so the phone kept raw events for only 60 hands and a copy of the
  // computer's reads would not have fitted. Reads saved there move over on the first start (and the key is freed for
  // the game). Without IndexedDB the old localStorage way is used (legacy).
  var DB_KEY = 'patioSolverDb', UI_KEY = 'patioSolverUi', MARK_KEY = 'patioSolverLogMark', IDB_NAME = 'patio-solver-phone';
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  var saveError = null, legacy = false, handLog = null, area = null;
  function noteSaved(r) {
    var err = r && !r.ok && !r.skipped ? r.error || 'unknown error' : null;
    if (err !== saveError) { saveError = err; if (tracker && body) render(); }
    return r;
  }
  // localStorage, for the panel's settings and (legacy) the reads. If it fills up, raw hand events are dropped
  // (oldest first) before the reads are ever lost.
  function saveLocal(k, v) {
    var err = null;
    for (var tries = 0; tries < 6; tries++) {
      try { localStorage.setItem(k, JSON.stringify(v)); err = null; break; } catch (e) {
        err = (e && (e.name || e.message)) || String(e);
        var hist = v && v.history;
        if (!hist) break;
        var withRaw = hist.filter(function (x) { return x.raw; });
        if (!withRaw.length) break;
        withRaw.slice(0, Math.ceil(withRaw.length / 2)).forEach(function (x) { delete x.raw; });
      }
    }
    if (k === DB_KEY) noteSaved(err ? { ok: false, error: err + '. The page\'s storage may be full; export the hand log' } : { ok: true });
  }
  function saveUi() { saveLocal(UI_KEY, ui); }
  // IndexedDB as the storage area PatioHandLog takes: get(keys | null) -> items (null if reading failed),
  // set(items) / remove(keys) -> { ok, error }, keys() -> every key (null if reading failed).
  function idbArea(name, storeName) {
    var dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise(function (res) {
          try {
            var req = W.indexedDB.open(name, 1);
            req.onupgradeneeded = function () { try { req.result.createObjectStore(storeName); } catch (e) { /* exists */ } };
            req.onsuccess = function () { res(req.result); };
            req.onerror = function () { res(null); };
            req.onblocked = function () { res(null); };
          } catch (e) { res(null); }
        });
      }
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res) {
          if (!db) { res({ failed: true, error: 'the site storage could not be opened' }); return; }
          try {
            var t = db.transaction(storeName, mode), out = fn(t.objectStore(storeName));
            t.oncomplete = function () { res({ value: typeof out === 'function' ? out() : out }); };
            t.onerror = function () { res({ failed: true, error: (t.error && t.error.message) || 'site storage error' }); };
            t.onabort = function () { res({ failed: true, error: (t.error && (t.error.name === 'QuotaExceededError' ? 'the phone is out of storage for this site' : t.error.message)) || 'site storage write aborted' }); };
          } catch (e) { res({ failed: true, error: (e && e.message) || String(e) }); }
        });
      });
    }
    var done = function (r) { return r.failed ? { ok: false, error: r.error } : { ok: true }; };
    return {
      ok: function () { return open().then(function (db) { return !!db; }); },
      get: function (keys) {
        return tx('readonly', function (s) {
          var out = {};
          if (keys == null) {
            var kr = s.getAllKeys(), vr = s.getAll();
            return function () { var ks = kr.result || [], vs = vr.result || []; for (var i = 0; i < ks.length; i++) out[ks[i]] = vs[i]; return out; };
          }
          [].concat(keys).forEach(function (k) { var r = s.get(k); r.onsuccess = function () { if (r.result !== undefined) out[k] = r.result; }; });
          return function () { return out; };
        }).then(function (r) { return r.failed ? null : r.value; });
      },
      set: function (items) { return tx('readwrite', function (s) { Object.keys(items).forEach(function (k) { s.put(items[k], k); }); }).then(done); },
      remove: function (keys) { return tx('readwrite', function (s) { [].concat(keys).forEach(function (k) { s.delete(k); }); }).then(done); },
      keys: function () {
        return tx('readonly', function (s) { var r = s.getAllKeys(); return function () { return (r.result || []).map(String); }; })
          .then(function (r) { return r.failed ? null : r.value; });
      }
    };
  }
  function storeGet(k) { return area ? area.get([k]).then(function (v) { return (v || {})[k]; }) : Promise.resolve(load(k)); }
  function storeSet(k, v) { if (!area) { saveLocal(k, v); return Promise.resolve({ ok: true }); } var o = {}; o[k] = v; return area.set(o).then(noteSaved); }
  // Saves come several times a hand; the reads (a few MB once the computer's are copied in) are written at most every
  // 1.5 s, and at once when the page is hidden or closed.
  var saveTimer = null, saving = null;
  function saveDb(now) {
    if (!tracker) return Promise.resolve(null);
    if (legacy) { saveLocal(DB_KEY, tracker.db); return Promise.resolve({ ok: !saveError }); }
    if (!now) { if (!saveTimer) saveTimer = setTimeout(function () { saveTimer = null; saveDb(true); }, 1500); return Promise.resolve({ ok: true, queued: true }); }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var p = (saving || Promise.resolve()).then(function () { return handLog.save(tracker.db); }).then(noteSaved, function (e) { return noteSaved({ ok: false, error: String(e && e.message || e) }); });
    saving = p;
    return p;
  }
  function flush() { if (saveTimer) saveDb(true); }
  W.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  // Hands logged since the last "Hand log" export (the export mark). From LOG_REMIND on (50 with page storage, which
  // keeps raw events for 60 hands) the panel asks for an export. The page holds the newest 150, so that is the most
  // this counts.
  var LOG_REMIND = 120;
  function unexported() {
    var list = (tracker && tracker.db.history) || [], since = logMark != null ? logMark : 0, c = 0;
    for (var i = list.length - 1; i >= 0 && (list[i].t || 0) > since; i--) c++;
    return c;
  }

  // ---------- solver: the computer's full solve, on the phone's cores ----------
  // As the computer's offscreen pool (extension/offscreen.js), with what a phone has: WORKERS Web Workers (iOS Safari
  // reports 2 cores, so 2; up to 3 elsewhere), each running a share of the Monte Carlo (`partial`), and on turns the
  // first TURN_SOLVERS of them the turn solve; then one final pass on the first worker adds the shares up, takes the
  // turn solve and runs the preflop and river solvers. Budgets are the computer's (POWER x the old phone budget: 24x
  // Monte Carlo, 8x plan samples, 16x river and 4x preflop iterations), with time limits for a slower machine: the
  // Monte Carlo stops at mcMs (never below the old phone budget), the turn solve gets turnMs (the computer's is 1-1.5 s
  // on each of its workers; 100 iterations pick the 1,600-iteration action 97% of the time), and the preflop solve
  // PREFLOP_MS for the computer's 1,200 iterations. Marwin (27 Nov): up to about 10 s a decision is fine.
  // One turn solve, not one per worker: a turn solve takes about 250-300 MB, and the page with its workers shares
  // Safari's limit of about 1.5 GB (over it, iOS reloads the page). Logged turn spots, one 5 s solve (median 480
  // iterations in the cloud sandbox) against the computer's 8 x 1.5 s: 30 of 30 picks the same; two solves 68 of 70.
  var POWER = { mc: 24, plan: 8, river: 16, preflop: 4 };
  var WORKERS = Math.max(2, Math.min(3, ((W.navigator && W.navigator.hardwareConcurrency) || 2) - 1));
  var MC_MS = 7000, PREFLOP_MS = 3000, TURN_SOLVERS = 1;
  function turnMs(input) { return input.timeLeftMs > 0 ? Math.max(2000, Math.min(5000, 0.25 * input.timeLeftMs)) : 5000; }
  function mcMs(input) { return input.timeLeftMs > 0 ? Math.max(2500, Math.min(MC_MS, 0.35 * input.timeLeftMs)) : MC_MS; }
  // A job unanswered for 30 s counts as a hung worker (its decision is long over): the worker is replaced.
  var JOB_LIMIT_MS = 30000;
  var SUPERSEDED = { ok: false, superseded: true, error: 'A newer decision replaced this one.' };
  // The worker's side: a Monte Carlo share stops at its time limit once it has its floor; the final pass is analyzeSync.
  function workerMain() {
    self.onmessage = function (e) {
      var d = e.data, t0 = Date.now();
      try {
        if (d.mode === 'partial') {
          var a = PokerEngine.createAnalysis(d.input), stop = d.mcMs > 0 ? t0 + d.mcMs : Infinity, floor = d.floor || 0, f = 0;
          while (a.target > 0) {
            f = a.step(5000);
            if (f >= 1 || (Date.now() > stop && f * a.target >= floor)) break;
          }
          self.postMessage({ id: d.id, ok: true, partial: a.partial(), solved: a.solvedOut(), n: Math.round(Math.min(1, f || 0) * a.target), ms: Date.now() - t0, kernels: PokerEngine.kernelsActive() });
        } else {
          var r = PokerEngine.analyzeSync(d.input);
          self.postMessage({ id: d.id, ok: true, result: slim(r), ms: Date.now() - t0, kernels: PokerEngine.kernelsActive() });
        }
      } catch (err) {
        self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }
  var blobUrl = null, slots = [], nextId = 1, crashes = [];
  function startWorker(slot) {
    var w = new Worker(blobUrl);
    slot.w = w; slot.jobs = {};
    w.onmessage = function (e) {
      if (slot.w !== w) return;
      var job = slot.jobs[e.data.id];
      if (!job) return;
      delete slot.jobs[e.data.id];
      clearTimeout(job.timer);
      job.res(e.data);
    };
    w.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (slot.w !== w) return;
      // Workers that keep dying (a page that blocks them, or the phone out of memory): from the third crash in a minute
      // the solver runs on the page, at the old phone budget.
      var now = Date.now();
      crashes = crashes.filter(function (t) { return now - t < 60000; }).concat(now);
      if (crashes.length >= 3) { dropPool('The solver workers kept stopping, so the solver runs on the page (smaller budget) from now on.'); return; }
      restart(slot, { ok: false, error: 'A solver worker stopped. It has been restarted.' });
    };
  }
  // Replace a slot's worker; its unanswered jobs get `answer`.
  function restart(slot, answer) {
    try { slot.w.terminate(); } catch (e) { /* gone */ }
    var jobs = slot.jobs;
    slot.jobs = {};
    try { startWorker(slot); } catch (e) { dropPool('The solver workers could not be restarted, so the solver runs on the page (smaller budget) from now on.'); }
    Object.keys(jobs).forEach(function (k) { clearTimeout(jobs[k].timer); jobs[k].res(Object.assign({}, answer)); });
  }
  var poolNote = '';
  function dropPool(why) {
    var old = slots;
    slots = [];
    poolNote = why;
    old.forEach(function (slot) {
      try { slot.w.terminate(); } catch (e) { /* gone */ }
      Object.keys(slot.jobs || {}).forEach(function (k) { clearTimeout(slot.jobs[k].timer); slot.jobs[k].res({ ok: false, error: why }); });
    });
  }
  function run(slot, payload, owner) {
    return new Promise(function (res) {
      if (!slot.w) { res({ ok: false, error: 'No solver worker.' }); return; }
      var id = nextId++;
      var timer = setTimeout(function () { if (slot.jobs[id]) restart(slot, { ok: false, error: 'The solver took too long and was restarted.' }); }, JOB_LIMIT_MS);
      slot.jobs[id] = { res: res, timer: timer, owner: owner };
      slot.w.postMessage(Object.assign({ id: id }, payload));
    });
  }
  try {
    var src = '(' + ENGINE.toString() + ')();\n' + slim.toString() + '\n(' + workerMain.toString() + ')();';
    blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    for (var wi = 0; wi < WORKERS; wi++) { var slot = {}; startWorker(slot); slots.push(slot); }
  } catch (e) { slots = []; poolNote = 'Solver workers are blocked here, so the solver runs on the page (smaller budget).'; }

  // The decision still being solved. A new one replaces it (hero acted, or the spot changed), and so do the end of
  // hero's turn and of the hand: a solve can't be interrupted, so the workers still busy with it are replaced and
  // the next decision starts at once instead of waiting behind it.
  var running = null;
  function cancelRunning() {
    var req = running;
    if (!req) return;
    running = null;
    req.cancelled = true;
    slots.forEach(function (slot) {
      var ks = Object.keys(slot.jobs);
      if (ks.length && ks.every(function (k) { return slot.jobs[k].owner === req; })) restart(slot, SUPERSEDED);
    });
  }
  // Last resort without workers: the old phone budget on the page (the table stutters while it runs).
  function onPage(input) {
    return new Promise(function (res) {
      setTimeout(function () {
        var t0 = Date.now();
        try { res({ ok: true, result: slim(PokerEngine.analyzeSync(input)), ms: Date.now() - t0, workers: 0 }); }
        catch (err) { res({ ok: false, error: String((err && err.message) || err) }); }
      }, 30);
    });
  }
  function analyze(input) {
    cancelRunning();
    if (!slots.length) return onPage(input);
    var req = { cancelled: false }, t0 = Date.now(), pool = slots.slice(), K = pool.length;
    running = req;
    var solver = null;
    try { solver = PokerEngine.solvableSpot(Object.assign({ flopSolver: false }, input)); } catch (e) { solver = null; }
    // When a solver decides, the Monte Carlo only feeds the equity readout, so a small share does.
    var base = input.iterations || 24000, total = base * POWER.mc;
    var per = solver ? 3000 : Math.ceil(total / K), floor = solver ? 3000 : Math.ceil(base / K);
    var planSamples = 500 * POWER.plan, turn = solver === 'turn';
    var shareMs = mcMs(input), tMs = turnMs(input);
    var finish = function (r) { if (running === req) running = null; return r; };
    return Promise.all(pool.map(function (slot, i) {
      return run(slot, {
        mode: 'partial', mcMs: shareMs, floor: floor,
        input: Object.assign({}, input, {
          partial: true, iterations: per, planSamples: planSamples, riverSolver: false, preflopSolver: false,
          turnSolver: turn && i < TURN_SOLVERS, turnTimeMs: tMs, turnIterations: 20000, flopSolver: false,
          seed: ((input.seed >>> 0) + i * 2654435761) >>> 0
        })
      }, req);
    })).then(function (parts) {
      if (req.cancelled) return Object.assign({}, SUPERSEDED);
      var bad = parts.filter(function (p) { return !p || !p.ok; })[0];
      if (bad) return finish(bad);
      var solvedMerge = parts.map(function (p) { return p.solved; }).filter(Boolean);
      return run(pool[0], {
        mode: 'final',
        input: Object.assign({}, input, {
          merge: parts.map(function (p) { return p.partial; }), planSamples: planSamples, solvedMerge: solvedMerge.length ? solvedMerge : undefined,
          riverIterations: (input.riverIterations || 250) * POWER.river,
          preflopIterations: 300 * POWER.preflop, preflopTimeMs: PREFLOP_MS, power: true
        })
      }, req).then(function (fin) {
        if (req.cancelled) return Object.assign({}, SUPERSEDED);
        if (fin && fin.ok) {
          fin.ms = Date.now() - t0; fin.workers = K;
          fin.iterationsTotal = parts.reduce(function (s, p) { return s + (p.n || 0); }, 0);
          fin.kernels = !!fin.kernels && parts.every(function (p) { return p.kernels; });
        }
        return finish(fin);
      });
    });
  }

  // ---------- state ----------
  var narrow = Math.min(W.innerWidth, W.screen ? W.screen.width : 9999) < 640;
  var ui = Object.assign({ tableStyle: 'typical', x: null, y: null, expanded: !narrow, showOptions: !narrow }, load(UI_KEY) || {});
  ui.showLog = false; ui.showReads = false;
  var tracker = null;
  var linkNote = '', readsNote = '', logNote = '', busy = '';
  var pendingReads = null; // a reads file picked in Import, waiting for "Replace reads"
  var ready = null; // a file made by Hand log or Export reads, waiting for a tap on Save (iOS wants a tap for a download)
  var logView = null; // { times, mark } while the Hand log list is open
  var status = 'Connecting to the table…';
  var advice = null, thinking = false, thinkStart = 0, blocked = false, reqId = 0;
  // Socket watchdog (see the hook below): 'nosocket' | 'silent' | null.
  var hookProblem = null;
  var HOOK_MSG = {
    nosocket: 'Can’t find the game’s connection, so there is no advice. Poker Patio may have changed: Patio Solver needs an update.',
    silent: 'The table is moving but no game events arrive, so there is no advice. Poker Patio may have changed: Patio Solver needs an update.'
  };
  // ---------- formatting ----------
  function money(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var SUITSYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
  function cardHtml(c) { return '<span class="cd' + (c[1] === 'h' || c[1] === 'd' ? ' red' : '') + '">' + (c[0] === 'T' ? '10' : c[0]) + SUITSYM[c[1]] + '</span>'; }
  // Raises read the way the site's raise box takes them: the chips on top of the call ("raise by"),
  // with the street total after it. On Poker Patio, raise 3 facing a bet of 2 makes the bet 5.
  function actionParts(sc, heroStageBet, toCall) {
    if (!sc) return { main: '' };
    if (sc.kind === 'fold') return { main: 'Fold' };
    if (sc.kind === 'check') return { main: 'Check' };
    if (sc.kind === 'call') return { main: 'Call ' + money(sc.amount) };
    if (sc.kind === 'allin') return { main: sc.amount <= toCall + 1e-9 ? 'Call all-in ' + money(sc.amount) : 'All-in ' + money(heroStageBet + sc.amount) };
    if (sc.kind === 'bet' && heroStageBet <= 0) return { main: 'Bet ' + money(sc.amount) };
    var to = Math.round(heroStageBet + sc.amount);
    return { main: 'Raise by ' + money(to - Math.round(heroStageBet + toCall)), to: money(to) };
  }
  function actionText(sc, heroStageBet, toCall) {
    var a = actionParts(sc, heroStageBet, toCall);
    return a.to ? a.main + ' (to ' + a.to + ')' : a.main;
  }
  function actionHtml(sc, heroStageBet, toCall) {
    var a = actionParts(sc, heroStageBet, toCall);
    return esc(a.main) + (a.to ? ' <span class="to">to ' + esc(a.to) + '</span>' : '');
  }
  function tone(sc) { return !sc ? '' : sc.kind === 'fold' ? 'fold' : (sc.kind === 'check' || sc.kind === 'call') ? 'passive' : 'aggr'; }
  function sizeNote(s) {
    var size = s.sizeLabel && s.sizeLabel !== 'raise' ? s.sizeLabel : '';
    return s.freq != null ? (size ? size + ' · ' : '') + 'play ' + pct(s.freq) : size;
  }

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.id = 'patio-solver-host';
  host.style.cssText = 'position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.panel{position:fixed;width:min(340px,calc(100vw - 16px));background:rgba(16,20,18,.95);color:#eef2ef;border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%;overflow:hidden}' +
    '.bar{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:move}' +
    '.dot{width:9px;height:9px;border-radius:50%;background:#777;flex:none}.dot.live{background:#3fcf6e}.dot.turn{background:#ffcc33;box-shadow:0 0 8px #ffcc33}.dot.bad{background:#ff6b6b}' +
    '.main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden}' +
    '.act{font-weight:700;font-size:17px;overflow:hidden;text-overflow:ellipsis}.act.aggr{color:#4be08a}.act.passive{color:#6cb8ff}.act.fold{color:#ff7a7a}.act.idle{font-weight:500;font-size:13.5px;color:#c4ccc6}' +
    '.ev{font-size:12px;color:#aab3ad;flex:none}' +
    '.chev{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:inherit;font-size:15px}' +
    '.stale .act{opacity:.45}' +
    '.act .to{font-weight:500;font-size:12px;color:#95a09a}' +
    '.badge{font-size:11px;padding:1px 6px;border-radius:99px;background:rgba(255,204,51,.18);color:#ffd866;flex:none}' +
    '.bd{padding:2px 12px 10px;display:flex;flex-direction:column;gap:10px;max-height:min(62vh,520px);overflow:auto;-webkit-overflow-scrolling:touch;border-top:1px solid rgba(255,255,255,.08)}' +
    '.hand{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:8px}' +
    '.cd{display:inline-block;background:#f4f4f0;color:#111;border-radius:4px;padding:0 4px;font-weight:700;font-size:13px}.cd.red{color:#c81e1e}' +
    '.muted{color:#95a09a;font-size:12px}.status{color:#aab3ad;font-size:13px;padding-top:8px}' +
    '.kv{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:13px}.kv span:nth-child(even){text-align:right;font-variant-numeric:tabular-nums}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}td{padding:3px 0;font-variant-numeric:tabular-nums}td:last-child{text-align:right}tr.best td{font-weight:700;color:#fff}' +
    '.neg{color:#ff9a9a}.pos{color:#8ff0b4}' +
    '.sec{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8c968f;margin-bottom:4px}' +
    '.opp{padding:6px 0;border-top:1px solid rgba(255,255,255,.06)}.opp:first-of-type{border-top:0}.nm{font-weight:600}.ty{font-size:11px;padding:1px 6px;border-radius:99px;background:rgba(255,255,255,.1);margin-left:4px}.tip{color:#aab3ad;font-size:12px;margin-top:2px}' +
    '.ft{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding-top:4px}' +
    '.ask{border-radius:10px;padding:8px 10px;background:rgba(255,204,51,.12);border:1px solid rgba(255,204,51,.35);font-size:13px}.ask .row{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}' +
    '.lk{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0;border-top:1px solid rgba(255,255,255,.06);font-size:13px}.lk select{max-width:200px}' +
    '.btn,select{background:rgba(255,255,255,.1);color:inherit;border:0;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}select option{color:#111}' +
    '.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.file{border-radius:10px;padding:8px 10px;background:rgba(108,184,255,.1);border:1px solid rgba(108,184,255,.3);font-size:13px;word-break:break-all}' +
    '.btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;text-decoration:none;cursor:pointer}.btn,select{min-height:34px}' +
    '.spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;margin-right:6px;vertical-align:-1px}@keyframes s{to{transform:rotate(360deg)}}' +
    '</style>' +
    '<div class="panel"><div class="bar"><span class="dot"></span><div class="main"></div><button class="chev" data-a="toggle">▾</button></div><div class="bd"></div>' +
    // One file input for Import, outside the part that re-renders, so a pick still arrives if the panel redraws while
    // the picker is open; the Import button is a <label> for it (no script click, which iOS can refuse).
    '<input type="file" id="ps-file" multiple tabindex="-1" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0"></div>';
  var panel = root.querySelector('.panel'), bar = root.querySelector('.bar'), mainEl = root.querySelector('.main'),
    body = root.querySelector('.bd'), dot = root.querySelector('.dot'), chev = root.querySelector('.chev'), fileIn = root.querySelector('#ps-file');

  function place() {
    var w = panel.offsetWidth || 340;
    var x = ui.x == null ? (narrow ? (W.innerWidth - w) / 2 : W.innerWidth - w - 16) : ui.x;
    var y = ui.y == null ? (narrow ? 64 : 80) : ui.y;
    x = Math.min(Math.max(4, x), W.innerWidth - Math.min(w, 120));
    y = Math.min(Math.max(4, y), W.innerHeight - 48);
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  // Drag the bar to move; a short tap on it expands/collapses.
  (function () {
    var sx, sy, ox, oy, down = false, moved = false;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      down = true; moved = false; sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    bar.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      moved = true; ui.x = ox + dx; ui.y = oy + dy; place();
    });
    bar.addEventListener('pointerup', function () {
      if (!down) return; down = false;
      if (moved) saveUi(); else { ui.expanded = !ui.expanded; saveUi(); render(); }
    });
  })();

  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]');
    if (!a) return;
    var what = a.getAttribute('data-a');
    if (what === 'toggle') { ui.expanded = !ui.expanded; saveUi(); render(); }
    else if (what === 'opts') { ui.showOptions = !ui.showOptions; saveUi(); render(); }
    else if (what === 'log') {
      ui.showLog = !ui.showLog; ui.showReads = false; logNote = ''; setReady(null);
      if (ui.showLog) refreshLog(); else render();
    }
    else if (what === 'logNew' || what === 'logAll') exportLog(what);
    else if (what === 'logSession') exportLog(what, +a.getAttribute('data-from'), +a.getAttribute('data-to'));
    else if (what === 'reads') { ui.showReads = !ui.showReads; ui.showLog = false; readsNote = ''; setReady(null); render(); }
    else if (what === 'exportReads') exportReads();
    else if (what === 'replaceReads') replaceReads();
    else if (what === 'cancelReads') { pendingReads = null; readsNote = 'Kept the reads on this phone as they were.'; render(); }
    else if (what === 'saveFile') {
      // The <a download> link does the saving; this only notes it (and moves the hand log's export mark).
      if (ready) setTimeout(fileSaved, 0);
    }
    else if (what === 'shareFile') {
      e.preventDefault();
      if (!ready) return;
      var f = ready;
      try {
        W.navigator.share({ files: [new File([f.blob], f.name, { type: 'application/json' })], title: f.name })
          .then(fileSaved, function (err) { if (err && err.name !== 'AbortError') { f.note = 'Sharing failed (' + (err.message || err.name) + '). Use Save to Files.'; render(); } });
      } catch (err) { f.note = 'Sharing isn\'t available here. Use Save to Files.'; render(); }
    }
    else if (what === 'reset') {
      if (a.getAttribute('data-c') !== '1') {
        a.setAttribute('data-c', '1'); a.textContent = 'Tap again to reset';
        setTimeout(function () { a.removeAttribute('data-c'); a.textContent = 'Reset reads'; }, 3000);
        return;
      }
      // The reads start over; the hand log stays.
      tracker.db = { players: {}, history: tracker.db.history || [] }; tracker.linkAsks = null; tracker.whoAsks = null; tracker.learnSeats(tracker.db.history);
      readsNote = 'Reads reset. The hand log stays.';
      saveDb(true); render();
    }
    else if (what === 'links') { ui.showLinks = !ui.showLinks; linkNote = ''; saveUi(); render(); }
    else if (what === 'whoNew') {
      // "Who is this?" answered "Someone new": not asked about that account again.
      var nid = a.getAttribute('data-id'), nname = tracker.namesOf(nid)[0] || 'That player';
      tracker.markNew(nid);
      linkNote = nname + ' reads as a new player. Link reads can still join them to an older read.';
      render();
    }
    else if (what === 'linkYes' || what === 'linkNo' || what === 'unlink') {
      var id = a.getAttribute('data-id'), to = a.getAttribute('data-to');
      if (what === 'linkYes') {
        var res = tracker.link(id, to);
        linkNote = res.ok ? 'Reads joined: ' + res.info.names.join(' / ') + ', ' + handsTxt(res.info.hands) + '.' : res.error;
      } else if (what === 'linkNo') {
        tracker.refuseLink(id, to);
        linkNote = 'Kept apart. You won\'t be asked about these two again.';
      } else {
        tracker.unlink(id);
        linkNote = 'Split: ' + (tracker.namesOf(id)[0] || id) + ' reads on their own again.';
      }
      afterLink();
    }
  });
  // A link changes the reads: advice on the table now was built from the old ones.
  function afterLink() {
    saveDb(true);
    if (advice && !advice.stale) requestAdvice(); else render();
  }
  root.addEventListener('change', function (e) {
    if (e.target.matches('select[data-a="linkPick"]')) {
      if (!e.target.value) return;
      var res = tracker.link(e.target.getAttribute('data-id'), e.target.value);
      linkNote = res.ok ? 'Reads joined: ' + res.info.names.join(' / ') + ', ' + handsTxt(res.info.hands) + '.' : res.error;
      afterLink();
    } else if (e.target.matches('select')) {
      ui.tableStyle = e.target.value; saveUi();
      if (advice && !advice.stale) requestAdvice(); else render();
    }
  });

  // ---------- rendering ----------
  function readsHtml(list) {
    if (!list.length) return '';
    return '<div><div class="sec">Reads</div>' + list.map(function (o) {
      return '<div class="opp"><span class="nm">' + esc(o.name) + '</span><span class="ty">' + esc(o.type) + '</span>' +
        '<div class="muted">' + Math.round(o.hands) + ' hand' + (Math.round(o.hands) === 1 ? '' : 's') + ' · VPIP ' + pct(o.vpip) + ' · PFR ' + pct(o.pfr) + ' · folds to bets ' + pct(o.ftb) + (o.likely ? ' · likely ' + esc(o.likely) : '') + '</div>' +
        (o.summary ? '<div class="muted">' + esc(o.summary) + '</div>' : '') +
        (o.linked ? '<div class="muted">' + esc(o.linked) + '</div>' : '') +
        (o.bluffChance != null ? '<div class="tip">Bluffing here about ' + pct(o.bluffChance) + ' of the time</div>' : '') +
        (o.tip ? '<div class="tip">' + esc(o.tip) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function liveReads() {
    var h = tracker.hand;
    if (!h) return [];
    var heroId = tracker.heroId(), out = [];
    Object.keys(h.players).forEach(function (k) {
      var p = h.players[k];
      if (p.id === heroId) return;
      var st = PokerEngine.computeStats(Object.assign(PatioTracker.blankTally(), tracker.readTally(p.auth) || {}), ui.tableStyle, tracker.poolTally());
      out.push({ name: p.name + (p.folded ? ' (folded)' : ''), type: PokerEngine.classifyPlayer(st).label, hands: st.hands, vpip: st.raw.vpip, pfr: st.raw.pfr, ftb: st.raw.foldToBet, summary: PokerEngine.readSummary(st), linked: linkedTxt(p.auth) });
    });
    return out;
  }

  // Linked reads (tracker.js): a friend who came back on a new account id. Same-name matches are
  // asked here and joined only on "Same player"; "Link reads" joins or splits any of them by hand.
  function day(t) { return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''; }
  function handsTxt(n) { return Math.round(n) + ' hand' + (Math.round(n) === 1 ? '' : 's'); }
  // "Link reads" also lists accounts on their own read seen in the last 3 days (newest 5) that aren't at the table.
  var RECENT_MS = 3 * 24 * 3600 * 1000, RECENT_N = 5;
  function readLabel(g) {
    var also = g.names.slice(1, 3);
    return (g.names[0] || '?') + (also.length ? ' (also ' + also.join(', ') + ')' : '') + ' · ' + handsTxt(g.hands) + (g.last ? ' · seen ' + day(g.last) : '');
  }
  function authOf(name) {
    var h = tracker.hand;
    if (!h) return null;
    var k = Object.keys(h.players).filter(function (x) { return h.players[x].name === name; })[0];
    return k ? h.players[k].auth : null;
  }
  function linkedTxt(auth) {
    var ids = auth ? tracker.groupOf(auth) : [];
    if (ids.length < 2) return '';
    var names = [];
    ids.forEach(function (k) { tracker.namesOf(k).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); }); });
    return 'Reads from ' + ids.length + ' accounts (' + names.join(', ') + ')';
  }
  function linkAsksHtml() {
    var asks = tracker.linkAsks || {}, seen = tracker.db.seen || {}, html = '';
    Object.keys(asks).forEach(function (k) {
      var a = asks[k];
      a.matches.forEach(function (m) {
        var last = Math.max.apply(null, [0].concat(m.ids.map(function (x) { return (seen[x] && seen[x].last) || 0; })));
        html += '<div class="ask"><b>' + esc(a.name) + '</b> is on an account the reads haven\'t seen. Same player as the older read ' + esc(readLabel(Object.assign({}, m, { last: last }))) + '?' +
          '<div class="row"><button class="btn" data-a="linkYes" data-id="' + esc(a.id) + '" data-to="' + esc(m.id) + '">Same player</button> ' +
          '<button class="btn" data-a="linkNo" data-id="' + esc(a.id) + '" data-to="' + esc(m.id) + '">Different players</button></div></div>';
      });
    });
    // "Who is this?": a new account with no same-name read, offered the players seen most recently who aren't at the
    // table (tracker askWho). A tap joins the reads; nothing is joined before that.
    var who = tracker.whoAsks || {};
    Object.keys(who).forEach(function (k) {
      var a = who[k];
      html += '<div class="ask"><b>' + esc(a.name) + '</b> is on a new account. Who is this?<div class="row">' +
        a.matches.map(function (m) {
          return '<button class="btn" data-a="linkYes" data-id="' + esc(a.id) + '" data-to="' + esc(m.id) + '" title="' + esc(readLabel(m)) + '">' + esc(m.names[0] || '?') + ' (' + handsTxt(m.hands) + ')</button> ';
        }).join('') +
        '<button class="btn" data-a="whoNew" data-id="' + esc(a.id) + '">Someone new</button></div></div>';
    });
    return html;
  }
  function linkOptions(auth, groups) {
    var mine = tracker.groupOf(auth), nm = (tracker.namesOf(auth)[0] || '').toLowerCase();
    function close(g) {
      var best = 0;
      g.names.forEach(function (x) {
        var n = x.toLowerCase(), k = 0;
        if (n === nm) best = Math.max(best, 3);
        while (k < n.length && k < nm.length && n[k] === nm[k]) k++;
        if (k >= 3) best = Math.max(best, 2);
      });
      return best;
    }
    return groups.filter(function (g) { return !g.ids.some(function (k) { return mine.indexOf(k) >= 0; }) && !tracker.groupsApart(mine, g.ids, true); })
      .map(function (g) { return { g: g, c: close(g) }; }).sort(function (a, b) { return b.c - a.c || b.g.last - a.g.last; }).map(function (x) { return x.g; });
  }
  function handsOfTally(r) { var t = (r && r.tally) || {}; return (t.pfFold || 0) + (t.pfCall || 0) + (t.pfRaise || 0); }
  function linksHtml() {
    var groups = tracker.readGroups(), h = tracker.hand, heroId = tracker.heroId();
    var html = '<div><div class="sec">Link reads</div>';
    var at = h ? Object.keys(h.players).map(function (k) { return h.players[k]; }).filter(function (p) { return p.id !== heroId && p.auth; }) : [];
    if (!at.length) html += '<div class="muted">Players at the table show here once a hand starts.</div>';
    function pick(id, name, label) {
      var opts = linkOptions(id, groups);
      return '<div class="lk"><span class="nm"' + (label ? ' title="' + esc(label) + '"' : '') + '>' + esc(name) + '</span>' + (opts.length
        ? '<select data-a="linkPick" data-id="' + esc(id) + '"><option value="">Same player as…</option>' + opts.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(readLabel(g)) + '</option>'; }).join('') + '</select>'
        : '<span class="muted">no other reads to join</span>') + '</div>';
    }
    at.forEach(function (p) { html += pick(p.auth, p.name); });
    // Accounts on their own read seen in the last few days but not at the table now (v1.8.43), so a friend who played
    // one session on a new account can be joined afterwards.
    var atIds = {};
    at.forEach(function (p) { tracker.groupOf(p.auth).forEach(function (k) { atIds[k] = true; }); });
    var recent = groups.filter(function (g) { return g.ids.length === 1 && !atIds[g.ids[0]] && g.last && tracker.now() - g.last < RECENT_MS; }).slice(0, RECENT_N);
    if (recent.length) {
      html += '<div class="sec" style="margin-top:6px">Recent, not at the table</div>';
      recent.forEach(function (g) { html += pick(g.id, (g.names[0] || '?') + ' (' + handsTxt(g.hands) + ', ' + day(g.last) + ')', readLabel(g)); });
    }
    var linked = groups.filter(function (g) { return g.ids.length > 1; });
    if (linked.length) {
      html += '<div class="sec" style="margin-top:6px">Joined</div>';
      linked.forEach(function (g) {
        html += '<div class="lk"><span>' + esc(readLabel(g)) + '</span>' + g.ids.map(function (k) {
          return '<button class="btn" data-a="unlink" data-id="' + esc(k) + '">Split off ' + esc(tracker.namesOf(k)[0] || k) + ' (' + handsTxt(handsOfTally(tracker.db.players[k])) + ')</button>';
        }).join(' ') + '</div>';
      });
    }
    return html + '<div class="muted">Joined reads add both accounts\' hands together; splitting gives each its own hands back. Two accounts that played the same hand can\'t be joined.</div></div>';
  }

  function render() {
    if (!tracker) { mainEl.innerHTML = '<span class="act idle">Loading reads…</span>'; body.style.display = 'none'; place(); return; }
    var fresh = advice && !advice.stale;
    var logDue = unexported() >= (legacy ? 50 : LOG_REMIND);
    var asking = tracker.linkAsks && Object.keys(tracker.linkAsks).length;
    var askingWho = !asking && tracker.whoAsks && Object.keys(tracker.whoAsks).length;
    var logBadge = !fresh && !thinking ? (asking ? '<span class="badge">same player?</span>' : askingWho ? '<span class="badge">who is this?</span>' : '') + (logDue ? '<span class="badge">export log</span>' : '') : '';
    dot.className = 'dot' + (blocked ? '' : hookProblem ? ' bad' : (fresh || thinking) ? ' turn' : tracker.snap ? ' live' : '');
    chev.textContent = ui.expanded ? '▴' : '▾';
    panel.classList.toggle('stale', !!(advice && advice.stale));

    // Bar
    if (blocked) mainEl.innerHTML = '<span class="act idle">' + (status === WAIT_MSG ? 'Waiting for the table' : 'Off at public tables') + '</span>';
    else if (thinking && !fresh) mainEl.innerHTML = '<span class="act idle"><span class="spin"></span>Thinking… <span class="secs">' + thinkSecs() + '</span></span>';
    else if (advice) {
      var b = advice.result.best;
      mainEl.innerHTML = '<span class="act ' + tone(b) + '">' + actionHtml(b, advice.ctx.heroStageBet, advice.result.toCall) + '</span>' +
        (advice.result.close && fresh ? '<span class="badge">close</span>' : '') +
        '<span class="ev' + (advice.stale && sizing.note ? ' neg' : '') + '">' + (advice.stale ? (sizing.note ? 'bet under the advice' : 'last turn') : (b.kind === 'fold' ? '' : (b.ev >= 0 ? '+' : '−') + money(Math.abs(b.ev)))) + '</span>' + logBadge;
    } else if (hookProblem) mainEl.innerHTML = '<span class="act idle">No game events: needs an update</span>';
    else mainEl.innerHTML = '<span class="act idle">' + esc(status) + '</span>' + logBadge;

    body.style.display = ui.expanded ? '' : 'none';
    if (!ui.expanded) { place(); return; }
    if (blocked) { body.innerHTML = '<div class="status">' + esc(status) + '</div>'; place(); return; }

    var h = tracker.hand, html = '';
    if (hookProblem && HOOK_MSG[hookProblem]) html += '<div class="status neg">' + esc(HOOK_MSG[hookProblem]) + '</div>';
    var heroCards = h ? h.heroUids.map(function (u) { return h.heroCards[u]; }).filter(Boolean) : [];
    if (heroCards.length || (h && h.board.length)) {
      html += '<div class="hand">' + heroCards.map(cardHtml).join('') + (h.board.length ? '<span class="muted">&nbsp;board</span>' + h.board.map(cardHtml).join('') : '') + '</div>';
    }
    if (advice) {
      var r = advice.result, c = advice.ctx, best = r.best, kv = [];
      if (advice.stale && sizing.note) html += '<div class="status neg">' + esc(sizing.note) + '</div>';
      if (r.hero) kv.push(['Your hand', esc(r.hero.made + (r.hero.draws && r.hero.draws.length ? ' + ' + r.hero.draws.map(function (d) { return d.name.toLowerCase(); }).join(', ') : '') + (r.street === 0 && r.hero.topPercent != null ? ' (top ' + Math.max(1, Math.round(r.hero.topPercent)) + '%)' : ''))]);
      if (r.mix) kv.push(['Close spot, mix it', esc(r.mix.map(function (m) { return m.label + ' ' + pct(m.freq); }).join(' · '))]);
      if (r.equity) kv.push(['Equity vs their ranges', pct(r.equity.share)]);
      if (r.toCall > 0) kv.push(['Needed to call', pct(r.potOdds)]);
      kv.push(['Pot', money(r.pot)]);
      kv.push(['Position', r.inPosition ? 'In position' : 'Out of position']);
      if (r.lookahead) kv.push(['Plans ahead', r.street === 3 ? 'Turn and river' : 'River']);
      if (r.solver) kv.push([{ preflop: 'Preflop solve', turn: 'Turn + river solve', river: 'River solve' }[r.solver.kind] || 'Solve', r.solver.field ? 'Your range vs the field' : 'Your range vs theirs']);
      if (advice.ms != null) kv.push(['Thinking', (advice.ms / 1000).toFixed(1) + ' s ' + (advice.workers ? 'on ' + advice.workers + ' workers' : 'on the page')]);
      if (best.foldPct > 0.02 && (best.kind === 'bet' || best.kind === 'raise' || best.kind === 'allin')) kv.push(['They fold to this', pct(best.foldPct)]);
      html += '<div class="kv">' + kv.map(function (p) { return '<span>' + p[0] + '</span><span>' + p[1] + '</span>'; }).join('') + '</div>';
      html += '<div><div class="sec" data-a="opts">All options ' + (ui.showOptions ? '▾' : '▸') + '</div>';
      if (ui.showOptions) {
        html += '<table>' + r.ranked.map(function (s) {
          var isBest = s.kind === best.kind && s.amount === best.amount;
          var a = actionParts(s, c.heroStageBet, r.toCall);
          var note = [a.to ? 'to ' + a.to : '', sizeNote(s)].filter(Boolean).join(' · ');
          return '<tr class="' + (isBest ? 'best' : '') + '"><td>' + esc(a.main) + (note ? ' <span class="muted">' + esc(note) + '</span>' : '') + '</td>' +
            '<td class="' + (s.ev < 0 ? 'neg' : s.ev > 0 ? 'pos' : '') + '">' + (s.ev >= 0 ? '+' : '−') + money(Math.abs(s.ev)) + '</td></tr>';
        }).join('') + '</table>';
      }
      html += '</div>';
      html += linkAsksHtml();
      html += readsHtml(r.opponents.map(function (o) {
        return { name: o.name, type: o.type.label, tip: o.type.key !== 'unknown' ? o.type.tip : '', hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, ftb: o.stats.foldToBet, likely: o.topClasses.slice(0, 5).join(' '), summary: o.summary, bluffChance: o.bluffChance, linked: linkedTxt(authOf(o.name)) };
      }));
    } else {
      if (!thinking) html += '<div class="status">' + esc(status) + '</div>';
      html += linkAsksHtml();
      html += readsHtml(liveReads());
    }
    if (linkNote) html += '<div class="status">' + esc(linkNote) + '</div>';
    if (ui.showLinks) html += linksHtml();
    var n = tracker.readGroups().length;
    html += '<div class="ft"><select>' + ['tight', 'typical', 'loose'].map(function (s) {
      return '<option value="' + s + '"' + (ui.tableStyle === s ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + ' table</option>';
    }).join('') + '</select><span style="flex:1"></span><button class="btn" data-a="links">Link reads</button> <button class="btn" data-a="log">Hand log</button> <button class="btn" data-a="reads">Reads file</button></div>';
    if (ui.showLog) html += logSectionHtml();
    if (ui.showReads) html += readsSectionHtml();
    html += '<div class="muted">Tracking ' + n + ' player' + (n === 1 ? '' : 's') + '. Reads sharpen as hands pile up.</div>';
    if (sizing.small) html += '<div class="muted">Bets this session under ' + Math.round(SMALL_SIZE * 100) + '% of the advised size: ' + sizing.small + ' of ' + sizing.n + '.</div>';
    if (logDue) html += '<div class="status neg">' + unexported() + ' hands since the last Hand log export. Tap Hand log, then New hands, to keep them' + (legacy ? ': this phone keeps the newest 150 hands, with raw events for 60.' : '.') + '</div>';
    if (saveError) html += '<div class="status neg">Couldn\'t save reads and the hand log: ' + esc(saveError) + '.</div>';
    if (poolNote) html += '<div class="status neg">' + esc(poolNote) + '</div>';
    if (VERSION) html += '<div class="muted">Patio Solver ' + esc(VERSION) + (legacy ? ' · reads in page storage' : '') + '</div>';
    body.innerHTML = html;
    // A confirm or a file that just appeared may sit below the fold of the scrolling panel: bring it into view.
    if (reveal) {
      reveal = false;
      var el = body.querySelector('.ask.pin, .file');
      if (el) { var top = el.offsetTop - body.offsetTop; body.scrollTop = Math.max(0, Math.min(top - 8, top + el.offsetHeight + 12 - body.clientHeight)); }
    }
    place();
  }
  var reveal = false;

  // Bets and raises well under the advised size (the tracker's sizeRatio), as on the computer's panel.
  var SMALL_SIZE = 0.6, sizing = { n: 0, small: 0, note: null }, sizeSeen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function checkSize() {
    var h = tracker.hand;
    if (!h || !h.advice || !sizeSeen) return;
    h.advice.forEach(function (a) {
      if (a.sizeRatio == null || sizeSeen.has(a)) return;
      sizeSeen.add(a);
      sizing.n++;
      if (a.sizeRatio < SMALL_SIZE && a.amount > 0) {
        sizing.small++;
        sizing.note = 'Smaller than advised: you put in ' + money(a.amount * a.sizeRatio) + ' of the advised ' + money(a.amount) + '.';
      } else sizing.note = null;
    });
  }

  // ---------- solver ----------
  // Only the full solve is shown, as on the computer: if you act before it is back, nothing is shown or logged for
  // that decision.
  function note(a) {
    if (!a || a.noted) return;
    a.noted = true;
    var r = a.result, c = a.ctx;
    tracker.noteAdvice(actionText(r.best, c.heroStageBet, r.toCall), r.best.ev || 0, r, function (sc) { return actionText(sc, c.heroStageBet, r.toCall); });
  }
  // Hero's turn (when it started and the game's clock then), so a re-solve after a link or a table-style change gets
  // the time that is left.
  var lastTurn = null;
  function timeLeft() { return lastTurn && lastTurn.left > 0 ? Math.max(1, lastTurn.left - (Date.now() - lastTurn.at)) : 0; }
  function thinkSecs() { return thinkStart ? Math.floor((Date.now() - thinkStart) / 1000) + ' s' : ''; }
  // The bar counts the seconds while the solve runs (up to about 10 s on a phone).
  setInterval(function () {
    if (!thinking) return;
    var el = mainEl.querySelector('.secs');
    if (el) el.textContent = thinkSecs();
  }, 500);
  function requestAdvice(timeLeftMs) {
    if (!tracker) return;
    if (timeLeftMs === undefined) timeLeftMs = timeLeft();
    var built = tracker.solverInput(ui.tableStyle);
    if (built.error) { status = built.error; render(); return; }
    var id = ++reqId;
    thinking = true; thinkStart = Date.now();
    sizing.note = null;
    if (advice) advice.stale = true;
    render();
    var input = timeLeftMs > 0 ? Object.assign({}, built.input, { timeLeftMs: timeLeftMs }) : built.input;
    analyze(input).then(function (res) {
      if (id !== reqId) return;
      thinking = false;
      if (res && res.superseded) { render(); return; }
      if (!res || !res.ok) { status = 'Solver error: ' + (res && res.error); advice = null; render(); return; }
      advice = { result: res.result, ctx: built, stale: false, ms: res.ms, workers: res.workers };
      note(advice);
      render();
    });
  }

  // ---------- files ----------
  // A file made by "Hand log" or "Export reads" waits on the panel for a tap on "Save to Files" (a real link: iOS
  // Safari only downloads from a tap) or "Share…" (AirDrop, Messages, Files).
  function setReady(f) {
    if (ready && ready.url) { var old = ready.url; setTimeout(function () { URL.revokeObjectURL(old); }, 60000); }
    ready = f;
    if (f) reveal = true;
  }
  function prepareFile(name, text, meta) {
    var blob = new Blob([text], { type: 'application/json' });
    setReady(Object.assign({ name: name, blob: blob, url: URL.createObjectURL(blob), size: blob.size }, meta || {}));
  }
  var shareOk = null;
  function canShare() {
    if (shareOk == null) {
      try { shareOk = !!(W.navigator.share && W.navigator.canShare && W.navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })); }
      catch (e) { shareOk = false; }
    }
    return shareOk;
  }
  function sizeTxt(b) { return b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
  function fileHtml() {
    var f = ready;
    return '<div class="file"><b>' + esc(f.name) + '</b> (' + sizeTxt(f.size) + (f.hands ? ', ' + handsTxt(f.hands.length) : f.info ? ', ' + f.info.players + ' players' : '') + ')' +
      (f.done ? '' : ' is ready.') +
      '<div class="row"><a class="btn" data-a="saveFile" href="' + f.url + '" download="' + esc(f.name) + '">Save to Files</a>' +
      (canShare() ? '<button class="btn" data-a="shareFile">Share…</button>' : '') + '</div>' +
      (f.note ? '<div class="status neg">' + esc(f.note) + '</div>' : '') +
      (f.done ? '<div class="muted">' + esc(f.done) + '</div>' : '') + '</div>';
  }
  function fileSaved() {
    var f = ready;
    if (!f || f.saved) return;
    f.saved = true;
    if (f.kind === 'log') {
      (f.partial ? Promise.resolve(null) : moveMark(f.hands, f.from)).then(function (mark) {
        var last = f.hands[f.hands.length - 1].t;
        var newest = logView && logView.times && logView.times.length ? logView.times[logView.times.length - 1] : last;
        var extra = !f.partial && (!f.session || last === newest) && !(mark >= last) ? ' The last hand will be in the next export too, in case its result or shown cards still come in.' : '';
        f.done = 'Saved: ' + handsTxt(f.hands.length) + '.' + extra;
        refreshLog();
      }, function () { render(); });
    } else {
      f.done = 'On the computer: tap Import on the panel and pick this file.';
      render();
    }
  }
  function readText(f) {
    if (f.text) return f.text();
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.readAsText(f);
    });
  }

  // ---------- hand log ----------
  // As on the computer: "Hand log" lists New hands (since the export mark, handlog.js nextMark), the newest sessions,
  // and Everything. The mark is kept under its own key, apart from the reads.
  var logMark = null;
  function markOf(m) { return m && typeof m.to === 'number' ? m.to : null; }
  function memHands(from, to) { return (tracker.db.history || []).filter(function (e) { return e.t > from && e.t <= to; }); }
  function storedTimes() {
    if (!handLog) return Promise.resolve((tracker.db.history || []).map(function (e) { return e.t || 0; }).sort(function (a, b) { return a - b; }));
    return handLog.times(tracker.db).catch(function () { return null; });
  }
  function refreshLog() {
    if (!tracker) return;
    storedTimes().then(function (times) { logView = times ? { times: times } : { error: true }; render(); });
  }
  // Moves the mark past the hands just exported or imported, as far as they cover every hand.
  function moveMark(entries, from) {
    return storedTimes().then(function (times) {
      if (!times) return logMark;
      var to = PatioHandLog.nextMark(logMark, times, entries, Date.now(), from);
      if (to != null && to !== logMark) { logMark = to; storeSet(MARK_KEY, { to: to, at: Date.now() }); }
      return to;
    });
  }
  function exportLog(what, from, to) {
    if (!tracker || busy) return;
    busy = 'log'; logNote = 'Preparing the file…'; setReady(null); render();
    if (what !== 'logSession') { from = what === 'logNew' && logMark != null ? logMark : -Infinity; to = Infinity; }
    (handLog ? handLog.exportRange(tracker.db, from, to).catch(function () { return null; }) : Promise.resolve(memHands(from, to))).then(function (hands) {
      var partial = false;
      if (!hands) { hands = memHands(from, to); partial = true; }
      // Hands left out of the reads go out marked, so the log tools leave them out too (test/merge-logs.js).
      var isOut = PatioTracker.leftOutTest(tracker.db.leftOut);
      hands = hands.map(function (e) { return isOut(e) && !e.excluded ? Object.assign({}, e, { excluded: true }) : e; });
      if (!hands.length) { logNote = 'No hands to export.'; return; }
      prepareFile(PatioHandLog.fileName(hands), PatioHandLog.toFile(hands), {
        kind: 'log', from: from, partial: partial, session: what === 'logSession',
        hands: hands.map(function (e) { return { t: e.t, net: e.net }; }),
        note: partial ? 'The stored hands couldn\'t be read, so this has only the newest 150.' : ''
      });
      logNote = '';
    }).catch(function (e) { logNote = 'Export failed: ' + ((e && e.message) || e); }).then(function () { busy = ''; render(); });
  }
  var when = function (t) { return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  var hhmm = function (t) { return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  function logSectionHtml() {
    var html = '<div><div class="sec">Hand log</div>';
    if (!logView) return html + '<div class="muted">Reading the stored hands…</div></div>';
    if (logView.error) return html + '<div class="status neg">The stored hands couldn\'t be read. Reload the page.</div></div>';
    var times = logView.times, mark = logMark;
    var fresh = mark == null ? times.length : times.filter(function (t) { return t > mark; }).length;
    html += '<div class="muted">' + handsTxt(times.length) + ' stored on this phone (' + (handLog ? 'it keeps the newest ' + PatioHandLog.KEEP.toLocaleString('en-US') : 'this browser keeps the newest 150, with raw events for 60') + ').' +
      (mark == null ? '' : ' Exported up to the hand at ' + esc(when(mark)) + '.') + '</div>';
    html += '<div class="row">' + (fresh ? '<button class="btn" data-a="logNew">New hands (' + fresh + ')</button>' : '<span class="muted">No new hands since the last export.</span>') +
      (times.length ? '<button class="btn" data-a="logAll">Everything (' + times.length + ')</button>' : '') + '</div>';
    var ss = PatioHandLog.sessions(times).slice(-6).reverse();
    if (ss.length) {
      html += '<div class="sec" style="margin-top:6px">Sessions</div>';
      ss.forEach(function (s) {
        var end = day(s.from) === day(s.to) ? hhmm(s.to) : day(s.to) + ' ' + hhmm(s.to);
        html += '<div class="lk"><span>' + esc(day(s.from) + ' ' + hhmm(s.from) + '–' + end) + ' · ' + handsTxt(s.n) + (mark != null && s.to <= mark ? ' · exported' : '') + '</span><span style="flex:1"></span>' +
          '<button class="btn" data-a="logSession" data-from="' + (s.from - 1) + '" data-to="' + s.to + '">Export</button></div>';
      });
    }
    if (ready && ready.kind === 'log') html += fileHtml();
    if (logNote) html += '<div class="status' + (/failed|couldn't/.test(logNote) ? ' neg' : '') + '">' + esc(logNote) + '</div>';
    return html + '</div>';
  }

  // ---------- reads files ----------
  // "Export reads" makes a file of the reads alone (PatioTracker.readsFile); "Import" takes one from the computer's
  // panel (Export reads there) and, after a tap on "Replace", puts its reads here in place of the phone's. Each side
  // keeps its own reads otherwise. Import also takes hand-log exports, as the computer's does: their hands go into the
  // hand log here and the reads are rebuilt from every stored hand.
  function exportReads() {
    if (!tracker) return;
    var data = PatioTracker.readsFile(tracker.db, { from: 'phone', version: VERSION });
    prepareFile(PatioTracker.readsFileName('phone'), JSON.stringify(data), { kind: 'reads', info: PatioTracker.readsInfo(tracker.db) });
    readsNote = '';
    render();
  }
  function importFiles(files) {
    if (!tracker || busy || !files.length) return;
    busy = 'import'; pendingReads = null; setReady(null); ui.showReads = true; ui.showLog = false;
    readsNote = 'Reading ' + (files.length === 1 ? files[0].name : files.length + ' files') + '…'; render();
    Promise.all(files.map(function (f) {
      return readText(f).then(function (t) {
        try { return { name: f.name, data: JSON.parse(t) }; } catch (e) { throw new Error(f.name + ' isn\'t a Patio Solver file (not JSON)'); }
      });
    })).then(function (got) {
      var reads = got.filter(function (g) { return PatioTracker.readsFromFile(g.data); });
      if (reads.length) {
        if (got.length > 1) throw new Error('pick the reads file on its own');
        pendingReads = Object.assign({ name: reads[0].name }, PatioTracker.readsFromFile(reads[0].data));
        readsNote = ''; reveal = true;
        return null;
      }
      return importHands(got);
    }).catch(function (e) { readsNote = 'Import failed: ' + ((e && e.message) || e) + '.'; })
      .then(function () { busy = ''; render(); });
  }
  function importHands(got) {
    var list = [];
    got.forEach(function (g) {
      var d = g.data, l = Array.isArray(d) ? d : d && Array.isArray(d.history) ? d.history : null;
      if (!l) throw new Error(g.name + ' is neither a reads file nor a hand-log export');
      for (var i = 0; i < l.length; i++) list.push(l[i]);
    });
    if (!handLog) throw new Error('this browser can\'t store the full hand log, so only a reads file can be imported here');
    var key = function (e) { return e.t + ':' + (e.hero || []).join(''); };
    return handLog.exportAll(tracker.db).then(function (stored) {
      var have = new Set(stored.map(key)), fresh = [];
      list.forEach(function (e) { if (e && e.t != null && !have.has(key(e))) { have.add(key(e)); fresh.push(e); } });
      return handLog.addHands(fresh).then(function (add) {
        if (!add.ok) throw new Error(add.error || 'storage write failed');
        // Names in logs without account ids map to the ids the reads here already use.
        var known = {};
        Object.keys(tracker.db.players).forEach(function (id) { var r = tracker.db.players[id]; if (r && r.name && id.slice(0, 5) !== 'name:') known[r.name] = tracker.canon(id); });
        return PatioTracker.rebuildReads(stored.concat(fresh), {
          known: known, heroAuth: tracker.snap && tracker.snap.heroAuthId, yieldEvery: 10, leftOut: tracker.db.leftOut,
          same: tracker.db.same, notSame: tracker.db.notSame, linkLog: tracker.db.linkLog, setup: setupTracker,
          onProgress: function (i, n) { readsNote = 'Rebuilding reads: ' + i + ' of ' + n + ' hands…'; render(); }
        }).then(function (res) {
          // A read built from more hands than the log still holds stays.
          var kept = 0;
          Object.keys(res.db.players).forEach(function (id) {
            var cur = tracker.db.players[id], r = res.db.players[id];
            if (cur && handsOfTally(cur) > handsOfTally(r) * 1.1 + 2) { kept++; return; }
            tracker.db.players[id] = r;
          });
          tracker.absorbLinks(res.db);
          return saveDb(true).then(function () { return moveMark(list).catch(function () { return null; }); }).then(function () {
            if (ui.showLog) refreshLog();
            readsNote = 'Imported ' + add.added + ' new hand' + (add.added === 1 ? '' : 's') + ' (' + (list.length - fresh.length) + ' already here). Reads rebuilt from ' + res.replayed + ' hands' +
              (res.skipped ? '; ' + res.skipped + ' without raw events only went into the log' : '') + (res.leftOut ? '; ' + res.leftOut + ' you left out stay out' : '') +
              (kept ? '; ' + kept + ' reads with more history kept as they were' : '') + '.';
          });
        });
      });
    });
  }
  function fromTxt(f) { return f === 'computer' ? 'the computer' : f === 'phone' ? 'a phone' : 'another device'; }
  function replaceReads() {
    var p = pendingReads;
    if (!p || !tracker || busy) return;
    pendingReads = null;
    var history = tracker.db.history || [];
    tracker.db = Object.assign({}, p.reads, { history: history });
    tracker.linkAsks = null; tracker.whoAsks = null;
    // Who sat together in the hands played here (two accounts in one hand are never one player).
    tracker.learnSeats(history);
    readsNote = 'Reads replaced with ' + fromTxt(p.from) + '\'s: ' + p.info.players + ' player' + (p.info.players === 1 ? '' : 's') + (p.info.last ? ', newest hand ' + when(p.info.last) : '') + '. The hand log here stays as it was.';
    saveDb(true).then(function () { render(); });
    if (advice && !advice.stale) requestAdvice(); else render();
  }
  function readsSectionHtml() {
    var cur = PatioTracker.readsInfo(tracker.db), html = '<div><div class="sec">Reads file</div>';
    html += '<div class="muted">' + cur.players + ' player' + (cur.players === 1 ? '' : 's') + ' on this phone' + (cur.linked ? ', ' + cur.linked + ' linked account' + (cur.linked === 1 ? '' : 's') : '') + (cur.last ? ', newest hand ' + esc(when(cur.last)) : '') + '.</div>';
    html += '<div class="row"><button class="btn" data-a="exportReads">Export reads</button><label class="btn" for="ps-file">Import</label><button class="btn" data-a="reset">Reset reads</button></div>';
    var p = pendingReads;
    if (p) {
      html += '<div class="ask pin"><b>' + esc(p.name) + '</b>: reads from ' + esc(fromTxt(p.from)) + (p.savedAt ? ', saved ' + esc(when(p.savedAt)) : '') + ': ' + p.info.players + ' player' + (p.info.players === 1 ? '' : 's') + (p.info.last ? ', newest hand ' + esc(when(p.info.last)) : '') + '.' +
        '<br>This phone now: ' + cur.players + ' player' + (cur.players === 1 ? '' : 's') + (cur.last ? ', newest hand ' + esc(when(cur.last)) : '') + '.' +
        (cur.players && cur.last > (p.info.last || 0) ? '<div class="neg">This phone has hands newer than the file. Replacing loses what they added to the reads (the hand log keeps them).</div>' : '') +
        '<div class="row"><button class="btn" data-a="replaceReads">Replace this phone\'s reads</button><button class="btn" data-a="cancelReads">Cancel</button></div></div>';
    }
    if (ready && ready.kind === 'reads') html += fileHtml();
    if (readsNote) html += '<div class="status' + (/failed/.test(readsNote) ? ' neg' : '') + '">' + esc(readsNote) + '</div>';
    html += '<div class="muted">Export reads makes a file of these reads for the computer (Import on its panel). Import takes a reads file from the computer, which replaces the reads here, or hand-log exports, which go into this phone\'s hand log and rebuild the reads.</div>';
    return html + '</div>';
  }
  fileIn.addEventListener('change', function () {
    var files = fileIn.files ? [].slice.call(fileIn.files) : [];
    fileIn.value = '';
    if (files.length) importFiles(files);
  });

  // ---------- reading the game ----------
  var WANTED = {
    'game:stage_began': 1, 'game:dealer_updated': 1, 'game:small_blind_paid': 1, 'game:big_blind_paid': 1,
    'game:cards_dealt_to_player': 1, 'game:card_dealt_to_player': 1, 'game:update_card_data': 1,
    'game:cards_deal_to_stack': 1, 'game:card_deal_to_stack': 1, 'player:game:action_taken': 1,
    'game:player_turn_started': 1, 'game:player_turn_ended': 1, 'game:game_ended': 1, 'admin:game:game_stopped': 1
  };
  var PUBLIC_MSG = 'Patio Solver only runs in private lobbies with friends. It stays off at public tables.';
  var WAIT_MSG = 'Waiting to see what kind of table this is…';
  function snapshot() {
    var gm = W.GameManager, st = (gm && gm.state) || {};
    var bs = (st.settings && st.settings.blind_sizes) || [];
    return {
      tableType: gm && gm.data ? gm.data.tableType : null,
      heroAuthId: gm && gm.playerData ? gm.playerData.id : null,
      bigBlind: bs.length ? bs[bs.length - 1].bb : null,
      players: (st.players || []).map(function (p) {
        return { id: p.id, authUserId: p.authUserId, name: p.name, stack: p.stack, posType: p.posType, playState: p.playState };
      })
    };
  }
  function onEvent(ev, data) {
    var snap = snapshot();
    // Private lobbies only. A table whose type isn't known yet (page still loading) is off too.
    if (snap.tableType !== 'private') {
      var msg = snap.tableType ? PUBLIC_MSG : WAIT_MSG;
      if (!blocked || status !== msg) { blocked = true; status = msg; render(); }
      return;
    }
    blocked = false;
    try { tracker.handle(ev, data, snap); } catch (err) { /* keep the table running */ }
  }
  var hooked = null, lastEventAt = 0, sigMoves = 0, firstMoveAt = 0, lastSig = null, startedAt = Date.now();
  // Other table events go to the tracker only for the hand log's raw recorder.
  function onAnyEvent(ev, data) {
    lastEventAt = Date.now(); sigMoves = 0;
    if (WANTED[ev] || (ev === 'chat_message' ? !!(data && data.msgType === 'game_log') : /^(game:|player:game:|admin:game:)/.test(ev))) onEvent(ev, data);
  }
  // Starts once the reads are loaded (tracking starts at the next hand anyway).
  function startHook() {
    startedAt = Date.now();
    setInterval(function () {
      // Poker Patio's 3 Nov 2026 update moved the socket to GameManager.roomConnectionManager.socket
      // (a new socket on every reconnect); before that it was GameManager.socket.
      var gm = W.GameManager, rcm = gm && gm.roomConnectionManager;
      var sock = (rcm && rcm.socket) || (gm && gm.socket);
      if (!sock || sock === hooked || typeof sock.onAny !== 'function') return;
      if (hooked && typeof hooked.offAny === 'function') hooked.offAny(onAnyEvent);
      hooked = sock;
      sock.onAny(onAnyEvent);
      tracker.snap = snapshot();
      if (tracker.snap.tableType !== 'private') { blocked = true; status = tracker.snap.tableType ? PUBLIC_MSG : WAIT_MSG; }
      else if (!tracker.hand) { blocked = false; status = 'Connected. Advice starts next hand.'; }
      hookProblem = null;
      render();
    }, 300);
    // Watchdog, as in the extension's hook.js: a table on screen with no socket for noSocketMs ('nosocket'), or chips
    // moving at least twice over silentMs with no socket event at all ('silent'). window.__patioSolverWatch shortens
    // the waits on test pages.
    setInterval(function () {
      var gm = W.GameManager, cfg = W.__patioSolverWatch || {}, now = Date.now();
      var noSocketMs = cfg.noSocketMs || 15000, silentMs = cfg.silentMs || 20000;
      var ps = gm && gm.state && gm.state.players, table = !!(ps && ps.length), p = null;
      if (table && !hooked && now - startedAt >= noSocketMs) p = 'nosocket';
      if (table && hooked) {
        var sig = ps.map(function (q) { return [q.id, q.stack, q.totalBetsMade, q.playState].join(':'); }).join('|');
        if (lastSig != null && sig !== lastSig) { if (!sigMoves) firstMoveAt = now; sigMoves++; }
        lastSig = sig;
        if (sigMoves >= 2 && now - firstMoveAt >= silentMs && now - lastEventAt >= silentMs) p = 'silent';
      }
      if (p !== hookProblem && !(p && snapshot().tableType !== 'private')) { hookProblem = p; render(); }
    }, 1000);
  }

  // ---------- start ----------
  function setupTracker(t) {
    t.scorer = function (show, tally) { return PokerEngine.scoreShow(show, tally, ui.tableStyle, t.poolTally()); };
    t.predictor = PokerEngine.makePredictor(function () { return ui.tableStyle; }, function () { return t.poolTally(); });
    t.fitVersion = PokerEngine.FIT_VERSION;
  }
  function wire() {
    tracker.on(function (type, p) {
      if (type === 'save') saveDb();
      else if (type === 'hand') { cancelRunning(); advice = null; thinking = false; reqId++; lastTurn = null; sizing.note = null; status = 'New hand. Waiting for your turn…'; render(); }
      else if (type === 'handEnd') {
        cancelRunning(); if (advice) advice.stale = true; thinking = false; reqId++; lastTurn = null; status = 'Hand over. Waiting for the next one…';
        if (ui.showLog) refreshLog(); else render();
      } else if (type === 'turn') {
        if (p.isHero) { lastTurn = { at: Date.now(), left: p.timeLeftMs || 0 }; requestAdvice(p.timeLeftMs || 0); }
        else if (advice && !advice.stale) { advice.stale = true; render(); }
      } else if (type === 'heroDone') { cancelRunning(); reqId++; thinking = false; lastTurn = null; if (advice) advice.stale = true; render(); }
      else if (type === 'action' || type === 'street' || type === 'cards') { if (type === 'action') checkSize(); if (ui.expanded || (type === 'action' && sizing.note)) render(); }
      else if (type === 'linkAsk' || type === 'whoAsk') render();
    });
  }
  // Reads saved by older versions miss parts later reads count; each is filled in once from every stored hand
  // (as on the computer's panel).
  function retag() {
    var d = tracker.db;
    if (d.hpTagged && d.jamTagged && d.cbTagged && d.mwTagged && d.sdTagged && d.vrTagged && d.brTagged && d.stTagged && d.prTagged) return;
    (handLog ? handLog.exportAll(d).catch(function () { return d.history || []; }) : Promise.resolve(d.history || [])).then(function (hands) {
      if (tracker.db !== d) return;
      if (!d.hpTagged) { tracker.tagHeroPot(hands); d.hpTagged = 1; }
      if (!d.jamTagged) { tracker.tagJamShows(hands); d.jamTagged = 1; }
      if (!d.cbTagged) { tracker.tagCheckBet(hands); d.cbTagged = 1; }
      if (!d.mwTagged) { tracker.tagMwFolds(hands); d.mwTagged = 1; }
      if (!d.sdTagged) { tracker.tagShowdown(hands); d.sdTagged = 1; }
      if (!d.vrTagged) { tracker.tagVsRaise(hands); d.vrTagged = 1; }
      if (!d.brTagged) { tracker.tagBetRecent(hands); d.brTagged = 1; }
      if (!d.stTagged) { tracker.tagShowTimes(hands); d.stTagged = 1; }
      if (!d.prTagged) { tracker.tagPfRecent(hands); d.prTagged = 1; }
      saveDb(true);
    });
  }
  function startTracker(db, error) {
    tracker = new PatioTracker(db);
    if (legacy) tracker.rawKeep = 60; // page storage is shared with the game
    setupTracker(tracker);
    if (error) noteSaved({ ok: false, error: error });
    // Reads saved before v1.8.8 don't know who played together: learned from the stored hands.
    tracker.learnSeats(tracker.db.history || []);
    wire();
    retag();
    startHook();
    render();
  }
  function init() {
    var a = null;
    try { a = W.indexedDB ? idbArea(IDB_NAME, 'kv') : null; } catch (e) { a = null; }
    (a ? a.ok() : Promise.resolve(false)).then(function (ok) {
      if (!ok) { legacy = true; logMark = markOf(load(MARK_KEY)); if (logMark == null) logMark = ui.loggedAt || null; startTracker(load(DB_KEY) || { players: {} }, null); return; }
      area = a;
      handLog = PatioHandLog.create(area, DB_KEY);
      return Promise.all([handLog.load(PatioTracker.MAX_HISTORY, PatioTracker.RAW_KEEP), storeGet(MARK_KEY)]).then(function (got) {
        var loaded = got[0];
        logMark = markOf(got[1]);
        // First start of this version: the reads and hands in localStorage move to IndexedDB, and the key is freed
        // once they are saved there.
        var old = loaded.error ? null : load(DB_KEY), moved = false;
        if (old && old.players && Object.keys(old.players).length && !Object.keys(loaded.db.players || {}).length) {
          loaded.db = old; moved = true;
          if (logMark == null && ui.loggedAt) logMark = ui.loggedAt;
        }
        startTracker(loaded.db, loaded.error);
        if (moved) {
          saveDb(true).then(function (r) {
            if (!r || !r.ok) return;
            try { localStorage.removeItem(DB_KEY); } catch (e) { /* stays */ }
            if (logMark != null) storeSet(MARK_KEY, { to: logMark, at: Date.now() });
          });
        }
      });
    }).catch(function (e) {
      // Storage failed in some unexpected way: run on the page's storage rather than not at all.
      if (tracker) return;
      legacy = true; handLog = null; area = null;
      startTracker(load(DB_KEY) || { players: {} }, 'the site storage failed (' + ((e && e.message) || e) + '), so reads are kept in page storage');
    });
  }

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    W.addEventListener('resize', place);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  init();
})();
