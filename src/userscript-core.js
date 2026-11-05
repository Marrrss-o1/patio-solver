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
        stats: { hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, af: o.stats.af, foldToBet: o.stats.foldToBet, confidence: o.stats.confidence },
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

  // ---------- storage ----------
  var DB_KEY = 'patioSolverDb', UI_KEY = 'patioSolverUi';
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  // The page's localStorage is shared with the game, so if it fills up, raw hand events are
  // dropped (oldest first) before the reads are ever lost. If the reads still can't be saved,
  // the panel says so until a save works again.
  var saveError = null;
  function save(k, v) {
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
    if (k === DB_KEY && err !== saveError) { saveError = err; if (tracker && body) render(); }
  }
  // Hands logged since the last "Hand log" export. This phone keeps 150 hands, raw events for 60,
  // so from LOG_REMIND on the panel asks for an export.
  var LOG_REMIND = 50;
  function unexported() {
    var list = (tracker && tracker.db.history) || [], since = ui.loggedAt || 0, c = 0;
    for (var i = list.length - 1; i >= 0 && (list[i].t || 0) > since; i--) c++;
    return c;
  }

  // ---------- solver in a background worker ----------
  // A worker that fails (it can't start, e.g. a page that blocks workers, or it dies) never
  // answers again, so from then on the solver runs on the page. A crash usually comes while the
  // newest decision is still open, so that one is solved on the page; older ones only get an
  // error. A job unanswered for 30 s counts as a hung worker (its decision is long over).
  var worker = null, pending = {}, nextId = 1, JOB_LIMIT_MS = 30000;
  function onPage(input, res) {
    setTimeout(function () {
      try { res({ ok: true, result: slim(PokerEngine.analyzeSync(input)) }); }
      catch (err) { res({ ok: false, error: String(err && err.message || err) }); }
    }, 30);
  }
  function workerFailed(hung) {
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    var owed = pending; pending = {};
    var ids = Object.keys(owed).map(Number).sort(function (a, b) { return a - b; });
    ids.forEach(function (id, i) {
      clearTimeout(owed[id].timer);
      if (!hung && i === ids.length - 1) onPage(owed[id].input, owed[id].res);
      else owed[id].res({ ok: false, error: 'The solver stopped answering. It runs on the page from now on.' });
    });
  }
  try {
    var src = '(' + ENGINE.toString() + ')();\n' + slim.toString() +
      '\nself.onmessage=function(e){try{var t0=Date.now();var r=PokerEngine.analyzeSync(e.data.input);' +
      'self.postMessage({id:e.data.id,ok:true,result:slim(r),ms:Date.now()-t0})}catch(err){' +
      'self.postMessage({id:e.data.id,ok:false,error:String(err&&err.message||err)})}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = function (e) { var job = pending[e.data.id]; delete pending[e.data.id]; if (job) { clearTimeout(job.timer); job.res(e.data); } };
    worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); workerFailed(false); };
  } catch (e) { worker = null; }

  function analyze(input) {
    return new Promise(function (res) {
      if (worker) {
        var id = nextId++;
        pending[id] = { res: res, input: input, timer: setTimeout(function () { if (pending[id]) workerFailed(true); }, JOB_LIMIT_MS) };
        worker.postMessage({ id: id, input: input });
        return;
      }
      onPage(input, res);
    });
  }

  // ---------- state ----------
  var narrow = Math.min(W.innerWidth, W.screen ? W.screen.width : 9999) < 640;
  var ui = Object.assign({ tableStyle: 'typical', x: null, y: null, expanded: !narrow, showOptions: !narrow }, load(UI_KEY) || {});
  var tracker = new PatioTracker(load(DB_KEY) || { players: {} });
  tracker.rawKeep = 60; // phone storage is shared with the game; export the hand log after each session
  tracker.scorer = function (show, tally) { return PokerEngine.scoreShow(show, tally, ui.tableStyle, tracker.poolTally()); };
  tracker.predictor = PokerEngine.makePredictor(function () { return ui.tableStyle; }, function () { return tracker.poolTally(); });
  tracker.fitVersion = PokerEngine.FIT_VERSION;
  // Reads saved before v1.8.8 don't know who played together: learned from the stored hands.
  tracker.learnSeats(tracker.db.history || []);
  // Shows saved before v1.8.9 don't say whether hero was in the pot (the learned hero-pot tilt): filled in from the
  // stored hands.
  if (tracker.tagHeroPot(tracker.db.history || [])) save(DB_KEY, tracker.db);
  var linkNote = '';
  var status = 'Connecting to the table…';
  var advice = null, thinking = false, blocked = false, reqId = 0;
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
    '.spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;margin-right:6px;vertical-align:-1px}@keyframes s{to{transform:rotate(360deg)}}' +
    '</style>' +
    '<div class="panel"><div class="bar"><span class="dot"></span><div class="main"></div><button class="chev" data-a="toggle">▾</button></div><div class="bd"></div></div>';
  var panel = root.querySelector('.panel'), bar = root.querySelector('.bar'), mainEl = root.querySelector('.main'),
    body = root.querySelector('.bd'), dot = root.querySelector('.dot'), chev = root.querySelector('.chev');

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
      if (moved) save(UI_KEY, ui); else { ui.expanded = !ui.expanded; save(UI_KEY, ui); render(); }
    });
  })();

  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]');
    if (!a) return;
    var what = a.getAttribute('data-a');
    if (what === 'toggle') { ui.expanded = !ui.expanded; save(UI_KEY, ui); render(); }
    else if (what === 'opts') { ui.showOptions = !ui.showOptions; save(UI_KEY, ui); render(); }
    else if (what === 'log') {
      var hands = tracker.db.history || [];
      // One hand per line (as the computer's export): about 40% smaller than indenting every field.
      var text = '[\n' + hands.map(function (h) { return JSON.stringify(h); }).join(',\n') + '\n]\n';
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      if (hands.length) { ui.loggedAt = hands[hands.length - 1].t || Date.now(); save(UI_KEY, ui); render(); }
      var link = document.createElement('a');
      link.href = url; link.download = 'patio-hand-log.json';
      root.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }
    else if (what === 'reset') {
      if (a.getAttribute('data-c') !== '1') {
        a.setAttribute('data-c', '1'); a.textContent = 'Tap again to reset';
        setTimeout(function () { a.removeAttribute('data-c'); a.textContent = 'Reset reads'; }, 3000);
        return;
      }
      // The reads start over; the hand log stays.
      tracker.db = { players: {}, history: tracker.db.history || [] }; tracker.linkAsks = null; tracker.learnSeats(tracker.db.history);
      save(DB_KEY, tracker.db); render();
    }
    else if (what === 'links') { ui.showLinks = !ui.showLinks; linkNote = ''; save(UI_KEY, ui); render(); }
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
    save(DB_KEY, tracker.db);
    if (advice && !advice.stale) requestAdvice(); else render();
  }
  root.addEventListener('change', function (e) {
    if (e.target.matches('select[data-a="linkPick"]')) {
      if (!e.target.value) return;
      var res = tracker.link(e.target.getAttribute('data-id'), e.target.value);
      linkNote = res.ok ? 'Reads joined: ' + res.info.names.join(' / ') + ', ' + handsTxt(res.info.hands) + '.' : res.error;
      afterLink();
    } else if (e.target.matches('select')) {
      ui.tableStyle = e.target.value; save(UI_KEY, ui);
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
    var asks = tracker.linkAsks, seen = tracker.db.seen || {}, html = '';
    if (!asks) return '';
    Object.keys(asks).forEach(function (k) {
      var a = asks[k];
      a.matches.forEach(function (m) {
        var last = Math.max.apply(null, [0].concat(m.ids.map(function (x) { return (seen[x] && seen[x].last) || 0; })));
        html += '<div class="ask"><b>' + esc(a.name) + '</b> is on an account the reads haven\'t seen. Same player as the older read ' + esc(readLabel(Object.assign({}, m, { last: last }))) + '?' +
          '<div class="row"><button class="btn" data-a="linkYes" data-id="' + esc(a.id) + '" data-to="' + esc(m.id) + '">Same player</button> ' +
          '<button class="btn" data-a="linkNo" data-id="' + esc(a.id) + '" data-to="' + esc(m.id) + '">Different players</button></div></div>';
      });
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
    at.forEach(function (p) {
      var opts = linkOptions(p.auth, groups);
      html += '<div class="lk"><span class="nm">' + esc(p.name) + '</span>' + (opts.length
        ? '<select data-a="linkPick" data-id="' + esc(p.auth) + '"><option value="">Same player as…</option>' + opts.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(readLabel(g)) + '</option>'; }).join('') + '</select>'
        : '<span class="muted">no other reads to join</span>') + '</div>';
    });
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
    var fresh = advice && !advice.stale;
    var logDue = unexported() >= LOG_REMIND;
    var asking = tracker.linkAsks && Object.keys(tracker.linkAsks).length;
    var logBadge = !fresh && !thinking ? (asking ? '<span class="badge">same player?</span>' : '') + (logDue ? '<span class="badge">export log</span>' : '') : '';
    dot.className = 'dot' + (blocked ? '' : hookProblem ? ' bad' : (fresh || thinking) ? ' turn' : tracker.snap ? ' live' : '');
    chev.textContent = ui.expanded ? '▴' : '▾';
    panel.classList.toggle('stale', !!(advice && advice.stale));

    // Bar
    if (blocked) mainEl.innerHTML = '<span class="act idle">' + (status === WAIT_MSG ? 'Waiting for the table' : 'Off at public tables') + '</span>';
    else if (thinking && !fresh) mainEl.innerHTML = '<span class="act idle"><span class="spin"></span>Thinking…</span>';
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
    }).join('') + '</select><span style="flex:1"></span><button class="btn" data-a="links">Link reads</button> <button class="btn" data-a="log">Hand log</button> <button class="btn" data-a="reset">Reset reads</button></div>';
    html += '<div class="muted">Tracking ' + n + ' player' + (n === 1 ? '' : 's') + '. Reads sharpen as hands pile up.</div>';
    if (sizing.small) html += '<div class="muted">Bets this session under ' + Math.round(SMALL_SIZE * 100) + '% of the advised size: ' + sizing.small + ' of ' + sizing.n + '.</div>';
    if (logDue) html += '<div class="status neg">' + unexported() + ' hands since the last Hand log export. Tap Hand log to keep them: this phone keeps the newest 150 hands, with raw events for 60.</div>';
    if (saveError) html += '<div class="status neg">Couldn\'t save reads: ' + esc(saveError) + '. The page\'s storage may be full; export the hand log.</div>';
    body.innerHTML = html;
    place();
  }

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
  function requestAdvice() {
    var built = tracker.solverInput(ui.tableStyle);
    if (built.error) { status = built.error; render(); return; }
    var id = ++reqId;
    thinking = true;
    sizing.note = null;
    if (advice) advice.stale = true;
    render();
    analyze(built.input).then(function (res) {
      if (id !== reqId) return;
      thinking = false;
      if (!res || !res.ok) { status = 'Solver error: ' + (res && res.error); advice = null; render(); return; }
      advice = { result: res.result, ctx: built, stale: false };
      tracker.noteAdvice(actionText(res.result.best, built.heroStageBet, res.result.toCall), res.result.best.ev || 0, res.result, function (sc) { return actionText(sc, built.heroStageBet, res.result.toCall); });
      render();
    });
  }

  tracker.on(function (type, p) {
    if (type === 'save') save(DB_KEY, tracker.db);
    else if (type === 'hand') { advice = null; thinking = false; reqId++; sizing.note = null; status = 'New hand. Waiting for your turn…'; render(); }
    else if (type === 'handEnd') { if (advice) advice.stale = true; thinking = false; reqId++; status = 'Hand over. Waiting for the next one…'; render(); }
    else if (type === 'turn') {
      if (p.isHero) requestAdvice();
      else if (advice && !advice.stale) { advice.stale = true; render(); }
    } else if (type === 'heroDone') { reqId++; thinking = false; if (advice) advice.stale = true; render(); }
    else if (type === 'action' || type === 'street' || type === 'cards') { if (type === 'action') checkSize(); if (ui.expanded || (type === 'action' && sizing.note)) render(); }
    else if (type === 'linkAsk') render();
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

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    W.addEventListener('resize', place);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
