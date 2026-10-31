// Simulator runner: 2-6 seats, duplicate deals, AIVAT luck correction, worker threads, and paired
// A/B comparisons on identical deals (two solver configurations, two git refs, or solver vs baseline).
//
//   node test/sim/run.js [--hands 1000] [--players 2] [--bots typical] [--seed 1] [options]
//
// Seats and opponents
//   --players N        2-6 seats (hero + N-1 bots)
//   --bots SPEC        typical | station | maniac | mixed (old bots), home (average friend), friends (a lineup of
//                      bots calibrated to Marwin's friends, a different lineup per block), home:<id> (one friend
//                      profile from profiles.json), solver (the solver itself, with its own tracker and reads;
//                      solver@REF runs src/ of a git ref), or a comma list, one spec per bot seat
//   --stack BB         starting stacks in big blinds (default 150 with friends/home bots, 100 otherwise)
//   --bb CHIPS         big blind in chips (default 2, like the real lobby; small blind is half)
// What is measured
//   --agent X          solver (default) | baseline | bot:<spec>
//   --a-opts JSON      extra analyzeSync input for A, e.g. '{"preflopSolver":false}'
//   --b-opts JSON      ... for B; giving any --b-* option turns on the paired A/B run
//   --a-ref REF        git ref whose src/ A runs (default: the working tree); --b-ref likewise
//   --b-agent X        agent for B (default: same as A)
//   --a-bp FILES       blueprint files for A (comma list; --a-bp alone = none), --b-bp likewise; default: env BP
//   Env PF=0, PFIT=n, TURN=1, TURNIT=n set solver options for both A and B (the old simulators' flags).
// Noise
//   --dup 1|0          duplicate: play every deal once per seat, with the cards and position rotating (default 1)
//   --aivat MODE       call (default) | refund | best | off: value function for the luck correction
//   --warm N           hands played per block (baseline in hero's seat) before measuring, so the solver starts
//                      with reads like Marwin's (default 300; 0 = start every block with no reads)
// Speed
//   --workers N        worker threads (default: all cores)
//   --block N          deals per block (default 100); results do not depend on the number of workers
//   --iters N          solver Monte Carlo iterations (default 3000), --river-iters N (default 120)
// Output
//   --tag NAME         output file test/out/sim-<tag>.json (per-deal results), summary printed as JSON
//   --quiet            no progress lines
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { playHand, keyed, shuffled } = require('./game.js');
const bots = require('./bots.js');
const { solverAgent, envSolverOpts } = require('./agents.js');
const E0 = require('../../src/engine.js');
const ORDER = {}; E0.PREFLOP_ORDER.forEach((nm, i) => { ORDER[nm] = i; });
// Preflop-order rank of a starting hand (0 = AA).
function classRank(h) {
  const R = '23456789TJQKA', a = Math.max(h[0] >> 2, h[1] >> 2), b = Math.min(h[0] >> 2, h[1] >> 2);
  return ORDER[a === b ? R[a] + R[b] : R[a] + R[b] + ((h[0] & 3) === (h[1] & 3) ? 's' : 'o')];
}

const ROOT = path.join(__dirname, '..', '..');
const NAMES = ['Hero', 'Ann', 'Ben', 'Cat', 'Dan', 'Eve'];
const MIX = ['typical', 'station', 'maniac', 'typical', 'station'];

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) a[key] = true; else { a[key] = next; i++; }
  }
  return a;
}

function loadProfiles() {
  const f = path.join(__dirname, 'profiles.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

// Copies src/ of a git ref into test/out/refs/<ref>/src so a worker can require it.
function srcForRef(ref) {
  if (!ref) return path.join(ROOT, 'src');
  const safe = ref.replace(/[^\w.-]/g, '_');
  const dir = path.join(ROOT, 'test', 'out', 'refs', safe);
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git archive ${ref} src | tar -x -C ${JSON.stringify(dir)}`, { cwd: ROOT });
  return path.join(dir, 'src');
}
function commitOf(ref) {
  try { return execSync(`git rev-parse ${ref || 'HEAD'}`, { cwd: ROOT }).toString().trim() + (ref ? '' : '+worktree'); } catch (e) { return String(ref); }
}

function buildConfig(args) {
  const n = +(args.players || 2);
  if (n < 2 || n > 6) throw new Error('--players must be 2-6');
  const botsSpec = String(args.bots || 'typical');
  const home = /^(friends|home)/.test(botsSpec);
  const bb = +(args.bb || 2);
  const env = envSolverOpts();
  const parse = (s) => (s ? JSON.parse(s) : {});
  const bp = (k) => (args[k] === true ? '' : args[k] != null ? String(args[k]) : undefined);
  const variants = [{ name: 'A', agent: String(args.agent || 'solver'), src: srcForRef(args['a-ref']), ref: args['a-ref'] || 'working tree', commit: commitOf(args['a-ref']), solver: Object.assign({}, env, parse(args['a-opts'])), bp: bp('a-bp') }];
  if (args['b-opts'] || args['b-ref'] || args['b-agent'] || args['b-bp'] != null) {
    variants.push({ name: 'B', agent: String(args['b-agent'] || args.agent || 'solver'), src: srcForRef(args['b-ref']), ref: args['b-ref'] || 'working tree', commit: commitOf(args['b-ref']), solver: Object.assign({}, env, parse(args['b-opts'])), bp: bp('b-bp') });
  }
  // Solver opponents: src/ for each solver@ref named in --bots.
  const solverBots = {};
  for (const t of botsSpec.split(',')) {
    const m = /^solver(?:@(.+))?$/.exec(t);
    if (m && !solverBots[t]) solverBots[t] = { src: srcForRef(m[1]), commit: commitOf(m[1]) };
  }
  return {
    n, bots: botsSpec, solverBots, bb, sb: bb / 2, stack: Math.round(+(args.stack || (home ? 150 : 100)) * bb),
    hands: +(args.hands || 1000), seed: +(args.seed || 1), dup: args.dup !== '0',
    aivat: args.aivat === 'off' ? null : { pending: args.aivat && args.aivat !== true ? args.aivat : 'call', pfSamples: +(args['pf-samples'] || 2000), future: args.future != null ? +args.future : 0.8, cap: args.cap != null ? +args.cap : 1.5 },
    warm: args.warm != null ? +args.warm : 300, block: +(args.block || 100),
    workers: Math.max(1, +(args.workers || os.cpus().length)),
    iters: +(args.iters || 3000), riverIters: +(args['river-iters'] || 120),
    tag: args.tag || null, quiet: !!args.quiet, variants, profiles: loadProfiles(),
    diag: !!args.diag, parts: !!args.parts,
  };
}

// The bot spec for each opponent seat in this block.
function lineup(cfg, block) {
  const k = cfg.n - 1;
  const s = cfg.bots;
  if (s === 'mixed') return Array.from({ length: k }, (_, i) => MIX[i % MIX.length]);
  if (s === 'friends') {
    const ids = Object.keys(cfg.profiles).filter((id) => id !== 'pool' && id !== 'hero');
    if (!ids.length) return Array.from({ length: k }, () => 'home');
    const order = ids.map((id, i) => [keyed(cfg.seed, block, i, 5150), id]).sort((x, y) => x[0] - y[0]).map((x) => 'home:' + x[1]);
    return Array.from({ length: k }, (_, i) => order[i % order.length]);
  }
  if (s.includes(',')) {
    const list = s.split(',');
    return Array.from({ length: k }, (_, i) => list[i % list.length]);
  }
  return Array.from({ length: k }, () => s);
}

function makeHero(variant, cfg) {
  if (variant.agent === 'solver') return solverAgent({ src: variant.src, solver: variant.solver, iters: cfg.iters, riverIters: cfg.riverIters, blueprint: variant.bp });
  if (variant.agent === 'baseline') return bots.baseline();
  const m = /^bot:(.+)$/.exec(variant.agent);
  if (m) return bots.makeBot(m[1], cfg.profiles);
  throw new Error('unknown agent ' + variant.agent);
}

// Plays one block of deals for every variant. Deterministic in (seed, block).
function playBlock(cfg, block) {
  const n = cfg.n, rots = cfg.dup ? n : 1;
  const specs = lineup(cfg, block);
  const isSolver = (s) => !!(cfg.solverBots && cfg.solverBots[s]);
  const shared = specs.map((s) => (isSolver(s) ? null : bots.makeBot(s, cfg.profiles)));
  // Solver opponents keep reads (of hero too), so each variant gets its own copy; they watch the table from their seat.
  const botSets = cfg.variants.map(() => specs.map((s, j) => (isSolver(s)
    ? solverAgent({ src: cfg.solverBots[s].src, iters: cfg.iters, riverIters: cfg.riverIters, blueprint: '' }) : shared[j])));
  const watchersOf = (set) => set.map((b, j) => (b.onEvent ? { seat: j + 1, onEvent: (ev, data, snapFn) => b.onEvent(ev, data, snapFn) } : null)).filter(Boolean);
  const heroes = cfg.variants.map((v) => makeHero(v, cfg));
  const stacks = new Array(n).fill(cfg.stack);
  const deal = (d, rot, salt) => {
    const dealSeed = (Math.floor(keyed(cfg.seed, d, salt) * 4294967296)) >>> 0;
    const deck = shuffled(dealSeed);
    const hands = [];
    for (let i = 0; i < n; i++) { const j = (i + rot) % n; hands.push([deck[2 * j], deck[2 * j + 1]]); }
    const btn0 = d % n;
    return { hands, boardAll: deck.slice(2 * n, 2 * n + 5), btn: cfg.dup ? (btn0 - rot + n) % n : btn0, seed: (Math.floor(keyed(dealSeed, rot, 7) * 4294967296)) >>> 0 };
  };
  // Warm-up: a baseline player in hero's seat, every hero's tracker watching, so reads start warm.
  // Solver opponents play the warm-up too (the first variant's copies act; the others watch the same hands).
  // With solver opponents, hero's seat is warmed up by the solver as well (variant A's code): their reads of hero
  // then come from solver-like play, as hero's reads of them do (a simple player there gave the solver copies
  // wrong reads of hero, worth about +70 bb/100 to hero in self-play).
  const allWatchers = botSets.flatMap(watchersOf);
  const v0 = cfg.variants[0];
  const warmHero = allWatchers.length && v0.agent === 'solver'
    ? solverAgent({ src: v0.src, solver: v0.solver, iters: cfg.iters, riverIters: cfg.riverIters, blueprint: v0.bp }) : bots.baseline();
  const listeners = heroes.filter((h) => h.onEvent).concat(warmHero.onEvent ? [warmHero] : []);
  if (cfg.warm > 0 && (listeners.length || allWatchers.length)) {
    for (let w = 0; w < cfg.warm; w++) {
      const dl = deal(block * 100000 + w, 0, 31337);
      playHand(Object.assign({ n, stacks, sb: cfg.sb, bb: cfg.bb, seats: [warmHero].concat(botSets[0]), hero: 0, names: NAMES, uidBase: 1000,
        emit: listeners.length ? (ev, data, snapFn) => { const s = snapFn(); for (const h of listeners) h.tracker.handle(ev, data, s); } : null,
        watchers: allWatchers }, dl));
    }
  }
  // Count the solver opponents' decisions from here on (the warm-up is not part of the result).
  for (const set of botSets) for (const b of set) if (b.stats) Object.assign(b.stats, { decisions: 0, errors: 0, ms: 0, solved: {} });
  const out = [];
  const start = block * cfg.block, end = Math.min(cfg.hands, start + cfg.block);
  for (let d = start; d < end; d++) {
    const rec = { d };
    cfg.variants.forEach((v, vi) => {
      const hero = heroes[vi];
      const r = { net: 0, adj: 0, chance: 0, action: 0 };
      r.rots = [];
      for (let rot = 0; rot < rots; rot++) {
        const dl = deal(d, rot, 1);
        const diag = cfg.diag ? [] : null;
        if (diag && hero.tracker) hero.onDecision = (vw, input, res) => diag.push([vw.street, input.toCall > 0 ? 1 : 0, res.best.kind, Math.round((res.best.amount || 0) / cfg.bb * 10) / 10, res.solver ? res.solver.kind : '']);
        const res = playHand(Object.assign({ n, stacks, sb: cfg.sb, bb: cfg.bb, seats: [hero].concat(botSets[vi]), hero: 0, names: NAMES, uidBase: 1000 + rot * 100,
          aivat: cfg.aivat, parts: cfg.parts, emit: hero.onEvent ? (ev, data, snapFn) => hero.onEvent(ev, data, snapFn) : null, watchers: watchersOf(botSets[vi]) }, dl));
        r.net += res.net / rots / cfg.bb; r.adj += res.adj / rots / cfg.bb;
        r.chance += res.chance / rots / cfg.bb; r.action += res.action / rots / cfg.bb;
        // Per rotation: hero's hand (preflop-order rank), position (0 = button, 1 = next seat, ...), corrected result.
        const rot3 = [classRank(dl.hands[0]), (n - dl.btn) % n, Math.round(res.adj / cfg.bb * 1000) / 1000, Math.round(res.net / cfg.bb * 1000) / 1000];
        if (diag) rot3.push(diag);
        if (cfg.parts) rot3.push(res.parts);
        r.rots.push(rot3);
      }
      for (const k of ['net', 'adj', 'chance', 'action']) r[k] = Math.round(r[k] * 1000) / 1000;
      rec[v.name] = r;
    });
    out.push(rec);
  }
  const hs = heroes.map((h) => (h.stats ? h.stats : null));
  // Solver opponents' own counts, per variant: decisions and fallbacks to the simple player.
  const os = botSets.map((set) => set.filter((b) => b.stats).reduce((a, b) => ({ decisions: a.decisions + b.stats.decisions, errors: a.errors + b.stats.errors }), { decisions: 0, errors: 0 }));
  return { block, lineup: specs, deals: out, stats: hs, oppStats: os };
}

function meanSe(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, se: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1) : 0;
  return { mean: m, se: Math.sqrt(v / n), sd: Math.sqrt(v) };
}
const r1 = (x) => Math.round(x * 10) / 10;

function summarize(cfg, results, sec) {
  const deals = results.flatMap((b) => b.deals).sort((a, b) => a.d - b.d);
  const sum = { players: cfg.n, bots: cfg.bots, deals: deals.length, handsPlayed: deals.length * (cfg.dup ? cfg.n : 1) * cfg.variants.length,
    stackBB: cfg.stack / cfg.bb, dup: cfg.dup, aivat: cfg.aivat ? cfg.aivat.pending : 'off', warm: cfg.warm, sec: Math.round(sec), variants: {} };
  for (const v of cfg.variants) {
    const raw = meanSe(deals.map((x) => x[v.name].net)), adj = meanSe(deals.map((x) => x[v.name].adj));
    const st = results.map((b) => b.stats[cfg.variants.indexOf(v)]).filter(Boolean);
    const dec = st.reduce((a, s) => a + s.decisions, 0), ms = st.reduce((a, s) => a + s.ms, 0);
    const solved = {}; for (const s of st) for (const [k, c] of Object.entries(s.solved || {})) solved[k] = (solved[k] || 0) + c;
    sum.variants[v.name] = { agent: v.agent, ref: v.ref, solver: v.solver,
      bb100: r1(raw.mean * 100), se100: r1(raw.se * 100), aivatBB100: r1(adj.mean * 100), aivatSE100: r1(adj.se * 100),
      seRatio: adj.se > 0 ? Math.round((raw.se / adj.se) * 100) / 100 : null,
      decisions: dec, msPerDecision: dec ? Math.round(ms / dec) : 0, errors: st.reduce((a, s) => a + s.errors, 0), solved };
    if (cfg.solverBots && Object.keys(cfg.solverBots).length) {
      const vi = cfg.variants.indexOf(v), o = results.map((b) => (b.oppStats || [])[vi]).filter(Boolean);
      sum.variants[v.name].solverOpponents = { decisions: o.reduce((a, x) => a + x.decisions, 0), errors: o.reduce((a, x) => a + x.errors, 0) };
    }
  }
  if (cfg.variants.length === 2) {
    const raw = meanSe(deals.map((x) => x.B.net - x.A.net)), adj = meanSe(deals.map((x) => x.B.adj - x.A.adj));
    sum.diff = { 'B-A bb100': r1(raw.mean * 100), se100: r1(raw.se * 100), aivatBB100: r1(adj.mean * 100), aivatSE100: r1(adj.se * 100),
      seRatio: adj.se > 0 ? Math.round((raw.se / adj.se) * 100) / 100 : null };
  }
  return { sum, deals };
}

// Finished blocks are appended to test/out/sim-<tag>.blocks.jsonl, keyed by everything that affects them, so a
// run that was cut off (the cloud container can be reclaimed) picks up where it stopped when started again.
// Bumped when a change to the simulator changes results, so saved blocks from before are not mixed in.
const SIM_VERSION = 2;
function blockKey(cfg) {
  const crypto = require('crypto');
  const v = cfg.variants.map((x) => [x.agent, x.agent === 'solver' ? x.commit : null, x.solver, x.bp]);
  const k = [SIM_VERSION, cfg.n, cfg.bots, Object.values(cfg.solverBots || {}).map((x) => x.commit), cfg.bb, cfg.stack, cfg.seed, cfg.dup, cfg.aivat, cfg.warm, cfg.block, cfg.iters, cfg.riverIters, v, cfg.profiles];
  return crypto.createHash('sha1').update(JSON.stringify(k)).digest('hex').slice(0, 16);
}
function runMain(cfg) {
  const blocks = Math.ceil(cfg.hands / cfg.block);
  const results = [];
  let saveFile = null;
  const key = blockKey(cfg);
  if (cfg.tag) {
    saveFile = path.join(ROOT, 'test', 'out', `sim-${cfg.tag}.blocks.jsonl`);
    fs.mkdirSync(path.dirname(saveFile), { recursive: true });
    if (fs.existsSync(saveFile)) {
      for (const line of fs.readFileSync(saveFile, 'utf8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (r.key === key && r.block < blocks && !results.some((x) => x.block === r.block)) results.push(r); } catch (e) { /* torn line */ }
      }
      if (results.length && !cfg.quiet) process.stderr.write(`resuming: ${results.length} blocks already done\n`);
    }
  }
  const queue = Array.from({ length: blocks }, (_, i) => i).filter((b) => !results.some((x) => x.block === b));
  if (!queue.length) return Promise.resolve(summarize(cfg, results, 0));
  const t0 = Date.now();
  const nw = Math.min(cfg.workers, queue.length);
  return new Promise((resolve, reject) => {
    let live = nw;
    for (let w = 0; w < nw; w++) {
      const worker = new Worker(__filename, { workerData: { cfg } });
      const feed = () => { if (queue.length) worker.postMessage(queue.shift()); else worker.postMessage(null); };
      worker.on('message', (m) => {
        results.push(m);
        if (saveFile) fs.appendFileSync(saveFile, JSON.stringify(Object.assign({ key }, m)) + '\n');
        if (!cfg.quiet) {
          const done = results.reduce((a, b) => a + b.deals.length, 0);
          const partial = summarize(cfg, results, (Date.now() - t0) / 1000).sum;
          const line = Object.entries(partial.variants).map(([k, v]) => `${k} ${v.aivatBB100}±${v.aivatSE100}`).join('  ') + (partial.diff ? `  B-A ${partial.diff.aivatBB100}±${partial.diff.aivatSE100}` : '');
          process.stderr.write(`[${done}/${cfg.hands} deals, ${Math.round((Date.now() - t0) / 1000)}s] ${line}\n`);
        }
        feed();
      });
      worker.on('error', reject);
      worker.on('exit', () => { if (--live === 0) resolve(results); });
      feed();
    }
  }).then((res) => summarize(cfg, res, (Date.now() - t0) / 1000));
}

if (!isMainThread) {
  const { cfg } = workerData;
  parentPort.on('message', (block) => {
    if (block == null) { process.exit(0); return; }
    parentPort.postMessage(playBlock(cfg, block));
  });
} else if (require.main === module) {
  const cfg = buildConfig(parseArgs(process.argv.slice(2)));
  runMain(cfg).then(({ sum, deals }) => {
    const outDir = path.join(ROOT, 'test', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const tag = cfg.tag || `${cfg.variants.map((v) => v.agent).join('-')}_${cfg.n}p_${cfg.bots.replace(/[^\w]/g, '')}_${cfg.seed}`;
    fs.writeFileSync(path.join(outDir, `sim-${tag}.json`), JSON.stringify({ sum, deals }));
    console.log(JSON.stringify(sum, null, 1));
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildConfig, parseArgs, playBlock, summarize, lineup, meanSe };
