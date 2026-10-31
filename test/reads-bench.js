// Read-accuracy benchmark. Replays exported hand logs in time order and scores how well
// the reads predict each opponent's actions and shown hands, using only earlier hands.
//
//   node test/reads-bench.js [--engine=path/to/engine.js] [--by=player] [--from=ISO time] log.json [more.json ...]
// --from scores only hands from that time on (earlier hands still build the reads), e.g. to score a
// new log the priors were not fitted on.
//
// Scores (lower log-loss / higher show likelihood is better):
//   pf     preflop: fold (or check), call, raise for the hand, by position (VPIP / PFR)
//   open   postflop, nobody has bet yet: check or bet (c-bet spots use the c-bet rate)
//   face   postflop, facing a bet: fold, call or raise (by bet size when the log has sizes)
//   vs open  first response to a single open raise, by its size (new-format logs; not in "all")
//   show   shown hands: how much likelier the shown hand was under the predicted range than
//          a random hand (geometric mean ratio, 1.0 = no better than a guess) and how often it
//          sat in the likelier half of the range ("hits", 50% = calibrated)
// Results are split by how many hands of that player had been seen before ("seen 0-9" etc.),
// which is the part that matters for reading new or rarely seen friends.
//
// Logs in the new format (with `raw`) are replayed through the real tracker, so every tally
// the engine uses is built exactly as at the table. Older logs (action names only) build a
// simpler tally from each player's per-street actions.
const fs = require('fs');
const path = require('path');
const T = require('../src/tracker.js');

const args = process.argv.slice(2);
const opt = {};
const files = [];
for (const a of args) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] == null ? true : m[2];
  else files.push(a);
}

function loadHands(list) {
  const seen = new Set();
  const hands = [];
  for (const f of list) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(data) ? data : data.history || [];
    for (const h of arr) {
      const key = h.t + ':' + (h.hero || []).join('');
      if (seen.has(key)) continue;
      seen.add(key);
      hands.push(h);
    }
  }
  hands.sort((a, b) => a.t - b.t);
  return hands;
}

const PF_RANK = { fold: 0, check: 0, call: 1, raise: 2, '3bet': 2, '4bet': 2, '5bet': 2 };
function pfCat(seq) {
  let best = -1;
  for (const a of seq || []) if (PF_RANK[a] != null && PF_RANK[a] > best) best = PF_RANK[a];
  return best < 0 ? null : ['fold', 'call', 'raise'][best];
}

// Every opponent decision in a hand, in a model-neutral form.
function decisions(h) {
  const out = [];
  const heroName = (h.players.find((p) => p.hero) || {}).name;
  const opps = h.players.filter((p) => !p.hero);
  const pfAgg = (() => {
    if (h.log) {
      let who = null;
      for (const e of h.log) if (e.st === 'pre' && (e.act === 'raise' || e.act === '3bet' || e.act === '4bet' || e.act === '5bet')) who = e.who;
      return who;
    }
    const by = (k) => h.players.find((p) => (p.actions.pre || []).includes(k));
    const p = by('5bet') || by('4bet') || by('3bet') || by('raise');
    return p ? p.name : null;
  })();
  const nDealt = h.players.length;
  // Re-raised preflop (3-bet or more): such players fold less after the flop.
  const reraisedBy = {};
  for (const p of h.players) {
    const pre = p.actions.pre || [];
    reraisedBy[p.name] = pre.some((a) => /^\dbet$/.test(a)) || pre.filter((a) => a === 'raise').length >= 2;
  }
  for (const p of opps) {
    const c = pfCat(p.actions.pre);
    if (c) out.push({ name: p.name, kind: 'pf', out: c, pos: p.position, n: nDealt });
  }
  // First response to a single open raise, by its size (stats.vsOpen): new-format logs only.
  if (h.log && h.bigBlind > 0) {
    let raises = 0;
    const acted = {};
    for (const e of h.log) {
      if (e.st !== 'pre') break;
      if (e.act === 'sb' || e.act === 'bb') continue;
      const first = !acted[e.who];
      acted[e.who] = true;
      const isRaise = /^(raise|\dbet)$/.test(e.act);
      if (first && raises === 1 && !e.hero && e.who !== heroName && (e.act === 'fold' || e.act === 'call' || isRaise)) {
        const toBB = ((e.to || 0) - (e.amt || 0) + (e.facing || 0)) / h.bigBlind;
        out.push({ name: e.who, kind: 'vo', toBB, out: isRaise ? 'raise' : e.act, pos: (h.players.find((x) => x.name === e.who) || {}).position });
      }
      if (isRaise) raises++;
    }
  }
  if (h.log) {
    const flopBet = {};
    const firstOnStreet = {};
    const live = new Set(h.players.map((p) => p.name));
    for (const e of h.log) {
      const mw = live.size >= 3;
      if (e.act === 'fold') live.delete(e.who);
      if (e.st === 'pre' || e.hero || e.who === heroName) {
        if (e.st !== 'pre' && (e.act === 'bet' || e.act === 'raise')) flopBet[e.st] = true;
        continue;
      }
      const n = { flop: 3, turn: 4, river: 5 }[e.st];
      const key = e.st + ':' + e.who;
      const first = !firstOnStreet[key];
      firstOnStreet[key] = true;
      const pos = (h.players.find((x) => x.name === e.who) || {}).position;
      if (e.facing > 0 && (e.act === 'fold' || e.act === 'call' || e.act === 'raise')) {
        const frac = e.pot - e.facing > 0 ? e.facing / (e.pot - e.facing) : null;
        out.push({ name: e.who, kind: 'face', n, out: e.act, frac, aggLine: false, pos, mw, reraised: reraisedBy[e.who] });
      } else if (!(e.facing > 0) && (e.act === 'check' || e.act === 'bet')) {
        out.push({ name: e.who, kind: 'open', n, out: e.act, cbet: n === 3 && first && !flopBet[e.st] && pfAgg === e.who, pos, mw });
      }
      if (e.act === 'bet' || e.act === 'raise') flopBet[e.st] = true;
    }
  } else {
    // Without the action order, a street is multiway when three or more players started it.
    const streets = [['pre', 0], ['flop', 3], ['turn', 4], ['river', 5]];
    const liveAt = (si) => h.players.filter((p) => streets.slice(0, si).every(([k]) => !(p.actions[k] || []).includes('fold'))).length;
    for (const p of opps) {
      streets.slice(1).forEach(([st, n], j) => {
        const mw = liveAt(j + 1) >= 3;
        (p.actions[st] || []).forEach((a, i) => {
          if (i === 0 && (a === 'check' || a === 'bet')) out.push({ name: p.name, kind: 'open', n, out: a, cbet: n === 3 && pfAgg === p.name, pos: p.position, mw });
          else if (a === 'call' || a === 'fold' || a === 'raise') out.push({ name: p.name, kind: 'face', n, out: a, frac: null, pos: p.position, mw, reraised: reraisedBy[p.name] });
        });
      });
    }
  }
  // Facing decisions after the player bet or raised earlier in the hand.
  const aggSoFar = {};
  const order = h.log ? h.log.filter((e) => e.st !== 'pre' && !e.hero) : null;
  if (order) {
    let di = 0;
    const post = out.filter((d) => d.kind !== 'pf');
    for (const e of order) {
      if (e.act !== 'check' && e.act !== 'bet' && e.act !== 'call' && e.act !== 'fold' && e.act !== 'raise') continue;
      const d = post[di];
      if (!d || d.name !== e.who) continue;
      di++;
      if (d.kind === 'face') d.aggLine = !!aggSoFar[e.who];
      if (e.act === 'bet' || e.act === 'raise') aggSoFar[e.who] = true;
    }
  } else {
    for (const p of opps) {
      let agg = false;
      for (const d of out.filter((x) => x.name === p.name && x.kind !== 'pf')) {
        if (d.kind === 'face') d.aggLine = agg;
        if (d.out === 'bet' || d.out === 'raise') agg = true;
      }
    }
  }
  return { list: out, pfAgg };
}

// Shown hands with the line that led to them.
function shows(h, pfAgg) {
  const out = [];
  if (!h.board || h.board.length < 3) return out;
  for (const p of h.players) {
    if (p.hero || !p.shown || p.shown.length !== 2) continue;
    const actions = { pre: T.streetAction(p.actions.pre || [], 0) };
    for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = T.streetAction(p.actions[k] || [], n);
    if (actions.pre === 'pending') actions.pre = 'call';
    const sizes = {};
    if (h.log) for (const e of h.log) if (e.who === p.name && e.st !== 'pre' && (e.act === 'bet' || e.act === 'raise') && e.potPct != null) sizes[e.st] = e.potPct / 100;
    out.push({ name: p.name, cards: p.shown.slice(), board: h.board.slice(), dead: (h.hero || []).slice(), actions, sizes, pfAggressor: pfAgg === p.name, position: p.position, folded: !!p.folded });
  }
  return out;
}

// ---------- tallies for old-format hands (no raw events) ----------
let DECAY_F = T.DECAY;
function decayTally(t) {
  for (const k of Object.keys(t)) {
    if (k === 'shows') continue;
    if (typeof t[k] === 'number') t[k] *= DECAY_F;
    else if (t[k] && typeof t[k] === 'object') decayTally(t[k]);
  }
}
function simpleUpdate(db, h, dec, scorer) {
  const rec = (name) => {
    let r = db.players[name];
    if (!r) r = db.players[name] = { name, tally: T.blankTally() };
    else T.upgradeTally(r.tally);
    return r;
  };
  for (const p of h.players) if (!p.hero) decayTally(rec(p.name).tally);
  for (const d of dec.list) {
    const t = rec(d.name).tally;
    if (d.kind === 'vo') continue;
    if (d.kind === 'pf') {
      t[{ fold: 'pfFold', call: 'pfCall', raise: 'pfRaise' }[d.out]]++;
      const g = t.pos[d.pos];
      if (g) { g.n++; if (d.out !== 'fold') g.vpip++; if (d.out === 'raise') g.pfr++; }
      continue;
    }
    const key = { 3: 'flop', 4: 'turn', 5: 'river' }[d.n];
    t[d.out]++;
    t.st[key][d.out]++;
    if (d.mw && t.stMw) t.stMw[key][d.out]++;
    if (d.kind === 'open' && d.cbet) { t.cbetOpp++; if (d.out === 'bet') t.cbet++; }
    if (d.kind === 'face' && d.aggLine) { t.aggVsN++; if (d.out === 'fold') t.aggVsFold++; }
  }
  const live = h.players.filter((p) => !p.folded).length;
  for (const p of h.players) {
    if (p.hero) continue;
    const t = rec(p.name).tally;
    const saw = (h.board || []).length >= 3 && ((p.actions.flop || []).length > 0 || !p.folded);
    if (saw) t.sawFlop++;
    if (saw && !p.folded && live >= 2) t.wtsd++;
  }
  for (const s of shows(h, dec.pfAgg)) {
    const t = rec(s.name).tally;
    const p = h.players.find((x) => x.name === s.name);
    const agg = [];
    for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) for (const a of p.actions[k] || []) if (a === 'bet' || a === 'raise') agg.push({ n, frac: s.sizes[k] != null ? s.sizes[k] : 0.6 });
    const show = { cards: s.cards, board: s.board, agg, actions: s.actions, sizes: s.sizes, ms: [], pfAggressor: s.pfAggressor, position: s.position };
    if (s.folded) show.folded = true;
    if (scorer) { try { show.fit = scorer(show, t); } catch (e) { /* optional */ } }
    t.shows.push(show);
    if (t.shows.length > 80) t.shows.splice(0, t.shows.length - 80);
  }
}

// ---------- replaying raw events through the tracker ----------
function rawUpdate(tracker, h) {
  const heroName = (h.players.find((p) => p.hero) || {}).name;
  let snap = tracker.snap;
  for (const r of h.raw) {
    if (r.s) {
      snap = {
        tableType: 'private', heroAuthId: heroName, bigBlind: r.bb || h.bigBlind,
        players: r.s.map(([id, name, stack, pos, state]) => ({ id, authUserId: name, name, stack, posType: pos, playState: state })),
      };
    }
    tracker.handle(r.ev, r.d, snap);
  }
  // Close the hand, as the next hand's set_blinds would.
  if (tracker.hand && !tracker.hand.finished) tracker.finishHand();
}

// ---------- models ----------
function makeModel(enginePath) {
  const E = require(path.resolve(enginePath));
  const name = path.basename(path.dirname(path.resolve(enginePath))) + '/' + path.basename(enginePath);
  const eqFold = (f) => f / (1 + f);
  // Engines without predictAction: read the probabilities off the stats the engine uses,
  // with the exploitation blend toward balanced play taken back out (that blend is a
  // decision-making choice, not a prediction).
  function fallbackPredict(st, d) {
    const p = st.exploitWeight || 1;
    const unmix = (x, eq) => Math.min(0.99, Math.max(0.01, (x - (1 - p) * eq) / p));
    if (d.kind === 'pf') {
      const g = d.pos && st.byPos && st.byPos[d.pos] ? st.byPos[d.pos] : st;
      return { fold: 1 - g.vpip, call: g.vpip - g.pfr, raise: g.pfr };
    }
    if (d.kind === 'vo') {
      // The size-blind rule older engines use for a player facing an open (continueRule).
      const mdf = 1.5 / (1.5 + d.toBB), sizeFactor = Math.min(1, 6 / Math.max(1, d.toBB));
      const big = Math.min(1, Math.max(0, (d.toBB - 4) / 4)), callBig = st.callBig != null ? st.callBig : 0.25;
      let cont = Math.max(Math.min(st.vpip, st.vpip * 0.7 * (mdf / 0.375) * Math.sqrt(sizeFactor)), big * callBig);
      cont = Math.min(0.95, Math.max(0.01, cont));
      const rr = Math.min(cont, Math.min(0.12, Math.max(0.02, st.pfr * 0.4)));
      return { fold: 1 - cont, call: cont - rr, raise: rr };
    }
    const bs = st.byStreet[d.n];
    if (d.kind === 'open') {
      const b = d.cbet ? st.cbet : bs.betFreq;
      return { check: 1 - b, bet: b };
    }
    const s2 = Object.assign({}, st, {
      foldToBet: unmix(st.foldToBet, eqFold(0.6)),
      byStreet: {}, foldBySize: {},
    });
    for (const n of [3, 4, 5]) s2.byStreet[n] = Object.assign({}, st.byStreet[n], { foldToBet: unmix(st.byStreet[n].foldToBet, eqFold(0.6)) });
    for (const [k, f] of [['small', 0.33], ['medium', 0.66], ['large', 1.1]]) s2.foldBySize[k] = unmix(st.foldBySize[k], eqFold(f));
    let fold = d.frac != null && E.foldAtSize ? E.foldAtSize(s2, d.frac, d.n) : s2.byStreet[d.n].foldToBet;
    if (d.aggLine && st.foldAfterAgg != null) fold *= Math.min(1, Math.max(0.15, st.foldAfterAgg / Math.max(0.05, s2.foldToBet)));
    const raise = Math.min(bs.raiseFreq, 0.98 - fold);
    return { fold, call: Math.max(0.01, 1 - fold - raise), raise };
  }
  const predict = E.predictAction ? (st, d) => E.predictAction(st, d) : fallbackPredict;
  return { E, name, predict };
}

const SEEN_BUCKETS = [[0, 9], [10, 29], [30, 1e9]];
const bucketOf = (n) => SEEN_BUCKETS.findIndex(([a, b]) => n >= a && n <= b);
const bucketName = (i) => { const [a, b] = SEEN_BUCKETS[i]; return b > 1e8 ? `seen ${a}+` : `seen ${a}-${b}`; };

function run(model, hands, tableStyle, o) {
  o = o || {};
  DECAY_F = o.decay != null ? o.decay : T.DECAY;
  const { E, predict } = model;
  const comboCards = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) comboCards[E.comboIndex(a, b)] = [a, b];
  const tracker = new T({ players: {} });
  if (o.decay != null) tracker.decay = o.decay;
  const nameOf = (tally) => { for (const r of Object.values(tracker.db.players)) if (r.tally === tally) return r.name; return null; };
  const styleOf = (name) => (typeof tableStyle === 'function' ? tableStyle(name) : tableStyle);
  const scorer = (show, tally) => E.scoreShow(show, tally, styleOf(nameOf(tally)), pool());
  tracker.scorer = scorer;
  if (E.makePredictor) tracker.predictor = E.makePredictor(() => styleOf(null), () => pool());
  const db = tracker.db;
  const seen = {};
  const acc = {};
  const add = (kind, b, name, ll) => {
    for (const k of [kind + '|all', kind + '|' + b, kind + '|p:' + name]) {
      const a = acc[k] || (acc[k] = { n: 0, ll: 0, hits: 0 });
      a.n++; a.ll += ll;
    }
  };
  const showAcc = {};
  const addShow = (key, ll, hit) => { const a = showAcc[key] || (showAcc[key] = { n: 0, ll: 0, hits: 0 }); a.n++; a.ll += ll; a.hits += hit ? 1 : 0; };
  const strengthCache = new Map();
  const strengthsFor = (board) => {
    const key = board.join('');
    let s = strengthCache.get(key);
    if (!s) {
      const ids = board.map(E.parseCard);
      s = { 0: E.boardStrength([]) };
      for (const n of [3, 4, 5]) if (ids.length >= n) s[n] = E.boardStrength(ids.slice(0, n));
      strengthCache.set(key, s);
    }
    return s;
  };
  const pool = () => (E.poolTally && o.pool !== false ? E.poolTally(Object.values(db.players).filter((r) => !o.only || r.name !== o.only).map((r) => r.tally)) : null);
  const from = o.from != null ? +new Date(o.from) : -Infinity;
  for (const h of hands) {
    const dec = decisions(h);
    const pooled = pool();
    // Hands before `from` only build the reads (scores count from there on).
    const scoring = !(h.t < from);
    const statsOf = {};
    const st = (name) => {
      if (!statsOf[name]) {
        const r = db.players[name];
        const tally = Object.assign(T.blankTally(), r ? r.tally : {});
        statsOf[name] = E.computeStats(tally, typeof tableStyle === 'function' ? tableStyle(name) : tableStyle, pooled);
      }
      return statsOf[name];
    };
    for (const d of dec.list) {
      const probs = predict(st(d.name), d);
      let tot = 0;
      for (const v of Object.values(probs)) tot += Math.max(0, v);
      const p = Math.max(1e-4, (probs[d.out] || 0) / tot);
      const b = bucketOf(seen[d.name] || 0);
      if (scoring) add(d.kind, b, d.name, -Math.log(p));
    }
    for (const s of shows(h, dec.pfAgg)) {
      if (s.folded) continue;
      const stats = st(s.name);
      const board = s.board.map(E.parseCard);
      const dead = board.concat(s.dead.map(E.parseCard));
      const W = E.buildRange(stats, s.actions, strengthsFor(s.board), dead, s.sizes, s.pfAggressor, s.position);
      const hole = s.cards.map(E.parseCard);
      const k = E.comboIndex(hole[0], hole[1]);
      let tot = 0, live = 0, above = 0, same = 0;
      const deadSet = new Set(dead);
      for (let j = 0; j < 1326; j++) {
        const [a, c] = comboCards[j];
        if (deadSet.has(a) || deadSet.has(c)) continue;
        live++; tot += W[j];
      }
      for (let j = 0; j < 1326; j++) {
        const [a, c] = comboCards[j];
        if (deadSet.has(a) || deadSet.has(c)) continue;
        if (W[j] > W[k] + 1e-12) above += W[j]; else if (Math.abs(W[j] - W[k]) <= 1e-12) same += W[j];
      }
      const ll = Math.log(Math.max(1e-6, W[k] / tot)) - Math.log(1 / live);
      const hit = (above + same / 2) / tot < 0.5;
      const b = bucketOf(seen[s.name] || 0);
      if (scoring) { addShow('all', ll, hit); addShow(String(b), ll, hit); addShow('p:' + s.name, ll, hit); }
    }
    // Learn from the hand.
    if (h.raw && h.raw.length) rawUpdate(tracker, h);
    else simpleUpdate(db, h, dec, scorer);
    for (const p of h.players) if (!p.hero) seen[p.name] = (seen[p.name] || 0) + 1;
  }
  return { acc, showAcc, db };
}

function report(model, res) {
  const { acc, showAcc } = res;
  const fmt = (a) => (a ? (a.ll / a.n).toFixed(3) + ' (' + a.n + ')' : '-');
  const kinds = ['pf', 'open', 'face'];
  const extra = ['vo'];
  const cols = ['all'].concat(SEEN_BUCKETS.map((_, i) => String(i)));
  console.log('\n== ' + model.name);
  console.log('log-loss per decision (n)'.padEnd(26) + cols.map((c) => (c === 'all' ? 'all' : bucketName(+c)).padStart(16)).join(''));
  for (const k of kinds) console.log(k.padEnd(26) + cols.map((c) => fmt(acc[k + '|' + c]).padStart(16)).join(''));
  const tot = (c) => {
    let n = 0, ll = 0;
    for (const k of kinds) { const a = acc[k + '|' + c]; if (a) { n += a.n; ll += a.ll; } }
    return n ? { n, ll } : null;
  };
  console.log('all actions'.padEnd(26) + cols.map((c) => fmt(tot(c)).padStart(16)).join(''));
  for (const k of extra) if (acc[k + '|all']) console.log((k === 'vo' ? 'vs open (by size)' : k).padEnd(26) + cols.map((c) => fmt(acc[k + '|' + c]).padStart(16)).join(''));
  const sf = (a) => (a ? ('x' + Math.exp(a.ll / a.n).toFixed(2) + ' ' + Math.round((100 * a.hits) / a.n) + '%h (' + a.n + ')') : '-');
  console.log('shown hands vs guess'.padEnd(26) + cols.map((c) => sf(showAcc[c]).padStart(16)).join(''));
  if (opt.by === 'player') {
    const names = [...new Set(Object.keys(acc).filter((k) => k.includes('|p:')).map((k) => k.split('|p:')[1]))];
    for (const nm of names) {
      console.log('  ' + nm.padEnd(16) + kinds.map((k) => (k + ' ' + fmt(acc[k + '|p:' + nm])).padStart(20)).join('') + '  show ' + sf(showAcc['p:' + nm]));
    }
  }
}

if (require.main === module) {
  if (!files.length) {
    console.error('usage: node test/reads-bench.js [--engine=path] [--by=player] log.json [...]');
    process.exit(1);
  }
  const hands = loadHands(files);
  const engines = (opt.engine || path.join(__dirname, '../src/engine.js')).split(',');
  console.log(hands.length + ' hands from ' + files.length + ' log(s)');
  for (const ep of engines) {
    const model = makeModel(ep);
    report(model, run(model, hands, opt.style || 'typical', { from: opt.from }));
  }
}

module.exports = { loadHands, decisions, shows, run, makeModel, report };
