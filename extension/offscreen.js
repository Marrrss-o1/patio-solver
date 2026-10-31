// Offscreen page: a pool of solver workers. Each decision is split across the workers (Monte
// Carlo with different seeds). Heads-up turn spots also get the turn solver on every worker at
// once (each samples different river cards) and the solves are averaged. Then one worker merges
// the tallies and runs the preflop and river solvers with a big budget. This is the computer's
// "full power" mode.
const CORES = Math.max(2, Math.min(10, (navigator.hardwareConcurrency || 4) - 2));
// Budget multipliers over the phone's settings, and the turn solver's time per worker.
const POWER = { mc: 24, plan: 8, river: 8, preflop: 8 };
const TURN_MS = 4000;
const PREFLOP_MS = 1500;
const workers = [];
let nextId = 1;
const waiting = new Map();
for (let i = 0; i < CORES; i++) {
  const w = new Worker('solver-worker.js');
  w.onmessage = (e) => { const cb = waiting.get(e.data.id); if (cb) { waiting.delete(e.data.id); cb(e.data); } };
  w.onerror = () => {};
  workers.push(w);
}
function run(w, payload) {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    w.postMessage(Object.assign({ id }, payload));
  });
}

async function analyze(input) {
  const t0 = Date.now();
  const total = (input.iterations || 24000) * POWER.mc;
  // When a solver decides, the Monte Carlo only feeds the equity readout, so a small share does.
  const solver = typeof PokerEngine !== 'undefined' ? PokerEngine.solvableSpot(input) : null;
  const per = solver ? 3000 : Math.ceil(total / CORES);
  const planSamples = 500 * POWER.plan;
  const turn = solver === 'turn';
  const parts = await Promise.all(workers.map((w, i) => run(w, {
    mode: 'partial',
    input: Object.assign({}, input, {
      iterations: per, planSamples, riverSolver: false, preflopSolver: false,
      turnSolver: turn, turnTimeMs: TURN_MS, turnIterations: 5000,
      seed: ((input.seed >>> 0) + i * 2654435761) >>> 0,
    }),
  })));
  const bad = parts.find((p) => !p.ok);
  if (bad) return bad;
  const solvedMerge = parts.map((p) => p.solved).filter(Boolean);
  const fin = await run(workers[0], {
    mode: 'final',
    input: Object.assign({}, input, {
      merge: parts.map((p) => p.partial), planSamples, solvedMerge: solvedMerge.length ? solvedMerge : undefined,
      riverIterations: (input.riverIterations || 250) * POWER.river,
      preflopIterations: 300 * POWER.preflop, preflopTimeMs: PREFLOP_MS, power: true,
    }),
  });
  if (fin.ok) { fin.ms = Date.now() - t0; fin.workers = CORES; fin.iterationsTotal = per * CORES; }
  return fin;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'analyze') return false;
  analyze(msg.input).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
