// Do the friend bots play like the real friends? Plays the calibrated bots against each other (4-handed, the hero
// bot in the fourth seat, as in calibration) and compares every stat profile.js measures with the real hand logs,
// in units of the real numbers' sampling error, including stats that were never fitted.
//
//   node test/sim/validate.js <export.json> ... --names <private id->name file> [--profiles test/sim/profiles.json]
//        [--hands 40000] [--json out.json] [--friends]      (--friends: one line per friend and stat as well)
//
// Held-out check: fit on some logs (calibrate.js --out <p> --names <n>), then run this on the other logs with
// --profiles <p> --names <n>. "per-friend vs pool" is the log-likelihood gain per observation of the held-out counts
// from each friend's own bot over the pooled average friend's bot (positive: the per-friend fit carries over).
'use strict';
const fs = require('fs');
const path = require('path');
const prof = require('./profile.js');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const HANDS = +opt('hands', 40000), NP = 4, BB = 2, STACK = 300;
const profiles = JSON.parse(fs.readFileSync(opt('profiles', path.join(__dirname, 'profiles.json')), 'utf8'));
const idName = JSON.parse(fs.readFileSync(opt('names'), 'utf8'));

const seenT = new Set();
const entries = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).filter((h) => (h.t == null || !seenT.has(h.t)) && (seenT.add(h.t), true));
const realT = prof.profileEntries(entries);

// ---------- the bots' own numbers ----------
const ids = Object.keys(profiles).filter((id) => id !== 'hero');
const simEntries = [];
{
  const hero = profiles.hero ? bots.homeBot(profiles.hero.params) : bots.baseline();
  for (let blk = 0; blk < Math.ceil(HANDS / 100); blk++) {
    const order = ids.map((id, i) => [keyed(blk, i, 4711), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, NP - 1);
    const seats = [hero].concat(order.map((id) => bots.homeBot(profiles[id].params)));
    for (let h = 0; h < 100; h++) {
      const d = blk * 100 + h;
      const deck = shuffled((d * 2654435761 + 12345) >>> 0);
      const hands = []; for (let i = 0; i < NP; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
      simEntries.push(playHand({ n: NP, btn: d % NP, hands, boardAll: deck.slice(2 * NP, 2 * NP + 5), stacks: new Array(NP).fill(STACK), sb: BB / 2, bb: BB,
        seats, hero: 0, names: ['hero'].concat(order), seed: (d * 40503 + 7) >>> 0, log: true }).entry);
    }
  }
}
const simT = prof.profileEntries(simEntries);
// --sizes: the spread of sizes (10/25/50/75/90th percentiles), bots vs real, pooled over friends.
if (args.includes('--sizes')) {
  const q = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? `n ${a.length}: ` + [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => a[Math.floor(a.length * p)].toFixed(2)).join(' ') : '-'; };
  const sm = prof.mergeTallies(Object.entries(simT).filter(([k]) => k !== 'pool').map((x) => x[1])), rm = prof.mergeTallies(Object.values(realT));
  for (const [k, nm] of [['openSizes', 'open size (bb)'], ['threeBetRatio', 're-raise / previous bet'], ['raiseRatio', 'postflop raise / bet'], ['betPct', 'bet / pot']]) console.log(`${nm.padEnd(24)} real ${q(rm[k])}   bots ${q(sm[k])}`);
}

// ---------- stats: [key, kind, getter(t) -> [k, n] or values[], fitted?] ----------
const B = 'rate', C = 'mean';
const STATS = [
  ['vpip', B, (t) => [t.vpip, t.hands], 'fit'], ['pfr', B, (t) => [t.pfr, t.hands], 'fit'],
  ['limp', B, (t) => [t.limp, t.unopened]], ['openRaise', B, (t) => [t.open, t.unopened]],
  ['vsOpenFold', B, (t) => [t.vsOpenFold, t.vsOpen], 'fit'], ['vsOpen3b', B, (t) => [t.vsOpen3b, t.vsOpen], 'fit'],
  ['vs3bFold', B, (t) => [t.vs3bFold, t.vs3b], 'fit'], ['callBig', B, (t) => [t.vsBigCont, t.vsBig], 'fit'],
  ['limpFold', B, (t) => [t.limpFold, t.limpFace], 'fit'], ['openShove', B, (t) => [t.openShove, t.open], 'fit'],
  // Size ratios capped at 5x (an all-in is 10-80x), so a few shoves don't decide the mean.
  ['openSize', C, (t) => t.openSizes, 'fit'], ['threeBetSize', C, (t) => t.threeBetRatio.map((x) => Math.min(5, x))],
];
for (const s of ['flop', 'turn', 'river']) {
  STATS.push([s + 'Bet', B, (t) => [t.st[s].bet, t.st[s].bet + t.st[s].check], 'fit']);
  STATS.push([s + 'Fold', B, (t) => [t.st[s].fold, t.st[s].fold + t.st[s].call + t.st[s].raise], 'fit']);
  STATS.push([s + 'Raise', B, (t) => [t.st[s].raise, t.st[s].fold + t.st[s].call + t.st[s].raise], 'fit']);
}
STATS.push(
  ['betSize', C, (t) => t.betPct, 'fit'], ['raiseSize', C, (t) => t.raiseRatio.map((x) => Math.min(5, x))],
  ['foldSmallBet', B, (t) => [t.vs.small.fold, t.vs.small.fold + t.vs.small.call + t.vs.small.raise], 'pooled'],
  ['foldMediumBet', B, (t) => [t.vs.medium.fold, t.vs.medium.fold + t.vs.medium.call + t.vs.medium.raise], 'pooled'],
  ['foldLargeBet', B, (t) => [t.vs.large.fold, t.vs.large.fold + t.vs.large.call + t.vs.large.raise], 'pooled'],
  ['cbet', B, (t) => [t.cbet, t.cbetOpp]], ['donk', B, (t) => [t.donk, t.donkOpp]], ['checkRaise', B, (t) => [t.xr, t.xrOpp]],
  ['sawFlop', B, (t) => [t.sawFlop, t.hands]], ['wtsd', B, (t) => [t.wtsd, t.sawFlop]],
  ['riverCallerStrength', C, (t) => t.shows.filter((x) => /call/.test(x.line.river || '') && !/bet|raise/.test(x.line.river || '')).map((x) => x.river), 'pooled'],
  ['riverBettorStrength', C, (t) => t.shows.filter((x) => /bet|raise/.test(x.line.river || '')).map((x) => x.river)],
  ['reraiseMin', B, (t) => [t.rrMin, t.rrN], 'pooled'], ['reraiseAllin', B, (t) => [t.rrShove, t.rrN], 'pooled'],
  ['postRaiseMin', B, (t) => [t.praMin, t.praN], 'pooled'], ['postRaiseAllin', B, (t) => [t.praShove, t.praN], 'pooled'],
  ['postRaiseOtherSize', C, (t) => t.praOther, 'pooled'], ['minBet', B, (t) => [t.minBetN, t.betN], 'pooled'],
  ['betSizeLog', C, (t) => t.betLog],
  ['answerHUFold', B, (t) => [t.huAnsFold, t.huAnsN]], ['answerFirstFold', B, (t) => [t.mwFirstFold, t.mwFirstN], 'pooled'],
  ['answerLastAfterFolds', B, (t) => [t.mwLastFoldedFold, t.mwLastFoldedN], 'pooled'], ['answerLastAfterCall', B, (t) => [t.mwLastStayedFold, t.mwLastStayedN], 'pooled'],
  ['bothFold2', B, (t) => [t.mw2Fold, t.mw2N]], ['allFold3', B, (t) => [t.mw3Fold, t.mw3N]],
  ['raisedFold', B, (t) => [t.vsRaiseFold, t.vsRaiseN]], ['raisedReraise', B, (t) => [t.vsRaiseRe, t.vsRaiseN], 'pooled'],
  // Betting a turn or river nobody has bet yet, by the player's own line on the street before.
  ...['turn', 'river'].flatMap((st) => [['called', 'pooled'], ['aggr', 'pooled'], ['checked', null]].map(([ln, fit]) =>
    [`open${ln[0].toUpperCase() + ln.slice(1)}${st[0].toUpperCase() + st.slice(1)}`, B, (t) => [t.lineOpen[st][ln], t.lineOpen[st][ln + 'N']], fit])),
  ['shownBetsWeak', B, (t) => { const b = t.shows.flatMap((x) => ['flop', 'turn', 'river'].filter((s) => /bet|raise/.test(x.line[s] || '')).map((s) => x[s])); return [b.filter((v) => v < 0.45).length, b.length]; }],
);
const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sdOf = (xs) => { const m = meanOf(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
// A continuous stat's spread, pooled over every friend's real values (each friend has too few for their own).
const pooledSd = {};
for (const [k, kind, get] of STATS) if (kind === C) { const all = Object.values(realT).flatMap((t) => get(t)); pooledSd[k] = all.length > 2 ? sdOf(all) : null; }

const friends = ids.filter((id) => id !== 'pool' && idName[id] && realT[idName[id]]);
const rows = [];
for (const id of friends) {
  const rt = realT[idName[id]], st = simT[id];
  if (!st) continue;
  for (const [k, kind, get, fit] of STATS) {
    if (kind === B) {
      const [rk, rn] = get(rt), [sk, sn] = get(st);
      if (!rn || !sn) continue;
      const p = sk / sn, pp = Math.min(0.98, Math.max(0.02, p));
      rows.push({ id, k, fit: fit || '', n: rn, real: rk / rn, sim: p, z: (rk / rn - p) / Math.sqrt(pp * (1 - pp) / rn), rk, pp });
    } else {
      const rv = get(rt), sv = get(st);
      if (!rv.length || !sv.length || !pooledSd[k]) continue;
      rows.push({ id, k, fit: fit || '', n: rv.length, real: meanOf(rv), sim: meanOf(sv), z: (meanOf(rv) - meanOf(sv)) / (pooledSd[k] / Math.sqrt(rv.length)) });
    }
  }
}
// The pooled average friend's bot, for the held-out comparison: its rate for every friend.
const poolRate = {};
if (simT.pool) for (const [k, kind, get] of STATS) if (kind === B) { const [sk, sn] = get(simT.pool); if (sn) poolRate[k] = Math.min(0.98, Math.max(0.02, sk / sn)); }

const pct = (x) => (Math.abs(x) < 1.5 && !Number.isInteger(x) ? (x * 100).toFixed(1) : x.toFixed(2));
const summary = [];
console.log(`${entries.length} real hands, ${friends.length} friends with a profile; bots played ${HANDS} hands`);
console.log('stat                  fit     friends  real n   real   bots   RMS z  |z|>2   per-friend vs pool (log-lik per obs)');
for (const [k, kind, , fit] of STATS) {
  const rs = rows.filter((r) => r.k === k);
  if (!rs.length) continue;
  const N = rs.reduce((a, r) => a + r.n, 0);
  const real = rs.reduce((a, r) => a + r.real * r.n, 0) / N, sim = rs.reduce((a, r) => a + r.sim * r.n, 0) / N;
  const rmsz = Math.sqrt(rs.reduce((a, r) => a + r.z * r.z, 0) / rs.length), out2 = rs.filter((r) => Math.abs(r.z) > 2).length;
  let gain = null;
  if (kind === B && poolRate[k] != null) {
    const ll = (p, r) => r.rk * Math.log(p) + (r.n - r.rk) * Math.log(1 - p);
    gain = rs.reduce((a, r) => a + ll(r.pp, r) - ll(poolRate[k], r), 0) / N;
  }
  summary.push({ k, fit: fit || '', friends: rs.length, n: N, real, sim, rmsz, out2, gain });
  console.log(`${k.padEnd(21)} ${(fit || '-').padEnd(7)} ${String(rs.length).padStart(7)} ${String(N).padStart(7)} ${pct(real).padStart(6)} ${pct(sim).padStart(6)} ${rmsz.toFixed(2).padStart(7)} ${String(out2).padStart(6)}   ${gain == null ? '' : (gain >= 0 ? '+' : '') + gain.toFixed(4)}`);
}
const agg = (sel) => { const rs = rows.filter(sel); return { n: rs.length, rmsz: Math.sqrt(rs.reduce((a, r) => a + r.z * r.z, 0) / Math.max(1, rs.length)), out2: rs.filter((r) => Math.abs(r.z) > 2).length / Math.max(1, rs.length) }; };
const tot = { fitted: agg((r) => r.fit === 'fit'), pooled: agg((r) => r.fit === 'pooled'), unfitted: agg((r) => !r.fit) };
const gB = summary.filter((s) => s.gain != null), gAll = gB.reduce((a, s) => a + s.gain * s.n, 0) / Math.max(1, gB.reduce((a, s) => a + s.n, 0));
console.log(Object.entries(tot).map(([k, v]) => `${k}: ${v.n} friend-stats, RMS z ${v.rmsz.toFixed(2)}, ${(v.out2 * 100).toFixed(0)}% beyond 2 SE`).join('; ') + ` (a perfect match of the true rates gives RMS z about 1 and 5% beyond 2 SE)`);
{
  const sdOfAll = (T) => { const all = Object.entries(T).filter(([k]) => k !== 'pool').flatMap(([, t]) => t.betLog); return all.length > 2 ? sdOf(all).toFixed(2) : '-'; };
  console.log(`spread of bet sizes (log-sd of non-min bets, pooled): real ${sdOfAll(realT)}, bots ${sdOfAll(simT)}`);
}
console.log(`per-friend bots vs the pooled bot on these hands: ${gAll >= 0 ? '+' : ''}${gAll.toFixed(4)} log-likelihood per observation`);
if (args.includes('--friends')) for (const r of rows) console.log(`  ${r.id.padEnd(5)} ${r.k.padEnd(21)} n ${String(r.n).padStart(4)} real ${pct(r.real).padStart(6)} bot ${pct(r.sim).padStart(6)} z ${r.z.toFixed(2)}`);
const jsonOut = opt('json', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ hands: entries.length, botHands: HANDS, summary, totals: tot, gain: gAll, rows: rows.map(({ pp, rk, ...r }) => r) }, null, 1));
