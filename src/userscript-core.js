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
    margin: isFinite(r.margin) ? r.margin : null, close: r.close, mix: r.mix, solver: r.solver,
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
  // dropped (oldest first) before the reads are ever lost.
  function save(k, v) {
    for (var tries = 0; tries < 6; tries++) {
      try { localStorage.setItem(k, JSON.stringify(v)); return; } catch (e) {
        var hist = v && v.history;
        if (!hist) return;
        var withRaw = hist.filter(function (x) { return x.raw; });
        if (!withRaw.length) return;
        withRaw.slice(0, Math.ceil(withRaw.length / 2)).forEach(function (x) { delete x.raw; });
      }
    }
  }

  // ---------- solver in a background worker ----------
  var worker = null, pending = {}, nextId = 1;
  try {
    var src = '(' + ENGINE.toString() + ')();\n' + slim.toString() +
      '\nself.onmessage=function(e){try{var t0=Date.now();var r=PokerEngine.analyzeSync(e.data.input);' +
      'self.postMessage({id:e.data.id,ok:true,result:slim(r),ms:Date.now()-t0})}catch(err){' +
      'self.postMessage({id:e.data.id,ok:false,error:String(err&&err.message||err)})}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = function (e) { var cb = pending[e.data.id]; delete pending[e.data.id]; if (cb) cb(e.data); };
    worker.onerror = function () { worker = null; };
  } catch (e) { worker = null; }

  function analyze(input) {
    return new Promise(function (res) {
      if (worker) {
        var id = nextId++;
        pending[id] = res;
        worker.postMessage({ id: id, input: input });
        return;
      }
      setTimeout(function () { // fallback: run on the page
        try { res({ ok: true, result: slim(PokerEngine.analyzeSync(input)) }); }
        catch (err) { res({ ok: false, error: String(err && err.message || err) }); }
      }, 30);
    });
  }

  // ---------- state ----------
  var narrow = Math.min(W.innerWidth, W.screen ? W.screen.width : 9999) < 640;
  var ui = Object.assign({ tableStyle: 'typical', x: null, y: null, expanded: !narrow, showOptions: !narrow }, load(UI_KEY) || {});
  var tracker = new PatioTracker(load(DB_KEY) || { players: {} });
  tracker.rawKeep = 60; // phone storage is shared with the game; export the hand log after each session
  tracker.scorer = function (show, tally) { return PokerEngine.scoreShow(show, tally, ui.tableStyle); };
  var status = 'Connecting to the table…';
  var advice = null, thinking = false, blocked = false, reqId = 0;

  // ---------- formatting ----------
  function money(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var SUITSYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
  function cardHtml(c) { return '<span class="cd' + (c[1] === 'h' || c[1] === 'd' ? ' red' : '') + '">' + (c[0] === 'T' ? '10' : c[0]) + SUITSYM[c[1]] + '</span>'; }
  function actionText(sc, heroStageBet, toCall) {
    if (!sc) return '';
    if (sc.kind === 'fold') return 'Fold';
    if (sc.kind === 'check') return 'Check';
    if (sc.kind === 'call') return 'Call ' + money(sc.amount);
    if (sc.kind === 'allin') return sc.amount <= toCall + 1e-9 ? 'Call all-in ' + money(sc.amount) : 'All-in ' + money(heroStageBet + sc.amount);
    if (sc.kind === 'bet' && heroStageBet <= 0) return 'Bet ' + money(sc.amount);
    return 'Raise to ' + money(heroStageBet + sc.amount);
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
    '.dot{width:9px;height:9px;border-radius:50%;background:#777;flex:none}.dot.live{background:#3fcf6e}.dot.turn{background:#ffcc33;box-shadow:0 0 8px #ffcc33}' +
    '.main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden}' +
    '.act{font-weight:700;font-size:17px;overflow:hidden;text-overflow:ellipsis}.act.aggr{color:#4be08a}.act.passive{color:#6cb8ff}.act.fold{color:#ff7a7a}.act.idle{font-weight:500;font-size:13.5px;color:#c4ccc6}' +
    '.ev{font-size:12px;color:#aab3ad;flex:none}' +
    '.chev{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:inherit;font-size:15px}' +
    '.stale .act{opacity:.45}' +
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
      var url = URL.createObjectURL(new Blob([JSON.stringify(tracker.db.history || [], null, 1)], { type: 'application/json' }));
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
      tracker.db = { players: {} }; save(DB_KEY, tracker.db); render();
    }
  });
  root.addEventListener('change', function (e) {
    if (e.target.matches('select')) {
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
      var r = tracker.db.players[p.auth];
      var st = PokerEngine.computeStats(Object.assign(PatioTracker.blankTally(), r ? r.tally : {}), ui.tableStyle);
      out.push({ name: p.name + (p.folded ? ' (folded)' : ''), type: PokerEngine.classifyPlayer(st).label, hands: st.hands, vpip: st.raw.vpip, pfr: st.raw.pfr, ftb: st.raw.foldToBet, summary: PokerEngine.readSummary(st) });
    });
    return out;
  }

  function render() {
    var fresh = advice && !advice.stale;
    dot.className = 'dot' + (blocked ? '' : (fresh || thinking) ? ' turn' : tracker.snap ? ' live' : '');
    chev.textContent = ui.expanded ? '▴' : '▾';
    panel.classList.toggle('stale', !!(advice && advice.stale));

    // Bar
    if (blocked) mainEl.innerHTML = '<span class="act idle">Off at public tables</span>';
    else if (thinking && !fresh) mainEl.innerHTML = '<span class="act idle"><span class="spin"></span>Thinking…</span>';
    else if (advice) {
      var b = advice.result.best;
      mainEl.innerHTML = '<span class="act ' + tone(b) + '">' + esc(actionText(b, advice.ctx.heroStageBet, advice.result.toCall)) + '</span>' +
        (advice.result.close && fresh ? '<span class="badge">close</span>' : '') +
        '<span class="ev">' + (advice.stale ? 'last turn' : (b.kind === 'fold' ? '' : (b.ev >= 0 ? '+' : '−') + money(Math.abs(b.ev)))) + '</span>';
    } else mainEl.innerHTML = '<span class="act idle">' + esc(status) + '</span>';

    body.style.display = ui.expanded ? '' : 'none';
    if (!ui.expanded) { place(); return; }
    if (blocked) { body.innerHTML = '<div class="status">' + esc(status) + '</div>'; place(); return; }

    var h = tracker.hand, html = '';
    var heroCards = h ? h.heroUids.map(function (u) { return h.heroCards[u]; }).filter(Boolean) : [];
    if (heroCards.length || (h && h.board.length)) {
      html += '<div class="hand">' + heroCards.map(cardHtml).join('') + (h.board.length ? '<span class="muted">&nbsp;board</span>' + h.board.map(cardHtml).join('') : '') + '</div>';
    }
    if (advice) {
      var r = advice.result, c = advice.ctx, best = r.best, kv = [];
      if (r.hero) kv.push(['Your hand', esc(r.hero.made + (r.hero.draws && r.hero.draws.length ? ' + ' + r.hero.draws.map(function (d) { return d.name.toLowerCase(); }).join(', ') : '') + (r.street === 0 && r.hero.topPercent != null ? ' (top ' + Math.max(1, Math.round(r.hero.topPercent)) + '%)' : ''))]);
      if (r.mix) kv.push(['Close spot, mix it', esc(r.mix.map(function (m) { return m.label + ' ' + pct(m.freq); }).join(' · '))]);
      if (r.equity) kv.push(['Equity vs their ranges', pct(r.equity.share)]);
      if (r.toCall > 0) kv.push(['Needed to call', pct(r.potOdds)]);
      kv.push(['Pot', money(r.pot)]);
      kv.push(['Position', r.inPosition ? 'In position' : 'Out of position']);
      if (r.lookahead) kv.push(['Plans ahead', r.street === 3 ? 'Turn and river' : 'River']);
      if (r.solver) kv.push(['River solve', 'Your range vs theirs']);
      if (best.foldPct > 0.02 && (best.kind === 'bet' || best.kind === 'raise' || best.kind === 'allin')) kv.push(['They fold to this', pct(best.foldPct)]);
      html += '<div class="kv">' + kv.map(function (p) { return '<span>' + p[0] + '</span><span>' + p[1] + '</span>'; }).join('') + '</div>';
      html += '<div><div class="sec" data-a="opts">All options ' + (ui.showOptions ? '▾' : '▸') + '</div>';
      if (ui.showOptions) {
        html += '<table>' + r.ranked.map(function (s) {
          var isBest = s.kind === best.kind && s.amount === best.amount;
          var note = sizeNote(s);
          return '<tr class="' + (isBest ? 'best' : '') + '"><td>' + esc(actionText(s, c.heroStageBet, r.toCall)) + (note ? ' <span class="muted">' + esc(note) + '</span>' : '') + '</td>' +
            '<td class="' + (s.ev < 0 ? 'neg' : s.ev > 0 ? 'pos' : '') + '">' + (s.ev >= 0 ? '+' : '−') + money(Math.abs(s.ev)) + '</td></tr>';
        }).join('') + '</table>';
      }
      html += '</div>';
      html += readsHtml(r.opponents.map(function (o) {
        return { name: o.name, type: o.type.label, tip: o.type.key !== 'unknown' ? o.type.tip : '', hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, ftb: o.stats.foldToBet, likely: o.topClasses.slice(0, 5).join(' '), summary: o.summary, bluffChance: o.bluffChance };
      }));
    } else {
      if (!thinking) html += '<div class="status">' + esc(status) + '</div>';
      html += readsHtml(liveReads());
    }
    var n = Object.keys(tracker.db.players).length;
    html += '<div class="ft"><select>' + ['tight', 'typical', 'loose'].map(function (s) {
      return '<option value="' + s + '"' + (ui.tableStyle === s ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + ' table</option>';
    }).join('') + '</select><span style="flex:1"></span><button class="btn" data-a="log">Hand log</button> <button class="btn" data-a="reset">Reset reads</button></div>';
    html += '<div class="muted">Tracking ' + n + ' player' + (n === 1 ? '' : 's') + '. Reads sharpen as hands pile up.</div>';
    body.innerHTML = html;
    place();
  }

  // ---------- solver ----------
  function requestAdvice() {
    var built = tracker.solverInput(ui.tableStyle);
    if (built.error) { status = built.error; render(); return; }
    var id = ++reqId;
    thinking = true;
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
    else if (type === 'hand') { advice = null; thinking = false; reqId++; status = 'New hand. Waiting for your turn…'; render(); }
    else if (type === 'handEnd') { if (advice) advice.stale = true; thinking = false; reqId++; status = 'Hand over. Waiting for the next one…'; render(); }
    else if (type === 'turn') {
      if (p.isHero) requestAdvice();
      else if (advice && !advice.stale) { advice.stale = true; render(); }
    } else if (type === 'heroDone') { reqId++; thinking = false; if (advice) advice.stale = true; render(); }
    else if (type === 'action' || type === 'street' || type === 'cards') { if (ui.expanded) render(); }
  });

  // ---------- reading the game ----------
  var WANTED = {
    'game:stage_began': 1, 'game:dealer_updated': 1, 'game:small_blind_paid': 1, 'game:big_blind_paid': 1,
    'game:cards_dealt_to_player': 1, 'game:card_dealt_to_player': 1, 'game:update_card_data': 1,
    'game:cards_deal_to_stack': 1, 'game:card_deal_to_stack': 1, 'player:game:action_taken': 1,
    'game:player_turn_started': 1, 'game:player_turn_ended': 1, 'game:game_ended': 1, 'admin:game:game_stopped': 1
  };
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
    if (snap.tableType && snap.tableType !== 'private') {
      if (!blocked) { blocked = true; status = 'Patio Solver only runs in private lobbies with friends. It stays off at public tables.'; render(); }
      return;
    }
    blocked = false;
    try { tracker.handle(ev, data, snap); } catch (err) { /* keep the table running */ }
  }
  var hooked = null;
  setInterval(function () {
    var gm = W.GameManager, sock = gm && gm.socket;
    if (!sock || sock === hooked || typeof sock.onAny !== 'function') return;
    hooked = sock;
    // Other table events go to the tracker only for the hand log's raw recorder.
    sock.onAny(function (ev, data) {
      if (WANTED[ev] || (ev === 'chat_message' ? !!(data && data.msgType === 'game_log') : /^(game:|player:game:|admin:game:)/.test(ev))) onEvent(ev, data);
    });
    tracker.snap = snapshot();
    if (tracker.snap.tableType && tracker.snap.tableType !== 'private') { blocked = true; status = 'Patio Solver only runs in private lobbies with friends. It stays off at public tables.'; }
    else if (!tracker.hand) status = 'Connected. Advice starts next hand.';
    render();
  }, 300);

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    W.addEventListener('resize', place);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
