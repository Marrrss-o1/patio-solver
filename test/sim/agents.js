// Hero agents for the simulator: the real solver, driven through the real tracker the way the
// overlay drives it, from any copy of src/ (so two versions can be compared on the same deals).
'use strict';
const path = require('path');
const { keyed } = require('./game.js');
const bots = require('./bots.js');

// opts: { src: directory holding engine.js and tracker.js (default: this checkout's src/),
//         solver: extra analyzeSync input (e.g. { preflopSolver: false }), iters, riverIters, tableStyle, db }
function solverAgent(opts = {}) {
  const src = opts.src || path.join(__dirname, '..', '..', 'src');
  const E = require(path.join(src, 'engine.js'));
  const T = require(path.join(src, 'tracker.js'));
  const tracker = new T(opts.db ? JSON.parse(JSON.stringify(opts.db)) : { players: {} });
  tracker.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
  tracker.rawKeep = 0;
  const fallback = bots.baseline();
  const stats = { decisions: 0, errors: 0, ms: 0, solved: {} };
  const extra = Object.assign({}, opts.solver || {});
  const agent = {
    E, T, tracker, stats,
    onEvent(ev, data, snapFn) { tracker.handle(ev, data, snapFn()); },
    act(v) {
      const b = tracker.solverInput(opts.tableStyle || 'typical');
      if (b.error) { stats.errors++; return fallback.act(v); }
      const t0 = Date.now();
      const input = Object.assign({}, b.input, {
        iterations: opts.iters || 3000, riverIterations: opts.riverIters || 120,
        seed: Math.floor(keyed(v.rk, v.nAct, 4242) * 4294967296) >>> 0,
      }, extra);
      const res = E.analyzeSync(input);
      stats.ms += Date.now() - t0; stats.decisions++;
      if (res.solver) stats.solved[res.solver.kind || 'river'] = (stats.solved[res.solver.kind || 'river'] || 0) + 1;
      const best = res.best;
      if (agent.onDecision) agent.onDecision(v, b.input, res);
      if (best.kind === 'fold') return { t: 'fold' };
      if (best.kind === 'check') return { t: 'check' };
      if (best.kind === 'call') return { t: 'call' };
      return { t: 'raise', to: v.myBet + best.amount };
    },
  };
  return agent;
}

// Solver options from the environment flags the old simulators use (PF, PFIT, TURN, TURNIT).
function envSolverOpts(env = process.env) {
  const o = {};
  if (env.PF === '0') o.preflopSolver = false;
  if (env.PFIT) o.preflopIterations = +env.PFIT;
  if (env.TURN === '1') { o.turnSolver = true; o.turnIterations = +(env.TURNIT || 30); }
  return o;
}

module.exports = { solverAgent, envSolverOpts };
