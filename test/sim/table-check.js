// Table check (audit 10 Nov, "Better approaches" 1): the rows a bot set must match before the simulator is trusted on a
// question, measured the same way on real hand logs and on simulated ones (fold-cal.js --entries writes the solver's
// hand-log entries of simulated hands). Everything comes from the hand logs alone, no re-solving:
//   A  answers to a first bet after the flop (fold / call / raise, and everyone folded), by street, heads-up or
//      multiway and size, when hero bets and when anyone else does (answers by players other than hero)
//   B  answers to a raise after the flop, hero's raises and everyone else's
//   C  answers to the first raise before the flop (opens and raises over limpers) by raise-to, hero's and others'
//   D  shown strength at river showdowns (the shown hand's share of all hands it beats on the board) by chips in
//   E  what came back against the advice's EV, per hero decision by street (TD: EV at hero's next decision, or what
//      came back, minus chips put in, minus the EV of the action taken; decisions where hero followed the advice)
//   F  hero's result: bb/100 and the advised EV at the first decision
//   G  the size of first bets after the flop by players other than hero, by street and line (after calling a bet on the
//      street before, or not), in the size buckets of A, and below and above half the pot
// Usage:
//   node test/sim/table-check.js --real <exports or folders...> [--sim <entries.json...>] [--seats 2|3|4|5+|3+]
//     [--min 30] [--all] [--match-seats]
// With --sim, each row prints real and simulated side by side with z = (sim - real) / SE; rows with |z| >= 2 are
// marked. --match-seats keeps simulated hands of each table size in the real logs' proportions. --min hides rows with fewer answers (default 20) unless --all. Hands in test/exclude-hands.json are left out
// of the real logs (loadHands).
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'src/engine.js'));
const { loadHands } = require(path.join(ROOT, 'test/merge-logs.js'));

const STREETS = ['flop', 'turn', 'river'];
const sizeB = (pct) => (pct == null ? '?' : pct < 45 ? '<45%' : pct < 85 ? '45-85%' : '85%+');
const toB = (bb) => (bb <= 2.5 ? '<=2.5bb' : bb <= 3.5 ? '2.5-3.5bb' : bb <= 5 ? '3.5-5bb' : bb <= 8 ? '5-8bb' : bb <= 15 ? '8-15bb' : '15bb+');
const putB = (bb) => (bb < 7 ? '<7bb' : bb < 20 ? '7-20bb' : bb < 50 ? '20-50bb' : '50bb+');
// Simulated entries carry no result (the sim resets every stack each hand, and the tracker reads results from the next
// hand's stacks), so for them hero's net is worked out from the hand: chips put in, folds, the shown cards, side pots
// as game.js pays them. Null when a live player's cards are unknown.
let PAY = null;
function netFromHand(h) {
  PAY = PAY || require(path.join(ROOT, 'test/sim/game.js')).payouts;
  const ps = h.players, n = ps.length, board = h.board || [];
  const live = ps.filter((p) => !p.folded);
  const scores = ps.map((p) => {
    if (p.folded) return -1;
    if (live.length < 2) return 0;
    const c = p.hero ? h.hero : p.shown;
    if (!c || c.length !== 2 || board.length !== 5) return null;
    return E.evaluate([...c, ...board].map(E.parseCard), 7);
  });
  if (scores.some((x) => x == null)) return null;
  const back = PAY(ps.map((p) => p.put || 0), ps.map((p) => !!p.folded), scores, new Float64Array(n));
  const i = ps.findIndex((p) => p.hero);
  return back[i] - (ps[i].put || 0);
}
const isRaise = (a) => a === 'raise' || a === '3bet' || a === '4bet' || a === '5bet';

function seatsOk(h, f) {
  const n = (h.players || []).length;
  if (!f) return true;
  if (f.endsWith('+')) return n >= +f.slice(0, -1);
  return f.split(',').map(Number).includes(n);
}

// Share of all two-card hands (not blocked by the board or each other) that `cards` beats on the board, ties half.
const pctCache = new Map();
function beatShare(cards, board) {
  const key = board.join('');
  let all = pctCache.get(key);
  if (!all) {
    const used = new Set(board);
    const deck = [];
    for (const r of E.RANKS) for (const s of E.SUITS) if (!used.has(r + s)) deck.push(r + s);
    const bc = board.map(E.parseCard);
    all = [];
    for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) {
      all.push([deck[i], deck[j], E.evaluate([E.parseCard(deck[i]), E.parseCard(deck[j]), ...bc], 7)]);
    }
    pctCache.set(key, all);
  }
  const me = E.evaluate([...cards, ...board].map(E.parseCard), 7);
  let n = 0, w = 0;
  for (const [a, b, v] of all) {
    if (a === cards[0] || a === cards[1] || b === cards[0] || b === cards[1]) continue;
    n++; w += v < me ? 1 : v === me ? 0.5 : 0;
  }
  return w / n;
}

function measure(hands, opts = {}) {
  const R = {}; // row key -> { n, k: {fold, call, raise, all}, sum, sum2 }
  const cnt = (key, ans) => { const r = R[key] || (R[key] = { n: 0, k: {} }); r.n++; r.k[ans] = (r.k[ans] || 0) + 1; };
  const val = (key, v) => { const r = R[key] || (R[key] = { n: 0, sum: 0, sum2: 0, mean: true }); r.n++; r.sum += v; r.sum2 += v * v; };
  let hands0 = 0;
  for (const h of hands) {
    if (!h || !h.log || !h.players || !seatsOk(h, opts.seats)) continue;
    const bb = h.bigBlind || 2;
    const heroP = h.players.find((p) => p.hero);
    if (!heroP) continue;
    hands0++;
    const log = h.log.filter((x) => x.act);
    // live players by street: everyone dealt in, minus folds so far
    const folded = new Set();
    let raisedPre = false, limpers = 0, curSt = 'pre', inStreet = {}, called = {}, calledPrev = {};
    for (let i = 0; i < log.length; i++) {
      const x = log[i];
      if (x.act === 'sb' || x.act === 'bb') continue;
      if (STREETS.includes(x.st) && x.st !== curSt) { curSt = x.st; inStreet = {}; calledPrev = called; called = {}; }
      const live = h.players.filter((p) => !folded.has(p.name)).length;
      if (x.st === 'pre' && !raisedPre && isRaise(x.act)) {
        // C: answers to the first raise before the flop
        raisedPre = true;
        const who = x.hero ? 'hero' : 'others';
        const kind = limpers ? 'over limpers' : 'open';
        const b = toB((x.to != null ? x.to : x.amt) / bb);
        const ans = [];
        for (let j = i + 1; j < log.length && log[j].st === 'pre'; j++) {
          const y = log[j];
          if (y.who === x.who) break;
          if (!x.hero && y.hero) continue;
          const a = y.act === 'fold' ? 'fold' : isRaise(y.act) ? 'raise' : y.act === 'call' ? 'call' : null;
          if (!a) continue;
          ans.push(a);
          cnt(`C ${who} ${kind} ${b}`, a);
          if (a === 'raise') break;
        }
        if (x.hero && ans.length === live - 1) cnt(`C hero ${kind} ${b} everyone folded`, ans.every((a) => a === 'fold') ? 'yes' : 'no');
      } else if (x.st === 'pre' && !raisedPre && x.act === 'call') limpers++;
      if (STREETS.includes(x.st) && (x.act === 'bet' || isRaise(x.act))) {
        const first = x.act === 'bet';
        const who = x.hero ? 'hero' : 'others';
        const hu = live - 1 === 1 ? 'HU' : 'MW';
        const key = first ? `A ${who} ${x.st} ${hu} ${sizeB(x.potPct)}` : `B ${who} raise ${x.st} ${hu}`;
        if (first && !x.hero && x.potPct != null) {
          const line = x.st !== 'flop' && calledPrev[x.who] ? 'after a call' : 'other';
          cnt(`G others bet size ${x.st} ${line}`, sizeB(x.potPct));
          cnt(`G others bet size ${x.st} ${line} half pot`, x.potPct < 50 ? 'under' : 'over'); // share over half the pot
        }
        const ans = [];
        for (let j = i + 1; j < log.length && log[j].st === x.st; j++) {
          const y = log[j];
          if (y.who === x.who) break;
          if (!x.hero && y.hero) { ans.push('hero'); continue; }
          const a = y.act === 'fold' ? 'fold' : isRaise(y.act) ? 'raise' : y.act === 'call' ? 'call' : null;
          if (!a) continue;
          ans.push(a);
          // a raise is answered by players who already have chips in on the street (the bettor, callers) and by
          // players who don't (cold); the two fold very differently
          cnt(first ? key : key + (inStreet[y.who] ? ' (had bet or called)' : ' (cold)'), a);
          if (a === 'raise') break;
        }
        if (x.hero && ans.length === live - 1) cnt(key + ' everyone folded', ans.every((a) => a === 'fold') ? 'yes' : 'no');
      }
      if (x.act === 'fold') folded.add(x.who);
      if (STREETS.includes(x.st)) {
        if (x.amt > 0) inStreet[x.who] = true;
        // a call of a bet as the player's last action on the street (G: bets after a call)
        if (x.act === 'call') called[x.who] = true;
        else if (x.act === 'bet' || isRaise(x.act)) delete called[x.who];
      }
    }
    // D: shown strength at river showdowns, by the chips the shower put in
    if ((h.board || []).length === 5) {
      const heroIn = !heroP.folded;
      for (const p of h.players) {
        if (p.hero || p.folded || !p.shown || p.shown.length !== 2) continue;
        const s = beatShare(p.shown, h.board);
        const b = putB((p.put || 0) / bb);
        val(`D shown strength ${heroIn ? 'hero in' : 'hero out'} ${b}`, s);
        val(`D shown strength all ${b}`, s);
      }
    }
    // E: TD per hero decision (advice entries aligned to hero's actions by `did`)
    const adv = (h.advice || []).slice();
    const acts = log.map((x, i) => [x, i]).filter(([x]) => x.hero && x.act !== 'sb' && x.act !== 'bb');
    const decs = [];
    let ai = 0;
    for (const [x, i] of acts) {
      const same = (d) => d === x.act || d === x.act + ' ' + (x.amt || 0);
      let k = ai;
      while (k < adv.length && adv[k].did != null && !same(adv[k].did)) k++;
      const a = k < adv.length && same(adv[k].did) ? adv[k] : null;
      if (a) ai = k + 1;
      const putBefore = log.slice(0, i).filter((y) => y.hero).reduce((s, y) => s + (y.amt || 0), 0);
      decs.push({ a, st: x.st, putBefore });
    }
    const heroNet = opts.sim ? netFromHand(h) : h.heroNet;
    if (heroNet != null) {
      for (let d = 0; d < decs.length; d++) {
        const { a, st, putBefore } = decs[d];
        if (!a || !a.followed || a.ev == null) continue;
        let td;
        if (d + 1 < decs.length) {
          const nx = decs[d + 1];
          if (!nx.a || nx.a.ev == null) continue;
          td = nx.a.ev - (nx.putBefore - putBefore) - a.ev;
        } else td = heroNet + putBefore - a.ev;
        val(`E TD ${st}${a.kind ? ' ' + a.kind : ''}`, td / bb);
        val(`E TD ${st}`, td / bb);
      }
      // F: result and the first decision's EV (minus the blinds hero had posted)
      val('F hero result bb/hand', heroNet / bb);
      const posted = log.filter((y) => y.hero && (y.act === 'sb' || y.act === 'bb')).reduce((s, y) => s + y.amt, 0);
      const a0 = decs[0] && decs[0].a;
      if (a0 && a0.ev != null) val('F advised EV at the first decision bb/hand', (a0.ev - posted) / bb);
    }
  }
  return { R, hands: hands0 };
}

function rate(r, ans) {
  const p = (r.k[ans] || 0) / r.n;
  return { p, se: Math.sqrt(Math.max(p * (1 - p), 0.25 / r.n) / r.n) };
}
function mean(r) {
  const m = r.sum / r.n, v = r.n > 1 ? (r.sum2 - r.n * m * m) / (r.n - 1) : 0;
  return { p: m, se: Math.sqrt(Math.max(v, 0) / r.n) };
}

function report(real, sim, opts = {}) {
  const min = opts.all ? 1 : opts.min || 20;
  const keys = [...new Set([...Object.keys(real.R), ...Object.keys((sim || {}).R || {})])].sort();
  const lines = [];
  const f = (x, d = 2) => (x == null ? '' : x.toFixed(d));
  lines.push(`hands: real ${real.hands}` + (sim ? `, sim ${sim.hands}` : ''));
  for (const k of keys) {
    const a = real.R[k], b = sim && sim.R[k];
    if ((a ? a.n : 0) < min && (b ? b.n : 0) < min) continue;
    const isMean = (a || b).mean;
    const outs = isMean ? [null] : k.endsWith('everyone folded') ? ['yes'] : k.endsWith('half pot') ? ['over'] :
      k.startsWith('G ') ? ['<45%', '45-85%', '85%+'] : ['fold', 'call', 'raise'];
    for (const o of outs) {
      const ra = a ? (isMean ? mean(a) : rate(a, o)) : null;
      const rb = b ? (isMean ? mean(b) : rate(b, o)) : null;
      const den = ra && rb ? Math.sqrt(ra.se * ra.se + rb.se * rb.se) : 0;
      const z = den > 0 ? (rb.p - ra.p) / den : null;
      const label = (o && o !== 'yes' ? k + ' : ' + o : k);
      const d = isMean ? 2 : 3;
      lines.push(`${z != null && Math.abs(z) >= 2 ? '!!' : '  '} ${label.padEnd(58)} real ${ra ? f(ra.p, d) + ' ± ' + f(ra.se, d) + ' (' + a.n + ')' : '-'}`.padEnd(92) +
        (sim ? ` sim ${rb ? f(rb.p, d) + ' ± ' + f(rb.se, d) + ' (' + b.n + ')' : '-'}`.padEnd(30) + (z != null ? ` z ${f(z, 1)}` : '') : ''));
    }
  }
  return lines.join('\n');
}

module.exports = { measure, report, beatShare };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const list = (name) => { const i = args.indexOf('--' + name); if (i < 0) return []; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); return out; };
  const realFiles = list('real'), simFiles = list('sim');
  if (!realFiles.length) { console.log('usage: node test/sim/table-check.js --real <logs...> [--sim <entries...>] [--seats 4|3+|2,3] [--min 20] [--all]'); process.exit(1); }
  const seats = opt('seats', null);
  let realHands = loadHands(realFiles, { quiet: true });
  let simHands = simFiles.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  // --match-seats: keep simulated hands of each table size in the real logs' proportions (every k-th hand), so a
  // pooled row mixes table sizes as the real one does.
  if (args.includes('--match-seats') && simHands.length) {
    const size = (h) => (h.players || []).length;
    const rc = {}, sc = {};
    for (const h of simHands) sc[size(h)] = (sc[size(h)] || 0) + 1;
    realHands = realHands.filter((h) => sc[size(h)]); // real hands at table sizes the sim has
    for (const h of realHands) if (h.players && h.players.some((p) => p.hero)) rc[size(h)] = (rc[size(h)] || 0) + 1;
    const scale = Math.min(...Object.keys(sc).filter((k) => rc[k]).map((k) => sc[k] / rc[k]));
    const keep = {}, seen = {};
    for (const k of Object.keys(sc)) keep[k] = rc[k] ? (rc[k] * scale) / sc[k] : 0;
    simHands = simHands.filter((h) => { const k = size(h); seen[k] = (seen[k] || 0) + keep[k]; if (seen[k] >= 1) { seen[k] -= 1; return true; } return false; });
    console.log('sim hands by table size kept: ' + JSON.stringify(Object.fromEntries(Object.keys(sc).map((k) => [k, Math.round(sc[k] * keep[k])]))) + '; real ' + JSON.stringify(rc));
  }
  const real = measure(realHands, { seats });
  const sim = simHands.length ? measure(simHands, { seats, sim: true }) : null;
  console.log(report(real, sim, { min: +opt('min', 20), all: args.includes('--all') }));
}
