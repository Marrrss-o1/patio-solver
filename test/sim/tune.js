// Tuning sweep: several solver settings ("arms") on the same deals, each paired against one shared baseline.
// Every arm is its own single-variant run.js run (tag tune-<set>-<arm>), so arms can be added later without replaying
// the others, and runs grow in stages (all arms to 400 deals, then all to 800, ...) so every arm has a number early.
//
//   node test/sim/tune.js --arms '{"base":{},"r0":{"patch":{"robust":0}},"cap1":{"patch":{"betSizes":[0.33,0.5,0.75,1]}}}' \
//        --set friends4 --stages 400,800,1600 --players 4 --bots friends [--seed 11] [--prune 2] [other run.js options]
//   node test/sim/tune.js --arms <same JSON or a .json file> --set friends4 --report    # table from what's saved
//
// An arm is { patch: knobs.js edits, opts: extra solver input }. The first arm is the baseline. --prune Z stops an arm
// after a stage once it is more than Z standard errors below the baseline. Results: test/out/tune-<set>.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const run = require('./run.js');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const args = run.parseArgs(argv);
const armsArg = String(args.arms || '');
const arms = JSON.parse(armsArg.trim().startsWith('{') ? armsArg : fs.readFileSync(armsArg, 'utf8'));
const names = Object.keys(arms);
if (!names.length) throw new Error('--arms: no arms');
const set = String(args.set || 'main');
const stages = String(args.stages || '400,800,1600').split(',').map(Number);
const prune = args.prune != null ? +args.prune : null;
// run.js options passed through to every arm (everything except tune.js's own).
const OWN = new Set(['arms', 'set', 'stages', 'prune', 'report', 'hands', 'tag', 'a-patch', 'a-opts', 'b-patch', 'b-opts', 'quiet']);
const pass = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2), v = argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  if (!OWN.has(k)) pass.push(argv[i], ...(v != null ? [v] : []));
  if (v != null) i++;
}
const armArgs = (nm, hands) => pass.concat(['--hands', String(hands), '--tag', `tune-${set}-${nm}`,
  '--a-patch', JSON.stringify(arms[nm].patch || {}), '--a-opts', JSON.stringify(arms[nm].opts || {})]);

// Saved per-deal results of an arm: d -> { adj, net } from its blocks file, for the arm's exact settings.
function load(nm) {
  const cfg = run.buildConfig(run.parseArgs(armArgs(nm, 1e9)));
  const key = run.blockKey(cfg);
  const f = path.join(ROOT, 'test', 'out', `sim-tune-${set}-${nm}.blocks.jsonl`);
  const out = new Map();
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (r.key !== key) continue;
    for (const d of r.deals) out.set(d.d, { adj: d.A.adj, net: d.A.net, rots: d.A.rots });
  }
  return out;
}
const meanSe = (xs) => run.meanSe(xs);
const r1 = (x) => Math.round(x * 10) / 10;

function report(live) {
  const data = Object.fromEntries(names.map((nm) => [nm, load(nm)]));
  const base = data[names[0]];
  const rows = [];
  for (const nm of names) {
    const a = data[nm];
    const ds = [...a.keys()].filter((d) => base.has(d)).sort((x, y) => x - y);
    for (const d of ds.slice(0, 3)) { // the same cards in both (hero's hand rank and position per rotation)
      const x = a.get(d).rots, y = base.get(d).rots;
      if (x && y && x.some((r, j) => r[0] !== y[j][0] || r[1] !== y[j][1])) throw new Error(`arm ${nm}: deal ${d} has different cards from the baseline (settings differ?)`);
    }
    const own = meanSe([...a.values()].map((x) => x.adj));
    const diff = meanSe(ds.map((d) => a.get(d).adj - base.get(d).adj));
    const raw = meanSe(ds.map((d) => a.get(d).net - base.get(d).net));
    const same = ds.filter((d) => Math.abs(a.get(d).net - base.get(d).net) < 1e-9).length;
    rows.push({ arm: nm, patch: arms[nm].patch || {}, opts: arms[nm].opts || {}, deals: a.size, paired: ds.length,
      aivatBB100: r1(own.mean * 100), aivatSE100: r1(own.se * 100),
      diff: nm === names[0] ? null : { aivatBB100: r1(diff.mean * 100), aivatSE100: r1(diff.se * 100), rawBB100: r1(raw.mean * 100), rawSE100: r1(raw.se * 100), sameDeals: same },
      live: live ? live.has(nm) : undefined });
  }
  const out = { set, args: pass, stages, arms: rows };
  fs.writeFileSync(path.join(ROOT, 'test', 'out', `tune-${set}.json`), JSON.stringify(out, null, 1));
  const w = Math.max(...names.map((n) => n.length), 4);
  console.log(`set ${set}: ${pass.join(' ')}`);
  for (const r of rows) {
    const d = r.diff ? `vs ${names[0]} ${String(r.diff.aivatBB100).padStart(6)} ± ${String(r.diff.aivatSE100).padEnd(5)} (raw ${r.diff.rawBB100} ± ${r.diff.rawSE100}, ${r.diff.sameDeals} of ${r.paired} deals unchanged)` : '(baseline)';
    console.log(`${r.arm.padEnd(w)} ${String(r.deals).padStart(5)} deals  ${String(r.aivatBB100).padStart(6)} ± ${String(r.aivatSE100).padEnd(5)} ${d}${r.live === false ? '  [stopped]' : ''}`);
  }
  return rows;
}

if (args.report) { report(); process.exit(0); }
const live = new Set(names);
for (const hands of stages) {
  for (const nm of names) {
    if (!live.has(nm)) continue;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...armArgs(nm, hands), '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`arm ${nm} failed (exit ${r.status})`);
    process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${nm} at ${hands} deals (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const rows = report(live);
  if (prune != null) for (const r of rows) if (r.diff && r.diff.aivatBB100 + prune * r.diff.aivatSE100 < 0) live.delete(r.arm);
}
