// Fold calibration of hero's bets against the bots: plays the sim like run.js (variant A only) and records every hero
// bet or raise after the flop with the solver's predicted chance that everyone folds at the chosen size (res.scenarios
// foldPct), and whether everyone did. Prints act / pred (everyone folded / predicted) and the slope of a logistic
// recalibration of pred (1 = calibrated) for hero's bets, by spot and size. --entries also writes the solver's hand-log
// entries of the measured hands (raw events dropped), which the log tools read (range-test.js, allin-test.js).
//   BOTPROFILES=test/sim/profiles-v11.json node test/sim/fold-cal.js --hands 1000 --players 4 --bots friends
//     --budget live --seed 3901 --a-ref main --workers 4 [--out bets.json] [--entries entries.json]
//   node test/sim/fold-cal.js --summary bets.json ...        (the table again from saved bets)
'use strict';
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const ROOT = process.env.PATIO_ROOT || path.join(__dirname, '..', '..');
if (isMainThread) process.chdir(ROOT);
const A = require(path.join(ROOT, 'test/sim/agents.js'));
const orig = A.solverAgent;
let ENTRIES = [], BETS = [];
const MADE = [];
const STN = { 3: 'flop', 4: 'turn', 5: 'river' };
A.solverAgent = (opts) => {
  const ag = orig(opts);
  MADE.push(ag);
  let viaOnEvent = false, lastMeasured = false, pend = [], histRef = null;
  const seen = new Set();
  const last = () => (ag.tracker.db.history ? ag.tracker.db.history[ag.tracker.db.history.length - 1] : null);
  const close = () => {
    const h = last();
    if (!h || seen.has(h)) return;
    seen.add(h);
    if (lastMeasured) ENTRIES.push(h);
    if (!pend.length) return;
    const log = (h.log || []).filter((e) => e.act);
    for (const st of ['flop', 'turn', 'river']) {
      const mine = pend.filter((b) => b.st === st);
      const idx = log.map((e, i) => [e, i]).filter(([e]) => e.st === st && e.hero && /^(bet|raise|3bet|4bet|allin)$/.test(e.act)).map((x) => x[1]);
      mine.forEach((b, j) => {
        const i = idx[j];
        if (i == null) return;
        const after = []; for (let t = i + 1; t < log.length && log[t].st === st && !log[t].hero; t++) after.push(log[t]);
        b.allFold = after.length > 0 && after.every((x) => x.act === 'fold');
        b.reraised = after.some((x) => /^(bet|raise|3bet|4bet|allin)$/.test(x.act) && x.to > log[i].to);
        if (lastMeasured) BETS.push(b);
      });
    }
    pend = [];
  };
  ag.collect = close;
  const origHandle = ag.tracker.handle.bind(ag.tracker);
  ag.tracker.handle = (ev, data, snap) => {
    if (ev === 'game:stage_began' && data && data.stageType === 'set_blinds') { close(); lastMeasured = viaOnEvent; }
    return origHandle(ev, data, snap);
  };
  let userHook = null;
  const hook = (v, input, res) => {
    // The advice goes into the hand log as the panel writes it (text, EV, options), so the entries carry `advice` with
    // `did` / `followed` for the log tools (table-check.js's TD rows).
    if (res.best) {
      const lbl = (sc) => (sc.label || sc.kind) + (sc.amount ? ' ' + Math.round(sc.amount * 100) / 100 : '');
      ag.tracker.noteAdvice(lbl(res.best), res.best.ev || 0, res, lbl);
    }
    if (v.street >= 3 && res.best && !['fold', 'check', 'call'].includes(res.best.kind)) {
      const sc = (res.scenarios || []).filter((x) => !['fold', 'check', 'call'].includes(x.kind));
      const s0 = sc.length ? sc.reduce((m, o) => (Math.abs(o.amount - res.best.amount) < Math.abs(m.amount - res.best.amount) ? o : m), sc[0]) : null;
      pend.push({ st: STN[v.street], nOpp: v.nOpp, kind: res.best.kind, amount: res.best.amount, toCall: input.toCall, pot: input.pot,
        frac: (res.best.amount - (input.toCall || 0)) / Math.max(1, input.pot + (input.toCall || 0)), pred: s0 ? s0.foldPct : null,
        eq: res.equity ? res.equity.share : null, solver: res.solver ? res.solver.kind || 'yes' : null });
    }
    if (userHook) userHook(v, input, res);
  };
  Object.defineProperty(ag, 'onDecision', { get: () => hook, set: (f) => { userHook = f; }, configurable: true });
  const origEv = ag.onEvent;
  ag.onEvent = (ev, data, snapFn) => { viaOnEvent = true; try { origEv(ev, data, snapFn); } finally { viaOnEvent = false; } };
  return ag;
};
const lg = (p) => Math.log(p / (1 - p)), sg = (x) => 1 / (1 + Math.exp(-x));
function slope(s) {
  let a = 0, b = 1;
  for (let it = 0; it < 60; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const x of s) { const z = lg(Math.min(0.98, Math.max(0.02, x.pred))), q = sg(a + b * z), y = x.allFold ? 1 : 0, w = q * (1 - q); g0 += y - q; g1 += (y - q) * z; h00 += w; h01 += w * z; h11 += w * z * z; }
    const det = h00 * h11 - h01 * h01; if (!(det > 0)) return null;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) return { b, se: Math.sqrt(h00 / det) };
  }
  return null;
}
function summary(bets) {
  const B = bets.filter((x) => x.pred != null && x.allFold != null && x.kind === 'bet');
  const f2 = (x) => x.toFixed(2);
  const one = (s, withSlope) => {
    if (!s.length) return '-';
    const act = s.filter((x) => x.allFold).length / s.length, pred = s.reduce((a, x) => a + x.pred, 0) / s.length, r = withSlope && s.length >= 15 ? slope(s) : null;
    return `${f2(act)} / ${f2(pred)} (n ${s.length}${r ? `, slope ${f2(r.b)} ± ${f2(r.se)}` : ''})`;
  };
  console.log('hero\'s bets (not raises): everyone folded / predicted; by size under 45% / 45-85% / 85%+ pot');
  for (const [nm, flt] of [['HU flop+turn', (x) => x.nOpp === 1 && x.st !== 'river'], ['HU river', (x) => x.nOpp === 1 && x.st === 'river'], ['multiway', (x) => x.nOpp > 1]]) {
    const s = B.filter(flt);
    console.log(`  ${nm.padEnd(13)} ${one(s, true)}   ${[[0, 0.45], [0.45, 0.85], [0.85, 99]].map(([lo, hi]) => one(s.filter((x) => x.frac >= lo && x.frac < hi), false)).join('  ')}`);
  }
}
if (isMainThread && process.argv.includes('--summary')) {
  summary(process.argv.slice(process.argv.indexOf('--summary') + 1).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8'))));
  process.exit(0);
}
const R = require(path.join(ROOT, 'test/sim/run.js'));
if (!isMainThread) {
  // The config comes from the main thread (as in run.js), so workers don't write the ref's src while others load it.
  const { cfg, block } = workerData;
  cfg.variants = cfg.variants.slice(0, 1);
  ENTRIES = []; BETS = [];
  R.playBlock(cfg, block);
  for (const ag of MADE) ag.collect();
  parentPort.postMessage({ bets: BETS, entries: ENTRIES.map((h) => { const x = Object.assign({}, h); delete x.raw; x.block = block; return x; }) });
} else {
  const argv = process.argv.slice(2);
  const args = R.parseArgs(argv);
  const cfg = R.buildConfig(args);
  const blocks = Math.ceil(cfg.hands / cfg.block);
  const nw = Math.min(+(args.workers || 4), blocks);
  const queue = Array.from({ length: blocks }, (_, i) => i);
  const bets = [], entries = [];
  let live = nw;
  for (let w = 0; w < nw; w++) {
    const run = () => {
      if (!queue.length) {
        if (--live === 0) {
          if (args.out) fs.writeFileSync(args.out, JSON.stringify(bets));
          if (args.entries) fs.writeFileSync(args.entries, JSON.stringify(entries));
          console.log(`${bets.length} hero bets and raises after the flop, ${entries.length} hands`);
          summary(bets);
        }
        return;
      }
      const b = queue.shift();
      const wk = new Worker(__filename, { workerData: { cfg, block: b } });
      wk.on('message', (m) => { bets.push(...m.bets); entries.push(...m.entries); process.stderr.write(`block ${b}: ${m.bets.length} bets, ${m.entries.length} entries\n`); wk.terminate(); });
      wk.on('error', (e) => { console.error(e); });
      wk.on('exit', run);
    };
    run();
  }
}
