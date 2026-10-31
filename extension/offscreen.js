// Offscreen page: a pool of solver workers. Each decision is split across the workers (Monte
// Carlo with different seeds), then one worker merges the tallies and runs the river and turn
// solvers with a big budget. This is the computer's "full power" mode.
const CORES = Math.max(2, Math.min(10, (navigator.hardwareConcurrency || 4) - 2));
// Budget multipliers over the phone's settings.
const POWER = { mc: 24, plan: 8, river: 8, turn: 6 };
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
  const per = Math.ceil(total / CORES);
  const planSamples = 500 * POWER.plan;
  const parts = await Promise.all(workers.map((w, i) => run(w, {
    mode: 'partial',
    input: Object.assign({}, input, { iterations: per, planSamples, riverSolver: false, turnSolver: false, seed: ((input.seed >>> 0) + i * 2654435761) >>> 0 }),
  })));
  const bad = parts.find((p) => !p.ok);
  if (bad) return bad;
  const fin = await run(workers[0], {
    mode: 'final',
    input: Object.assign({}, input, {
      merge: parts.map((p) => p.partial), planSamples,
      riverIterations: (input.riverIterations || 250) * POWER.river,
      turnIterations: input.turnIterations ? input.turnIterations * POWER.turn : undefined, power: true,
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
