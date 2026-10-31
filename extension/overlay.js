// The on-screen panel. Receives table events from hook.js, keeps reads on every
// player, and asks the solver (background.js) for advice when it's your turn.
(function () {
  'use strict';
  if (window.__patioSolverOverlay) return;
  window.__patioSolverOverlay = true;

  const TEST = globalThis.__PS_TEST || null; // used only for in-page testing
  const store = TEST ? TEST.store : {
    get: (k) => new Promise((res) => chrome.storage.local.get(k, (v) => res(v[k]))),
    set: (k, v) => new Promise((res) => chrome.storage.local.set({ [k]: v }, res)),
  };
  const analyze = TEST ? TEST.analyze : (input) => new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'analyze', input }, (r) => {
        if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
        else res(r || { ok: false, error: 'No answer from the solver.' });
      });
    } catch (e) {
      res({ ok: false, error: 'Extension was reloaded. Refresh this page.' });
    }
  });

  const DB_KEY = 'patioSolverDb';
  const UI_KEY = 'patioSolverUi';

  let tracker = null;
  let ui = { tableStyle: 'typical', x: null, y: 80, collapsed: false, showOptions: true };
  let status = 'Connecting to the table…';
  let advice = null; // { result, ctx, forHandStreet, stale }
  let thinking = false;
  let blocked = false;
  let reqId = 0;

  // ---------- formatting ----------
  const money = (x) => '$' + Math.round(x).toLocaleString('en-US');
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SUITSYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
  const cardHtml = (c) => `<span class="cd ${c[1] === 'h' || c[1] === 'd' ? 'red' : ''}">${c[0] === 'T' ? '10' : c[0]}${SUITSYM[c[1]]}</span>`;

  function actionText(sc, heroStageBet, toCall) {
    if (!sc) return '';
    if (sc.kind === 'fold') return 'Fold';
    if (sc.kind === 'check') return 'Check';
    if (sc.kind === 'call') return 'Call ' + money(sc.amount);
    if (sc.kind === 'allin') return sc.amount <= toCall + 1e-9 ? 'Call all-in ' + money(sc.amount) : 'All-in ' + money(heroStageBet + sc.amount);
    if (sc.kind === 'bet' && heroStageBet <= 0) return 'Bet ' + money(sc.amount);
    return 'Raise to ' + money(heroStageBet + sc.amount);
  }
  function tone(sc) {
    if (!sc) return '';
    if (sc.kind === 'fold') return 'fold';
    if (sc.kind === 'check' || sc.kind === 'call') return 'passive';
    return 'aggr';
  }

  // ---------- DOM ----------
  const host = document.createElement('div');
  host.id = 'patio-solver-host';
  host.style.cssText = 'position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    .panel { position: fixed; width: 300px; max-height: calc(100vh - 20px); overflow: auto;
      background: rgba(18,22,20,.94); color: #eef2ef; border: 1px solid rgba(255,255,255,.14);
      border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: move; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,.08); }
    .hd b { font-size: 13px; letter-spacing: .02em; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; flex: none; }
    .dot.live { background: #3fcf6e; } .dot.turn { background: #ffcc33; box-shadow: 0 0 8px #ffcc33; }
    .hd .sp { flex: 1; }
    .btn { background: rgba(255,255,255,.08); color: inherit; border: 0; border-radius: 6px; padding: 3px 8px;
      font: inherit; font-size: 12px; cursor: pointer; }
    .btn:hover { background: rgba(255,255,255,.16); }
    .bd { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .status { color: #aab3ad; font-size: 12px; }
    .rec { border-radius: 10px; padding: 10px 12px; background: rgba(255,255,255,.06); }
    .rec .act { font-size: 22px; font-weight: 700; line-height: 1.15; }
    .rec.aggr .act { color: #4be08a; } .rec.passive .act { color: #6cb8ff; } .rec.fold .act { color: #ff7a7a; }
    .rec .sub { color: #c4ccc6; font-size: 12px; margin-top: 3px; }
    .rec.stale { opacity: .45; }
    .badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 99px; background: rgba(255,204,51,.18); color: #ffd866; margin-left: 6px; vertical-align: middle; }
    .hand { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .cd { display: inline-block; background: #f4f4f0; color: #111; border-radius: 4px; padding: 0 4px; font-weight: 700; font-size: 12px; }
    .cd.red { color: #c81e1e; }
    .muted { color: #95a09a; font-size: 12px; }
    .kv { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; font-size: 12px; }
    .kv span:nth-child(even) { text-align: right; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 2px 0; font-variant-numeric: tabular-nums; }
    td:last-child { text-align: right; }
    tr.best td { color: #fff; font-weight: 700; }
    .neg { color: #ff9a9a; } .pos { color: #8ff0b4; }
    .sec { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8c968f; margin-bottom: 4px; }
    .opp { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.06); }
    .opp:first-of-type { border-top: 0; }
    .opp .nm { font-weight: 600; }
    .opp .ty { font-size: 11px; padding: 1px 6px; border-radius: 99px; background: rgba(255,255,255,.1); margin-left: 4px; }
    .opp .tip { color: #aab3ad; font-size: 11.5px; margin-top: 2px; }
    .ft { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,.08); }
    select { background: rgba(255,255,255,.08); color: inherit; border: 0; border-radius: 6px; padding: 3px 4px; font: inherit; font-size: 12px; }
    select option { color: #111; }
    .spin { display: inline-block; width: 10px; height: 10px; border: 2px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -1px; margin-right: 6px; }
    @keyframes s { to { transform: rotate(360deg); } }
  </style>
  <div class="panel">
    <div class="hd"><span class="dot"></span><b>Patio Solver</b><span class="sp"></span>
      <button class="btn" data-a="collapse">–</button></div>
    <div class="bd"></div>
    <div class="ft">
      <span class="muted">Table</span>
      <select data-a="style"><option value="tight">Tight</option><option value="typical">Typical</option><option value="loose">Loose</option></select>
      <span class="sp" style="flex:1"></span>
      <button class="btn" data-a="log">Hand log</button>
      <button class="btn" data-a="reset">Reset reads</button>
    </div>
  </div>`;
  const panel = root.querySelector('.panel');
  const body = root.querySelector('.bd');
  const dot = root.querySelector('.dot');
  const foot = root.querySelector('.ft');
  const styleSel = root.querySelector('select');

  function place() {
    const x = ui.x == null ? window.innerWidth - 316 : Math.min(Math.max(0, ui.x), window.innerWidth - 120);
    const y = Math.min(Math.max(0, ui.y), window.innerHeight - 40);
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  // Drag by the header.
  (function drag() {
    const hd = root.querySelector('.hd');
    let sx, sy, ox, oy, on = false;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener('pointermove', (e) => {
      if (!on) return;
      ui.x = ox + e.clientX - sx; ui.y = oy + e.clientY - sy; place();
    });
    hd.addEventListener('pointerup', () => { if (on) { on = false; store.set(UI_KEY, ui); } });
  })();

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const what = a.getAttribute('data-a');
    if (what === 'collapse') {
      ui.collapsed = !ui.collapsed; store.set(UI_KEY, ui); render();
    } else if (what === 'log') {
      if (!tracker) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(tracker.db.history || [], null, 1)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'patio-hand-log.json';
      root.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else if (what === 'reset') {
      if (!tracker) return;
      if (a.dataset.confirm !== '1') { a.dataset.confirm = '1'; a.textContent = 'Sure? Click again'; setTimeout(() => { a.dataset.confirm = ''; a.textContent = 'Reset reads'; }, 3000); return; }
      tracker.db = { players: {} };
      store.set(DB_KEY, tracker.db);
      a.dataset.confirm = ''; a.textContent = 'Reset reads';
      render();
    } else if (what === 'toggleOpts') {
      ui.showOptions = !ui.showOptions; store.set(UI_KEY, ui); render();
    }
  });
  styleSel.addEventListener('change', () => {
    ui.tableStyle = styleSel.value; store.set(UI_KEY, ui);
    if (advice && !advice.stale) requestAdvice();
  });

  // ---------- rendering ----------
  function oppReadsHtml(list) {
    if (!list.length) return '';
    return `<div><div class="sec">Reads</div>${list.map((o) => `
      <div class="opp"><span class="nm">${esc(o.name)}</span><span class="ty">${esc(o.type)}</span>
        <div class="muted">${Math.round(o.hands)} hand${Math.round(o.hands) === 1 ? '' : 's'} · VPIP ${pct(o.vpip)} · PFR ${pct(o.pfr)} · folds to bets ${pct(o.ftb)}${o.likely ? ' · likely ' + esc(o.likely) : ''}</div>
        ${o.summary ? `<div class="muted">${esc(o.summary)}</div>` : ''}
        ${o.bluffChance != null ? `<div class="tip">Bluffing here about ${pct(o.bluffChance)} of the time</div>` : ''}
        ${o.tip ? `<div class="tip">${esc(o.tip)}</div>` : ''}</div>`).join('')}</div>`;
  }

  function liveReads() {
    if (!tracker || !tracker.hand || !window.PokerEngine) return [];
    const heroId = tracker.heroId();
    const out = [];
    for (const p of Object.values(tracker.hand.players)) {
      if (p.id === heroId) continue;
      const r = tracker.db.players[p.auth];
      const tally = Object.assign(PatioTracker.blankTally(), r ? r.tally : {});
      const st = PokerEngine.computeStats(tally, ui.tableStyle, tracker.poolTally());
      const ty = PokerEngine.classifyPlayer(st);
      out.push({ name: p.name + (p.folded ? ' (folded)' : ''), type: ty.label, tip: '', hands: st.hands, vpip: st.raw.vpip, pfr: st.raw.pfr, ftb: st.raw.foldToBet, summary: PokerEngine.readSummary(st) });
    }
    return out;
  }

  function render() {
    styleSel.value = ui.tableStyle;
    dot.className = 'dot' + (blocked ? '' : advice && !advice.stale || thinking ? ' turn' : tracker && tracker.snap ? ' live' : '');
    root.querySelector('[data-a="collapse"]').textContent = ui.collapsed ? '+' : '–';
    body.style.display = ui.collapsed ? 'none' : '';
    foot.style.display = ui.collapsed || blocked ? 'none' : '';
    if (ui.collapsed) {
      if (advice && !advice.stale) {
        const r = advice.result;
        root.querySelector('.hd b').textContent = actionText(r.best, advice.ctx.heroStageBet, r.toCall);
      } else root.querySelector('.hd b').textContent = 'Patio Solver';
      return;
    }
    root.querySelector('.hd b').textContent = 'Patio Solver';
    if (blocked) { body.innerHTML = `<div class="status">${esc(status)}</div>`; return; }

    const h = tracker && tracker.hand;
    let html = '';
    const heroCards = h ? h.heroUids.map((u) => h.heroCards[u]).filter(Boolean) : [];
    if (heroCards.length || (h && h.board.length)) {
      html += `<div class="hand">${heroCards.map(cardHtml).join('')}${h.board.length ? '<span class="muted">&nbsp;board</span>' + h.board.map(cardHtml).join('') : ''}</div>`;
    }

    if (thinking && !(advice && !advice.stale)) {
      html += `<div class="rec"><div class="sub"><span class="spin"></span>Working out your best move…</div></div>`;
    }
    if (advice) {
      const r = advice.result, c = advice.ctx;
      const best = r.best;
      const evLine = best.kind === 'fold' ? 'Every other option loses chips' : (best.ev >= 0 ? '+' : '−') + money(Math.abs(best.ev)) + ' expected';
      html += `<div class="rec ${tone(best)} ${advice.stale ? 'stale' : ''}">
        <div class="act">${esc(actionText(best, c.heroStageBet, r.toCall))}${r.close ? '<span class="badge">close</span>' : ''}</div>
        <div class="sub">${best.sizeLabel && best.sizeLabel !== 'raise' ? esc(best.sizeLabel) + ' · ' : ''}${evLine}${advice.stale ? ' · last turn' : ''}</div>
        ${r.mix ? `<div class="sub">Close spot, so mix it up: ${r.mix.map((m) => esc(m.label) + ' ' + pct(m.freq)).join(' · ')}. This time: ${esc(best.label)}.</div>` : ''}
      </div>`;
      const kv = [];
      if (r.hero) kv.push(['Your hand', esc(r.hero.made + (r.hero.draws && r.hero.draws.length ? ' + ' + r.hero.draws.map((d) => d.name.toLowerCase()).join(', ') : '') + (r.street === 0 && r.hero.topPercent != null ? ` (top ${Math.max(1, Math.round(r.hero.topPercent))}%)` : ''))]);
      if (r.equity) kv.push(['Equity vs their ranges', pct(r.equity.share)]);
      if (r.toCall > 0) kv.push(['Needed to call', pct(r.potOdds)]);
      kv.push(['Pot', money(r.pot)]);
      kv.push(['Position', r.inPosition ? 'In position (you act last)' : 'Out of position']);
      if (r.lookahead) kv.push(['Plans ahead', r.street === 3 ? 'Turn and river' : 'River']);
      if (r.solver) kv.push([{ preflop: 'Preflop solve', turn: 'Turn + river solve', river: 'River solve' }[r.solver.kind] || 'Solve', r.solver.field ? 'Your range vs the field' : 'Your range vs theirs']);
      if (advice.ms != null) kv.push(['Thinking', `${(advice.ms / 1000).toFixed(1)}s on ${advice.workers || 1} core${advice.workers > 1 ? 's' : ''}`]);
      if (best.foldPct > 0.02 && (best.kind === 'bet' || best.kind === 'raise' || best.kind === 'allin')) kv.push(['They fold to this', pct(best.foldPct)]);
      html += `<div class="kv">${kv.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('')}</div>`;

      html += `<div><div class="sec" style="cursor:pointer" data-a="toggleOpts">All options ${ui.showOptions ? '▾' : '▸'}</div>`;
      if (ui.showOptions) {
        html += `<table>${r.ranked.map((s) => `<tr class="${s === r.ranked.find((x) => x.kind === best.kind && x.amount === best.amount) ? 'best' : ''}">
          <td>${esc(actionText(s, c.heroStageBet, r.toCall))}${s.sizeLabel && s.sizeLabel !== 'raise' ? ' <span class="muted">' + esc(s.sizeLabel) + '</span>' : ''}${s.freq != null ? ' <span class="muted">· play ' + pct(s.freq) + '</span>' : ''}</td>
          <td class="${s.ev < 0 ? 'neg' : s.ev > 0 ? 'pos' : ''}">${s.ev >= 0 ? '+' : '−'}${money(Math.abs(s.ev))}</td></tr>`).join('')}</table>`;
      }
      html += `</div>`;
      html += oppReadsHtml(r.opponents.map((o) => ({
        name: o.name, type: o.type.label, tip: o.type.key !== 'unknown' ? o.type.tip : '', hands: o.stats.hands,
        vpip: o.stats.vpip, pfr: o.stats.pfr, ftb: o.stats.foldToBet, likely: o.topClasses.slice(0, 5).join(' '),
        summary: o.summary, bluffChance: o.bluffChance,
      })));
    } else {
      if (!thinking) html += `<div class="status">${esc(status)}</div>`;
      html += oppReadsHtml(liveReads());
    }
    const n = tracker ? Object.keys(tracker.db.players).length : 0;
    html += `<div class="muted">Tracking ${n} player${n === 1 ? '' : 's'}. Reads sharpen as hands pile up.</div>`;
    body.innerHTML = html;
  }

  // ---------- solver ----------
  async function requestAdvice() {
    const built = tracker.solverInput(ui.tableStyle);
    if (built.error) { status = built.error; render(); return; }
    const id = ++reqId;
    thinking = true;
    if (advice) advice.stale = true;
    render();
    const res = await analyze(built.input);
    if (id !== reqId) return;
    thinking = false;
    if (!res || !res.ok) { status = 'Solver error: ' + (res && res.error); advice = null; render(); return; }
    advice = { result: res.result, ctx: built, stale: false, ms: res.ms, workers: res.workers };
    tracker.noteAdvice(actionText(res.result.best, built.heroStageBet, res.result.toCall), res.result.best.ev || 0, res.result, function (sc) { return actionText(sc, built.heroStageBet, res.result.toCall); });
    render();
  }

  // ---------- wiring ----------
  async function start() {
    const saved = await store.get(UI_KEY);
    if (saved) ui = Object.assign(ui, saved);
    const db = (await store.get(DB_KEY)) || { players: {} };
    tracker = new PatioTracker(db);
    tracker.scorer = (show, tally) => PokerEngine.scoreShow(show, tally, ui.tableStyle, tracker.poolTally());
    tracker.predictor = PokerEngine.makePredictor(() => ui.tableStyle, () => tracker.poolTally());
    tracker.fitVersion = PokerEngine.FIT_VERSION;
    tracker.on((type) => {
      if (type === 'save') store.set(DB_KEY, tracker.db);
      if (type === 'hand') { advice = null; thinking = false; reqId++; status = 'New hand. Waiting for your turn…'; render(); }
      if (type === 'turn') { /* handled below with payload */ }
      if (type === 'handEnd') { if (advice) advice.stale = true; thinking = false; reqId++; status = 'Hand over. Waiting for the next one…'; render(); }
      if (type === 'action' || type === 'street' || type === 'cards') render();
    });
    tracker.on((type, p) => {
      if (type === 'turn' && p.isHero) requestAdvice();
      else if (type === 'turn' && advice && !advice.stale) { advice.stale = true; render(); }
      if (type === 'heroDone') { reqId++; thinking = false; if (advice) advice.stale = true; render(); }
    });

    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.source !== 'patio-solver-hook') return;
      const { ev, data, snap } = e.data;
      if (snap && snap.tableType && snap.tableType !== 'private') {
        blocked = true;
        status = 'Patio Solver only runs in private lobbies you play with friends. It stays off at public tables.';
        render();
        return;
      }
      blocked = false;
      if (ev === 'hook:attached' || ev === 'hook:snapshot') {
        tracker.snap = snap;
        if (!tracker.hand) status = 'Connected. Advice starts with the next hand.';
        render();
        return;
      }
      tracker.handle(ev, data, snap);
    });

    (document.body || document.documentElement).appendChild(host);
    place();
    window.addEventListener('resize', place);
    render();
    window.postMessage({ source: 'patio-solver-overlay', type: 'snapshot' }, location.origin);
  }

  start();
})();
