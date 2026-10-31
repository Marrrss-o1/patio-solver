#!/usr/bin/env node
// Engine speed benchmark and equivalence check.
//
//   node test/bench.js                       time every spot with the phone budget
//   node test/bench.js --power               one offscreen worker's share in computer mode, plus the final merge
//   node test/bench.js --ref origin/main     also run the engine from that git ref on the same inputs and
//                                            check that every result is identical (speed changes must not
//                                            change decisions at equal iterations)
//   node test/bench.js --only flop           only spots whose name contains "flop"
//   node test/bench.js --reps 3              repeat each timing and keep the fastest
//   --turn-iterations 40, --preflop-iterations 2400   solver iterations in computer mode
//
// Results are compared as JSON (typed arrays as arrays), so "identical" means bit-for-bit equal numbers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : args[i + 1]; };
const flag = (name) => args.includes(name);
const POWER = flag('--power');
const REF = opt('--ref', null);
const ONLY = opt('--only', null);
const REPS = +opt('--reps', 1);

const E = require('../src/engine.js');
let R = null;
if (REF) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patio-bench-'));
  const file = path.join(tmp, 'engine.js');
  fs.writeFileSync(file, execSync(`git show ${REF}:src/engine.js`, { cwd: path.join(__dirname, '..'), maxBuffer: 1 << 26 }));
  R = require(file);
}

const C = (s) => s.split(' ').map(E.parseCard);
// A few tallies so the stats are not all priors: a loose caller with showdowns, an aggressive reg.
const show = (cards, board, agg) => ({ cards: cards.split(' '), board: board.split(' '), agg, actions: { pre: 'call', flop: 'call', turn: 'bet', river: 'bet' } });
const loose = {
  pfFold: 30, pfCall: 40, pfRaise: 8, check: 50, bet: 20, call: 45, raise: 4, fold: 20, sawFlop: 40, wtsd: 18,
  shows: [show('Kh 9c', 'Kd 7s 2h 4c Qs', [{ n: 4, frac: 0.6 }, { n: 5, frac: 0.8 }]), show('7h 6h', 'Ah 8h 2c 5d Ts', [{ n: 4, frac: 0.5 }])],
};
const aggro = { pfFold: 50, pfCall: 15, pfRaise: 20, check: 30, bet: 40, call: 15, raise: 10, fold: 25, cbetOpp: 15, cbet: 11, sawFlop: 30, wtsd: 9 };

const SPOTS = [
  { name: 'preflop HU open', input: { hero: C('Ah Qd'), board: [], pot: 15, toCall: 5, stack: 1000, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'V', tally: loose, actions: { pre: 'pending' } }] } },
  { name: 'preflop field open', input: { hero: C('Kh Td'), board: [], pot: 15, toCall: 10, stack: 1000, bigBlind: 10, inPosition: false,
    opponents: [{ name: 'A', tally: aggro, actions: { pre: 'pending' } }, { name: 'B', tally: loose, actions: { pre: 'pending' } }, { name: 'C', tally: {}, actions: { pre: 'pending' } }] } },
  { name: 'preflop 4-way vs raise', input: { hero: C('Jc Ts'), board: [], pot: 45, toCall: 30, stack: 1000, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'A', tally: aggro, actions: { pre: 'raise' } }, { name: 'B', tally: loose, actions: { pre: 'pending' } }, { name: 'C', tally: {}, actions: { pre: 'pending' } }] } },
  { name: 'flop HU check IP', input: { hero: C('7h 7d'), board: C('7s Kc 2d'), pot: 100, toCall: 0, stack: 1000, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'V', tally: loose, actions: { pre: 'call', flop: 'check' } }], heroActions: { pre: 'raise' } } },
  { name: 'flop HU facing bet', input: { hero: C('6c 5d'), board: C('8h 9s Kc'), pot: 200, toCall: 100, stack: 1000, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'V', tally: aggro, actions: { pre: 'raise', flop: 'bet' }, sizes: { flop: 1 } }], heroActions: { pre: 'call' } } },
  { name: 'flop 3-way OOP', input: { hero: C('Kh Jc'), board: C('Kd 8h 4s'), pot: 60, toCall: 0, stack: 1000, bigBlind: 10, inPosition: false,
    opponents: [{ name: 'A', tally: loose, actions: { pre: 'call', flop: 'pending' } }, { name: 'B', tally: aggro, actions: { pre: 'raise', flop: 'pending' } }] } },
  { name: 'turn HU OOP', input: { hero: C('Ah Kd'), board: C('Kc 7s 2d 9h'), pot: 180, toCall: 0, stack: 900, bigBlind: 10, inPosition: false,
    opponents: [{ name: 'V', tally: aggro, actions: { pre: 'call', flop: 'call', turn: '' } }], heroActions: { pre: 'raise', flop: 'bet' } } },
  { name: 'turn HU facing bet', input: { hero: C('Jh Js'), board: C('Ts 7d 3c 2h'), pot: 240, toCall: 120, stack: 900, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'V', tally: loose, actions: { pre: 'call', flop: 'checkcall', turn: 'bet' }, sizes: { turn: 0.5 } }], heroActions: { pre: 'raise', flop: 'bet' } } },
  { name: 'river HU facing bet', input: { hero: C('Qs Qd'), board: C('Kd 8h 2s 3c Ac'), pot: 320, toCall: 120, stack: 1000, bigBlind: 10, inPosition: false,
    opponents: [{ name: 'V', tally: loose, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'bet' }, sizes: { river: 0.6 } }],
    heroActions: { pre: 'raise', flop: 'bet', turn: 'check', river: 'check' } } },
  { name: 'river 3-way check', input: { hero: C('Ad Kc'), board: C('Kd 8h 2s 3c 7c'), pot: 120, toCall: 0, stack: 800, bigBlind: 10, inPosition: true,
    opponents: [{ name: 'A', tally: loose, actions: { pre: 'call', flop: 'call', turn: 'check', river: 'check' } }, { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'check', river: 'check' } }],
    heroActions: { pre: 'raise', flop: 'bet', turn: 'check' } } },
];

// Phone budget: what the tracker asks for. Computer mode, as extension/offscreen.js runs it with 8
// workers: one worker's Monte Carlo share (24x the phone's iterations, or 3000 when a solver
// decides) plus, on the turn, its turn solve; then the final merge with the preflop and river
// solvers. The solvers get fixed iteration counts here (no time limits), so runs are repeatable.
const TURN_IT = +opt('--turn-iterations', 40), PF_IT = +opt('--preflop-iterations', 2400);
const phone = (s) => Object.assign({ iterations: s.input.opponents.length > 2 ? 16000 : 24000 }, s.input, { mix: false, seed: 12345 });
const powerWorker = (s, eng) => {
  const solver = eng.solvableSpot ? eng.solvableSpot(s.input) : null;
  return Object.assign({}, phone(s), {
    iterations: solver ? 3000 : Math.ceil(phone(s).iterations * 24 / 8), planSamples: 4000, riverSolver: false, preflopSolver: false,
    turnSolver: solver === 'turn', turnIterations: TURN_IT, partial: true,
  });
};
const powerFinal = (s, w) => Object.assign({}, phone(s), {
  merge: [w.partial], solvedMerge: w.solved ? [w.solved] : undefined, planSamples: 4000, riverIterations: 2000, preflopIterations: PF_IT, power: true,
});

const toJSON = (x) => JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'number' && !isFinite(v) ? String(v) : v));
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(Math.max(0, i - 80), i + 40) + '\n     vs ' + b.slice(Math.max(0, i - 80), i + 40);
}
function time(fn) {
  let best = Infinity, out;
  for (let r = 0; r < REPS; r++) {
    const t0 = process.hrtime.bigint();
    out = fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms: best, out };
}
function runAll(eng) {
  return (s) => {
    if (!POWER) return time(() => eng.analyzeSync(phone(s)));
    const w = time(() => eng.analyzeSync(powerWorker(s, eng)));
    const f = time(() => eng.analyzeSync(powerFinal(s, w.out)));
    return { ms: w.ms + f.ms, parts: [w.ms, f.ms], out: { worker: w.out, final: f.out } };
  };
}

let mismatches = 0, totNew = 0, totRef = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(`${POWER ? 'Computer mode (one worker share + final merge)' : 'Phone budget'}, best of ${REPS}${REF ? ', vs ' + REF : ''}`);
console.log(pad('spot', 26) + pad('ms', 16) + (REF ? pad('ref ms', 16) + pad('speedup', 10) + 'same' : ''));
for (const s of SPOTS) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  const a = runAll(E)(s);
  totNew += a.ms;
  let line = pad(s.name, 26) + pad(a.ms.toFixed(0) + (a.parts ? ` (${a.parts.map((x) => x.toFixed(0)).join('+')})` : ''), 16);
  if (R) {
    const b = runAll(R)(s);
    totRef += b.ms;
    const ja = toJSON(a.out), jb = toJSON(b.out);
    const same = ja === jb;
    if (!same) mismatches++;
    line += pad(b.ms.toFixed(0) + (b.parts ? ` (${b.parts.map((x) => x.toFixed(0)).join('+')})` : ''), 16) + pad((b.ms / a.ms).toFixed(2) + 'x', 10) + (same ? 'yes' : 'NO');
    console.log(line);
    if (!same) console.log('     ' + firstDiff(ja, jb));
  } else console.log(line);
}
console.log(pad('total', 26) + pad(totNew.toFixed(0), 16) + (R ? pad(totRef.toFixed(0), 16) + pad((totRef / totNew).toFixed(2) + 'x', 10) + (mismatches ? mismatches + ' differ' : 'all same') : ''));
if (mismatches) process.exitCode = 1;
