// Fits the home-game population prior (READ_PRIORS.home in src/engine.js) from exported hand logs.
//   node test/fit-priors.js log.json [more.json ...]
// Replays the logs through the tracker without decay, then for each decision family prints the
// population rate in each context (pooled counts) and the between-player spread tau (maximum
// marginal likelihood over players, floored so a handful of similar friends can't switch off
// learning). Paste the printed prior into READ_PRIORS.home.
const path = require('path');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');
const B = require('./reads-bench.js');

const sig = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const r3 = (x) => Math.round(x * 1000) / 1000;
const TAU_MIN = 0.35;

function logBinom(x, n, p) { return x * Math.log(Math.max(1e-12, p)) + (n - x) * Math.log(Math.max(1e-12, 1 - p)); }
// log of the integral over u ~ N(0, tau^2) of prod_c Binomial(x_c | sigmoid(mu_c + u)), on a grid.
function margLL(cells, mu, tau) {
  const G = 161, lo = -5 * tau, hi = 5 * tau, du = (hi - lo) / (G - 1);
  let mx = -Infinity;
  const v = new Float64Array(G);
  for (let i = 0; i < G; i++) {
    const u = lo + i * du;
    let s = -0.5 * (u / tau) ** 2 - Math.log(tau * Math.sqrt(2 * Math.PI)) + Math.log(du);
    for (const k of Object.keys(cells)) { const [x, n] = cells[k]; if (n > 0 && mu[k] != null) s += logBinom(x, n, sig(mu[k] + u)); }
    v[i] = s; if (s > mx) mx = s;
  }
  let sum = 0; for (let i = 0; i < G; i++) sum += Math.exp(v[i] - mx);
  return mx + Math.log(sum);
}

// players: [{ name, tally }]. base: a READ_PRIORS entry giving the shape and fallbacks.
// Contexts with fewer than `minN` pooled chances keep a blend toward the family's overall rate.
function fitPrior(players, base, opts) {
  opts = opts || {};
  const prior = JSON.parse(JSON.stringify(base));
  const info = {};
  const K = opts.k != null ? opts.k : 10;
  for (const fam of ['vpip', 'pfr', 'bet', 'fold', 'raise']) {
    const per = players.map((r) => ({ name: r.name, cells: E.tallyCells(Object.assign(T.blankTally(), r.tally))[fam] }));
    const ctx = Object.keys(base[fam].mu).filter((k) => k !== 'all' && k !== 'allMW');
    const X = {}, N = {};
    let XA = 0, NA = 0;
    for (const k of ctx) { X[k] = 0; N[k] = 0; for (const p of per) { const c = p.cells[k] || [0, 0]; X[k] += c[0]; N[k] += c[1]; } XA += X[k]; NA += N[k]; }
    // Heads-up and multiway folds get their own overall rates; 'Old' contexts (counts saved
    // before the split) take the street's mixed rate.
    const isMW = (k) => /MW$/.test(k), isOld = (k) => /Old$/.test(k);
    const sumOf = (pred) => { let x = 0, n = 0; for (const k of ctx) if (pred(k)) { x += X[k]; n += N[k]; } return [x, n]; };
    const [xh, nh] = sumOf((k) => !isMW(k) && !isOld(k)), [xm, nm] = sumOf(isMW);
    const all = nh > 0 ? (xh + K * base[fam].mu.all) / (nh + K) : base[fam].mu.all;
    const mu = { all };
    if (base[fam].mu.allMW != null) mu.allMW = nm > 0 ? (xm + K * base[fam].mu.allMW) / (nm + K) : base[fam].mu.allMW;
    // Each context: pooled counts shrunk toward the family's overall rate.
    for (const k of ctx) mu[k] = (X[k] + K * (isMW(k) ? mu.allMW : all)) / (N[k] + K);
    for (const k of ctx) {
      if (!isOld(k)) continue;
      const st = k.replace(/Old$/, '');
      const x = X[st] + (X[st + 'MW'] || 0), n = N[st] + (N[st + 'MW'] || 0);
      mu[k] = (x + K * (XA / Math.max(1, NA))) / (n + K);
    }
    const lm = {};
    for (const k of ctx) lm[k] = logit(Math.min(0.99, Math.max(0.01, mu[k])));
    void XA;
    let best = { tau: base[fam].tau, ll: -Infinity };
    if (per.length >= 3) {
      for (let tau = 0.05; tau <= 2.0001; tau += 0.05) {
        const ll = per.reduce((a, p) => a + margLL(p.cells, lm, tau), 0);
        if (ll > best.ll) best = { tau, ll };
      }
    }
    prior[fam].mu = Object.fromEntries(Object.entries(mu).map(([k, v]) => [k, r3(v)]));
    prior[fam].tau = r3(Math.max(opts.tauMin != null ? opts.tauMin : TAU_MIN, best.tau));
    info[fam] = { n: N, tauML: r3(best.tau), per: per.map((p) => { let x = 0, n = 0; for (const k of ctx) { const c = p.cells[k] || [0, 0]; x += c[0]; n += c[1]; } return p.name + ' ' + (n ? r3(x / n) : '-') + '/' + Math.round(n); }) };
  }
  // Population range tilt from every shown hand's likelihood at each tilt step (fit.tl),
  // separately for betting and check/call lines, with a light pull toward no tilt.
  const TILTS = [-0.75, -0.5, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.75];
  const tilt = Object.assign({}, base.tilt || { k: 6, kUp: 20 });
  info.tilt = {};
  for (const agg of [true, false]) {
    const sum = TILTS.map(() => 0);
    let n = 0;
    for (const r of players) {
      for (const sh of r.tally.shows || []) {
        const f = sh && sh.fit;
        if (!f || !f.tl || f.tl.length !== TILTS.length || !!f.agg !== agg || sh.folded) continue;
        if (sh.actions && Object.values(sh.actions).includes('fold')) continue;
        f.tl.forEach((v, i) => { sum[i] += v; });
        n++;
      }
    }
    let best = 0, bestV = -Infinity;
    for (let j = 0; j <= 60; j++) {
      const tau = -0.75 + j * 0.025;
      let i = 0;
      while (i < TILTS.length - 2 && tau > TILTS[i + 1]) i++;
      const w = (tau - TILTS[i]) / (TILTS[i + 1] - TILTS[i]);
      const v = sum[i] * (1 - w) + sum[i + 1] * w - 6 * tau * tau;
      if (v > bestV) { bestV = v; best = tau; }
    }
    tilt[agg ? 'agg' : 'pas'] = r3(best);
    info.tilt[agg ? 'agg' : 'pas'] = n;
  }
  prior.tilt = tilt;
  return { prior, info };
}

// Pooled single-context rates, for the `rates`, `vsOpen`, `af` and `betSize` parts (printed only:
// most have too few chances in the logs so far to replace the hand-set priors outright).
function pooledRates(players) {
  const rate = (x, n) => { let X = 0, N = 0; for (const r of players) { X += x(r.tally); N += n(r.tally); } return N ? r3(X / N) + ' (n=' + Math.round(N) + ')' : '-'; };
  const vo = (b, k) => (t) => (t.vsOpen && t.vsOpen[b] ? (k ? t.vsOpen[b][k] : t.vsOpen[b].call + t.vsOpen[b].raise + t.vsOpen[b].fold) : 0);
  return {
    threeBet: rate((t) => t.pf3bet, (t) => t.pf3betOpp),
    callBig: rate((t) => t.pfBigCall, (t) => t.pfBigOpp),
    foldAfterAgg: rate((t) => t.aggVsFold, (t) => t.aggVsN),
    foldCbet: rate((t) => t.foldCbet, (t) => t.vsCbet),
    wtsd: rate((t) => t.wtsd, (t) => t.sawFlop),
    f3bet: rate((t) => t.f3bet, (t) => t.f3betOpp),
    fourBet: rate((t) => t.pf4bet || 0, (t) => t.f3betOpp),
    limp: rate((t) => t.limp, (t) => t.limpOpp),
    vsOpenSmall: rate((t) => vo('small', 'call')(t) + vo('small', 'raise')(t), vo('small')) + ' 3bet ' + rate(vo('small', 'raise'), vo('small')),
    vsOpenMedium: rate((t) => vo('medium', 'call')(t) + vo('medium', 'raise')(t), vo('medium')) + ' 3bet ' + rate(vo('medium', 'raise'), vo('medium')),
    vsOpenLarge: rate((t) => vo('large', 'call')(t) + vo('large', 'raise')(t), vo('large')) + ' 3bet ' + rate(vo('large', 'raise'), vo('large')),
    af: rate((t) => t.bet + t.raise, (t) => t.call),
    betSize: rate((t) => t.betSize.sum, (t) => t.betSize.n),
  };
}

function playersFrom(hands) {
  const model = B.makeModel(path.join(__dirname, '../src/engine.js'));
  const { db } = B.run(model, hands, 'typical', { decay: 1, pool: false });
  return Object.values(db.players).filter((r) => r.tally.pfFold + r.tally.pfCall + r.tally.pfRaise > 0);
}

if (require.main === module) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const hands = B.loadHands(files);
  const players = playersFrom(hands);
  console.log(hands.length + ' hands, ' + players.length + ' players');
  const { prior, info } = fitPrior(players, E.READ_PRIORS.solid);
  console.log('tilt  ', JSON.stringify(prior.tilt), 'shows ' + JSON.stringify(info.tilt));
  for (const fam of ['vpip', 'pfr', 'bet', 'fold', 'raise']) {
    console.log(fam.padEnd(6), JSON.stringify({ mu: prior[fam].mu, tau: prior[fam].tau }), 'tau(ML) ' + info[fam].tauML, 'n ' + JSON.stringify(Object.fromEntries(Object.entries(info[fam].n).map(([k, v]) => [k, Math.round(v)]))));
    console.log('       per player: ' + info[fam].per.join(', '));
  }
  const pr = pooledRates(players);
  for (const k of Object.keys(pr)) console.log(k.padEnd(13), pr[k]);
}

module.exports = { fitPrior, pooledRates, playersFrom };
