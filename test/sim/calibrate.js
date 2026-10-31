// Fits home-bot parameters so simulated friends play like the real ones in the hand logs.
//
//   node test/sim/calibrate.js <export.json> [more.json ...] [--rounds 14] [--hands 8000] [--players 4]
//        [--min-hands 15] [--out test/sim/profiles.json] [--names names.json]
//
// Each friend with enough hands becomes a profile f1, f2, ... (most hands first) plus `pool` (everyone together).
// Targets are the friend's numbers from profile.js, shrunk toward the pool by sample size. The bots then play
// 4-handed tables (a baseline player in the fourth seat, rotating lineups) and every round each parameter moves
// toward its target, measured with the same profile.js code. Names stay out of the repo (it is public):
// --names writes the id -> name mapping to a separate file.
'use strict';
const fs = require('fs');
const path = require('path');
const prof = require('./profile.js');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const ROUNDS = +opt('rounds', 14), HANDS = +opt('hands', 8000), NP = +opt('players', 4), MIN_HANDS = +opt('min-hands', 15);
const OUT = opt('out', path.join(__dirname, 'profiles.json'));
const NAMES_OUT = opt('names', null);
const BB = 2, STACK = 300;

// ---------- targets ----------
// Exports overlap (each holds the last 150 hands), so hands are taken once by their time stamp.
const seenT = new Set();
const entries = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).filter((h) => (h.t == null || !seenT.has(h.t)) && (seenT.add(h.t), true));
const tallies = prof.profileEntries(entries);
const names = Object.keys(tallies).filter((n) => tallies[n].hands >= MIN_HANDS).sort((a, b) => tallies[b].hands - tallies[a].hands);
const pool = prof.summarize(prof.mergeTallies(Object.values(tallies)));
const real = {};
for (const n of names) real[n] = prof.summarize(tallies[n]);

// Stats the calibration matches: [key, getter, sample-size getter, prior (for the pool), shrink K]
const STATS = [
  ['vpip', (s) => s.vpip, (s) => s.hands, null, 15],
  ['pfr', (s) => s.pfr, (s) => s.hands, null, 15],
  ['vsOpenFold', (s) => s.vsOpenFold, (s) => s.vsOpenN, 0.4, 10],
  ['vsOpen3b', (s) => s.vsOpen3b, (s) => s.vsOpenN, 0.12, 10],
  ['callBig', (s) => s.callBig, (s) => s.callBigN, 0.45, 10],
  ['openSize', (s) => s.openSize, (s) => s.unopenedN * (s.openRaise || 0), 4, 6],
  ['openShove', (s) => s.openShove, (s) => s.openShoveN, 0.02, 8],
  ['limpFold', (s) => s.limpFold, (s) => s.limpFaceN, 0.4, 10],
  ['vs3bFold', (s) => s.vs3bFold, (s) => s.vs3bN, 0.3, 10],
  ['betPct', (s) => s.betPct, (s) => s.betPctN, 0.5, 8],
];
for (const st of ['flop', 'turn', 'river']) {
  STATS.push([st + 'Bet', (s) => s.st[st].betFreq, (s) => s.st[st].u, null, 20]);
  STATS.push([st + 'Fold', (s) => s.st[st].foldToBet, (s) => s.st[st].f, null, 20]);
  STATS.push([st + 'Raise', (s) => s.st[st].raiseFreq, (s) => s.st[st].f, null, 20]);
}
// The pool's own numbers, shrunk toward a prior where the pool is thin.
const poolT = {};
for (const [k, get, nOf, prior, K] of STATS) {
  const x = get(pool), n = nOf(pool) || 0;
  poolT[k] = x == null ? prior : prior == null ? x : (n * x + K * prior) / (n + K);
}
// Shove-opening is one or two players' habit, not the table's: for players without their own numbers it
// comes from the average friend (each shrunk toward the prior), not from everyone's opens lumped together.
{
  const [k, get, nOf, prior, K] = STATS.find((x) => x[0] === 'openShove');
  const per = names.map((nm) => real[nm]).filter((s) => nOf(s) > 0).map((s) => (nOf(s) * get(s) + K * prior) / (nOf(s) + K));
  if (per.length) poolT[k] = per.reduce((a, b) => a + b, 0) / per.length;
}
function targetsFor(s) {
  const t = {};
  for (const [k, get, nOf, , K] of STATS) {
    const x = s ? get(s) : null, n = s ? nOf(s) || 0 : 0;
    t[k] = x == null || !n ? poolT[k] : (n * x + K * poolT[k]) / (n + K);
  }
  return t;
}
const ids = names.map((_, i) => 'f' + (i + 1)).concat(['pool']);
const targets = {};
names.forEach((n, i) => { targets[ids[i]] = targetsFor(real[n]); });
targets.pool = Object.assign({}, poolT);
// The hero (Marwin following the advice) is calibrated too and sits in the fourth seat, so the
// friends face bets about as often as they did at the real table.
const heroTallies = prof.profileEntries(entries, { includeHero: true });
// Hero's screen name changes between sessions: pool every name hero played under.
const heroNames = [...new Set(entries.flatMap((h) => h.players.filter((p) => p.hero).map((p) => p.name)))];
if (heroNames.some((n) => heroTallies[n])) {
  real.__hero = prof.summarize(prof.mergeTallies(heroNames.filter((n) => heroTallies[n]).map((n) => heroTallies[n])));
  ids.push('hero');
  targets.hero = targetsFor(real.__hero);
}

// How much more often they fold to bigger bets, pooled over friends (too few spots each): fold share facing a bet of
// 45% pot or more minus facing a smaller one. Real friends: about 0.36 below 45% pot, 0.65 above.
const foldGap = (s) => {
  const big = s.vs.medium.n + s.vs.large.n;
  if (!s.vs.small.n || !big) return null;
  return (s.vs.medium.fold * s.vs.medium.n + s.vs.large.fold * s.vs.large.n) / big - s.vs.small.fold;
};
const SIZE_GAP = foldGap(pool);
// Sizing, pooled over friends (too few raises each): re-raise and postflop raise mix (min-raise / all-in / bigger,
// and how big the bigger ones are), min-bets and the spread of bet sizes. Real friends: about 4 in 5 re-raises are
// min-raises, postflop raises are a little over half min-raises with some all-ins, and bet sizes shrink as the pot grows
// (about pot-size bets in pots under 6bb, a fifth of the pot above 25bb; log-sd about 0.64 around that).
const shrink = (x, n, prior, K) => (x == null || !n ? prior : (n * x + K * prior) / (n + K));
const SIZING = [
  // [stat, param, prior, K, step, lo, hi, mode]
  ['rrMinShare', 'rrMin', 0.5, 8, 1, 0.05, 0.98],
  ['rrShoveShare', 'rrShove', 0.03, 8, 0.8, 0, 0.5],
  ['raiseMinShare', 'raiseMin', 0.3, 8, 1, 0, 0.9],
  ['raiseShoveShare', 'raiseShove', 0.05, 8, 0.8, 0, 0.5],
  ['raiseOtherRatio', 'raiseX', 3, 4, 0.7, 2, 8, 'ratio'],
  ['minBetShare', 'minBet', 0.1, 8, 0.9, 0, 0.5],
  ['betSizeSlope', 'potSlope', -0.3, 8, 0.8, -1.2, 0.3],
  ['betSizeResid', 'sizeSd', 0.6, 8, 0.8, 0.1, 1.2],
  // Raised after betting on the same street: friends re-raise 3 of 21 (the bots, before this was fitted, 26%).
  ['vsRaiseRe', 'reRaise', 0.2, 8, 3, 0.1, 1.5],
];
const sizingN = { rrMinShare: 'rrN', rrShoveShare: 'rrN', raiseMinShare: 'raiseN', raiseShoveShare: 'raiseN', raiseOtherRatio: 'raiseN', minBetShare: 'betN', betSizeSlope: 'betLogN', betSizeResid: 'betLogN', vsRaiseRe: 'vsRaiseN' };
const SIZING_T = {};
for (const [k, , prior, K] of SIZING) SIZING_T[k] = shrink(pool[k], pool[sizingN[k]], prior, K);
// River callers' strength at showdown, pooled over friends (shrunk toward the old bots' 0.76).
const SD_CALL = pool.sdRiverCall == null ? null : (pool.sdRiverCallN * pool.sdRiverCall + 10 * 0.76) / (pool.sdRiverCallN + 10);

// ---------- parameters ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
const params = {};
for (const id of ids) {
  const t = targets[id];
  const p = clone(bots.HOME_DEFAULT);
  p.vpip = t.vpip; p.pfr = t.pfr; p.cont = 1 - t.vsOpenFold; p.threeBet = t.vsOpen3b; p.callBig = t.callBig;
  p.openBB = t.openSize; p.betSize = t.betPct; p.openShove = t.openShove;
  params[id] = p;
}
// [stat, param, index or null, direction, step, lo, hi, mode]
const CTRL = [
  ['vpip', 'vpip', null, 1, 0.9, 0.08, 0.97],
  ['pfr', 'pfr', null, 1, 0.9, 0.01, 0.6],
  ['vsOpenFold', 'cont', null, -1, 0.8, 0.05, 0.97],
  ['vsOpen3b', 'threeBet', null, 1, 0.8, 0.005, 0.5],
  ['callBig', 'callBig', null, 1, 0.6, 0.05, 0.9],
  ['openSize', 'openBB', null, 1, 0.7, 2, 10, 'ratio'],
  ['openShove', 'openShove', null, 1, 0.8, 0, 0.8],
  ['limpFold', 'limpCont', null, -1, 0.9, 0.1, 1.5],
  ['vs3bFold', 'cont3b', null, -1, 0.5, -0.3, 0.6],
  ['betPct', 'betSize', null, 1, 0.7, 0.15, 1.2, 'ratio'],
];
['flop', 'turn', 'river'].forEach((st, i) => {
  CTRL.push([st + 'Bet', 'val', i, -1, 0.7, 0.4, 0.99]);
  CTRL.push([st + 'Fold', 'call', i, 1, 0.7, 0.05, 0.97]);
  CTRL.push([st + 'Raise', 'raise', i, -1, 0.5, 0.6, 0.995]);
});

// ---------- simulate and measure ----------
function measure(round) {
  const nb = NP - 1;
  const entriesSim = [];
  const hero = params.hero ? bots.homeBot(params.hero) : bots.baseline();
  const seatNames = [params.hero ? 'hero' : 'Hero'];
  const opp = ids.filter((x) => x !== 'hero');
  for (let blk = 0; blk < Math.ceil(HANDS / 100); blk++) {
    // A lineup per block of 100 hands; the pool bot fills in too.
    const order = opp.map((id, i) => [keyed(round, blk, i, 99), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const line = order.slice(0, nb);
    const seats = [hero].concat(line.map((id) => bots.homeBot(params[id])));
    const nm = seatNames.concat(line);
    for (let h = 0; h < 100; h++) {
      const d = blk * 100 + h;
      const deck = shuffled((round * 7919 + d * 104729) >>> 0);
      const hands = []; for (let i = 0; i < NP; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
      const res = playHand({ n: NP, btn: d % NP, hands, boardAll: deck.slice(2 * NP, 2 * NP + 5), stacks: new Array(NP).fill(STACK), sb: BB / 2, bb: BB,
        seats, hero: 0, names: nm, seed: (round * 1000003 + d) >>> 0, log: true });
      entriesSim.push(res.entry);
    }
  }
  const t = prof.profileEntries(entriesSim, { includeHero: true });
  const out = {};
  for (const id of ids) if (t[id]) out[id] = prof.summarize(t[id]);
  tallyOf = t;
  return out;
}
let tallyOf = {};
const statVal = (s, k) => {
  const def = STATS.find((x) => x[0] === k);
  return def[1](s);
};

let last = null;
for (let round = 1; round <= ROUNDS; round++) {
  const m = measure(round);
  last = m;
  let err = 0, cnt = 0;
  const damp = round <= 3 ? 1 : round <= 8 ? 0.7 : 0.45;
  for (const id of ids) {
    if (!m[id]) continue;
    const p = params[id], t = targets[id];
    for (const [k, key, idx, dir, step, lo, hi, mode] of CTRL) {
      const x = statVal(m[id], k);
      if (x == null || t[k] == null) continue;
      const cur = idx == null ? p[key] : p[key][idx];
      let nx;
      if (mode === 'ratio') nx = cur * Math.pow(t[k] / Math.max(1e-3, x), step * damp);
      else nx = cur + dir * step * damp * (t[k] - x);
      nx = Math.max(lo, Math.min(hi, nx));
      if (idx == null) p[key] = nx; else p[key][idx] = nx;
      if (mode !== 'ratio') { err += Math.abs(t[k] - x); cnt++; }
    }
  }
  // Pool-wide: how strong river callers are at showdown sets everyone's calling softness (too few showdowns per friend).
  const simCall = Object.keys(m).filter((id) => id !== 'hero').map((id) => [m[id].sdRiverCall, m[id].sdRiverCallN]).filter((x) => x[0] != null);
  const sc = simCall.reduce((a, x) => a + x[0] * x[1], 0) / Math.max(1, simCall.reduce((a, x) => a + x[1], 0));
  if (SD_CALL != null && simCall.length) {
    const wc = Math.max(0.03, Math.min(0.25, params[ids[0]].wc * Math.exp(6 * damp * (sc - SD_CALL))));
    for (const id of ids) if (id !== 'hero') params[id].wc = wc;
  }
  // Pool-wide: the fold gap between big and small bets sets everyone's callSlope.
  const simVs = prof.mergeTallies(Object.keys(tallyOf).filter((id) => id !== 'hero').map((id) => tallyOf[id]));
  const gSim = foldGap(prof.summarize(simVs));
  if (SIZE_GAP != null && gSim != null) {
    const cs = Math.max(0, Math.min(1.5, params[ids[0]].callSlope + 2 * damp * (SIZE_GAP - gSim)));
    for (const id of ids) if (id !== 'hero') params[id].callSlope = cs;
  }
  // Pool-wide sizing parameters, each toward the friends' pooled number.
  const simPoolS = prof.summarize(simVs);
  for (const [k, key, , , step, lo, hi, mode] of SIZING) {
    const x = simPoolS[k], T = SIZING_T[k];
    if (x == null || T == null) continue;
    const cur = params[ids[0]][key];
    let nx = mode === 'ratio' ? cur * Math.pow(T / Math.max(1e-3, x), step * damp) : cur + step * damp * (T - x);
    nx = Math.max(lo, Math.min(hi, nx));
    for (const id of ids) if (id !== 'hero') params[id][key] = nx;
  }
  for (const id of ids) if (id !== 'hero' && params[id].raiseMin + params[id].raiseShove > 0.95) params[id].raiseMin = 0.95 - params[id].raiseShove;
  process.stderr.write(`round ${round}: sizing ${SIZING.map(([k]) => `${k} ${simPoolS[k] == null ? '-' : simPoolS[k].toFixed(2)}/${SIZING_T[k].toFixed(2)}`).join(' ')}\n`);
  process.stderr.write(`round ${round}: fold gap big vs small bets ${gSim == null ? '-' : gSim.toFixed(3)} (real ${SIZE_GAP == null ? '-' : SIZE_GAP.toFixed(3)}), mean abs error ${(err / cnt * 100).toFixed(2)} points, river callers at showdown ${sc.toFixed(3)} (real ${SD_CALL})\n`);
}

// ---------- write ----------
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const style = (t) => {
  const loose = t.vpip >= 0.6 ? 'very loose' : t.vpip >= 0.45 ? 'loose' : 'medium';
  const agg = t.pfr >= 0.25 ? 'aggressive' : t.pfr >= 0.13 ? 'semi-aggressive' : 'passive';
  return `${loose} ${agg} preflop (VPIP ${Math.round(t.vpip * 100)} / PFR ${Math.round(t.pfr * 100)}), folds ${Math.round(t.flopFold * 100)}/${Math.round(t.turnFold * 100)}/${Math.round(t.riverFold * 100)}% to flop/turn/river bets`;
};
const out = {};
for (const id of ids) {
  const p = params[id];
  const rp = {};
  for (const [k, v] of Object.entries(p)) rp[k] = Array.isArray(v) ? v.map(r3) : r3(v);
  const meas = {};
  const tgt = {};
  for (const [k] of STATS) { tgt[k] = r3(targets[id][k]); meas[k] = last[id] ? r3(statVal(last[id], k)) : null; }
  if (last[id]) { meas.wtsd = r3(last[id].wtsd); meas.sdBluffShare = r3(last[id].sdBluffShare); meas.limp = r3(last[id].limp); meas.sdRiverCall = r3(last[id].sdRiverCall); meas.sdRiverBet = r3(last[id].sdRiverBet); }
  const src = id === 'pool' ? pool : id === 'hero' ? real.__hero : real[names[ids.indexOf(id)]];
  out[id] = { style: style(targets[id]), hands: src.hands, target: tgt, simulated: meas, params: rp,
    real: { wtsd: r3(src.wtsd), sdBluffShare: r3(src.sdBluffShare), limp: r3(src.limp), sdRiverCall: r3(src.sdRiverCall), sdRiverCallN: src.sdRiverCallN, sdRiverBet: r3(src.sdRiverBet), sdRiverBetN: src.sdRiverBetN } };
  // Fold share facing a bet under 45% pot / 45-85% / over 85% (pooled numbers are the ones fitted).
  const bySize = (x) => ['small', 'medium', 'large'].map((b) => r3(x.vs[b].fold));
  out[id].real.foldBySize = bySize(src); out[id].real.foldBySizeN = ['small', 'medium', 'large'].map((b) => src.vs[b].n);
  if (last[id]) out[id].simulated.foldBySize = bySize(last[id]);
}
{
  const simPool = prof.summarize(prof.mergeTallies(Object.keys(tallyOf).filter((id) => id !== 'hero').map((id) => tallyOf[id])));
  out.pool.simulated.foldBySizeAllBots = ['small', 'medium', 'large'].map((b) => r3(simPool.vs[b].fold));
  out.pool.real.sizing = Object.fromEntries(SIZING.map(([k]) => [k, r3(pool[k])]));
  out.pool.target.sizing = Object.fromEntries(SIZING.map(([k]) => [k, r3(SIZING_T[k])]));
  out.pool.simulated.sizingAllBots = Object.fromEntries(SIZING.map(([k]) => [k, r3(simPool[k])]));
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
if (NAMES_OUT) fs.writeFileSync(NAMES_OUT, JSON.stringify(Object.fromEntries(names.map((n, i) => [ids[i], n])), null, 1));
console.log(`wrote ${OUT}: ${ids.join(', ')}`);
for (const id of ids) {
  const o = out[id];
  const worst = Object.keys(o.target).map((k) => [k, o.target[k], o.simulated[k]]).filter((x) => x[2] != null && x[1] != null)
    .map((x) => [x[0], Math.abs(x[1] - x[2]) / (/Size|Pct/.test(x[0]) ? x[1] : 1)]).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, e]) => `${k} ${(e * 100).toFixed(1)}${/Size|Pct/.test(k) ? '%' : 'pt'}`);
  console.log(`${id.padEnd(5)} ${o.hands} hands: ${o.style}; worst fits: ${worst.join(', ')}; WTSD real ${o.real.wtsd} sim ${o.simulated.wtsd}`);
}
