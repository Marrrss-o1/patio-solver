// Offscreen page: a pool of solver workers. Each decision is split across the workers (Monte
// Carlo with different seeds). Turn spots (and flops, with FLOP_SOLVER) also get their solver on
// every worker at once (each samples different cards) and the solves are averaged. Then the final
// worker merges the tallies and runs the preflop and river solvers with a big budget. This is
// the computer's "full power" mode.
const CORES = Math.max(2, Math.min(10, (navigator.hardwareConcurrency || 4) - 2));
// Budget multipliers over the phone's settings, and the turn solver's time per worker.
// River 4,000 iterations: with the kernels about 0.2-0.7 s. Preflop 1,200 (about 0.3 s): on all 103
// logged preflop spots 600, 1,200 and 2,400 pick the same action as 4,800 (300 differs once, on a
// near-tie), and 4,800 took over a second, so he often acted before it arrived.
const POWER = { mc: 24, plan: 8, river: 16, preflop: 4 };
// The turn solve runs for 10% of the time left on the game's clock, 1-1.5 s (1.5 s if unknown),
// so the full read arrives in about 2 s: Marwin acts in a median 2.4 s on the turn (raw logs), and
// with the old 30% (about 7 s) he almost always acted on the quick read (a phone-budget answer on
// one more worker, shown first until 1 Nov; Marwin wants the full solve only). The solve is
// converged by about 100 iterations (97% the same pick as 1,600).
const turnMs = (input) => (input.timeLeftMs > 0 ? Math.max(1000, Math.min(1500, 0.1 * input.timeLeftMs)) : 1500);
const PREFLOP_MS = 800;
// Flops: the flop solver (flop and turn solved together, river checked down) on every worker
// for the same time as a turn solve, averaged like the turn. Off: the Monte Carlo decides.
const FLOP_SOLVER = false;
// A job still unanswered after this long is taken as hung (no solve takes more than about 10 s):
// its worker is replaced and the request gets an error, so the next decision still gets advice.
const JOB_LIMIT_MS = 30000;

// Each slot is one worker plus the jobs it hasn't answered yet. A worker that dies (an error
// outside a job, or the browser killing it) never answers again, so its jobs fail at once and a
// new worker takes its place.
let nextId = 1;
function startWorker(slot) {
  const w = new Worker('solver-worker.js');
  slot.w = w;
  w.onmessage = (e) => {
    if (slot.w !== w) return;
    const job = slot.jobs.get(e.data.id);
    if (!job) return;
    slot.jobs.delete(e.data.id);
    clearTimeout(job.timer);
    job.resolve(e.data);
  };
  w.onerror = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (slot.w === w) restart(slot, { ok: false, error: 'A solver worker crashed. It has been restarted.' });
  };
  // The final worker loads the blueprints now rather than on the first decision.
  if (slot.warm) w.postMessage({ id: 0, mode: 'warm' });
}
function makeSlot(warm) {
  const slot = { w: null, jobs: new Map(), warm: !!warm };
  startWorker(slot);
  return slot;
}
// Replace a slot's worker. Its unanswered jobs get `answer`.
function restart(slot, answer) {
  try { slot.w.terminate(); } catch (e) { /* already gone */ }
  const jobs = [...slot.jobs.values()];
  slot.jobs.clear();
  startWorker(slot);
  for (const job of jobs) { clearTimeout(job.timer); job.resolve(Object.assign({}, answer)); }
}
function run(slot, payload, owner) {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (slot.jobs.has(id)) restart(slot, { ok: false, error: 'The solver took too long and was restarted.' });
    }, JOB_LIMIT_MS);
    slot.jobs.set(id, { resolve, timer, owner });
    slot.w.postMessage(Object.assign({ id }, payload));
  });
}

const pool = [];
for (let i = 0; i < CORES; i++) pool.push(makeSlot(false));
// The final pass has its own worker: it holds the blueprints, and it is free the moment the
// Monte Carlo shares are in.
const finalSlot = makeSlot(true);

// The full analysis still running for each table (browser tab).
const running = new Map();
const SUPERSEDED = { ok: false, superseded: true, error: 'A newer decision replaced this one.' };
// A new decision at a table replaces the one still being solved there: hero has acted, or the
// spot changed, so that answer would be thrown away. A solve can't be interrupted, so the pool
// workers still busy with it are replaced, and the new decision starts at once instead of
// waiting behind it (a turn solve holds every worker for up to 8 s, and in the logs hero acts in
// about 2.5 s and is often to act again within 5 s). A final pass in progress is left to finish:
// it is short, and its worker keeps the blueprints loaded.
function supersede(req) {
  req.cancelled = true;
  for (const slot of pool) {
    const jobs = [...slot.jobs.values()];
    if (jobs.length && jobs.every((j) => j.owner === req)) restart(slot, SUPERSEDED);
  }
}

async function analyze(input, tab) {
  const t0 = Date.now();
  const prev = running.get(tab);
  if (prev) supersede(prev);
  const req = { cancelled: false };
  running.set(tab, req);
  try {
    const total = (input.iterations || 24000) * POWER.mc;
    // When a solver decides, the Monte Carlo only feeds the equity readout, so a small share does.
    const solver = typeof PokerEngine !== 'undefined' ? PokerEngine.solvableSpot(Object.assign({ flopSolver: FLOP_SOLVER }, input)) : null;
    const per = solver ? 3000 : Math.ceil(total / CORES);
    const planSamples = 500 * POWER.plan;
    const turn = solver === 'turn';
    const parts = await Promise.all(pool.map((slot, i) => run(slot, {
      mode: 'partial',
      input: Object.assign({}, input, {
        iterations: per, planSamples, riverSolver: false, preflopSolver: false,
        turnSolver: turn, turnTimeMs: turnMs(input), turnIterations: 20000,
        flopSolver: solver === 'flop', flopTimeMs: turnMs(input), flopIterations: 20000,
        seed: ((input.seed >>> 0) + i * 2654435761) >>> 0,
      }),
    }, req)));
    if (req.cancelled) return Object.assign({}, SUPERSEDED);
    const bad = parts.find((p) => !p.ok);
    if (bad) return bad;
    const solvedMerge = parts.map((p) => p.solved).filter(Boolean);
    const fin = await run(finalSlot, {
      mode: 'final',
      input: Object.assign({}, input, {
        merge: parts.map((p) => p.partial), planSamples, solvedMerge: solvedMerge.length ? solvedMerge : undefined,
        riverIterations: (input.riverIterations || 250) * POWER.river,
        preflopIterations: 300 * POWER.preflop, preflopTimeMs: PREFLOP_MS, power: true,
      }),
    }, req);
    if (req.cancelled) return Object.assign({}, SUPERSEDED);
    if (fin.ok) { fin.ms = Date.now() - t0; fin.workers = CORES; fin.iterationsTotal = per * CORES; fin.kernels = !!fin.kernels && parts.every((p) => p.kernels); }
    return fin;
  } finally {
    if (running.get(tab) === req) running.delete(tab);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'analyze') return false;
  analyze(msg.input, msg.tab == null ? null : msg.tab).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
