// Replays a real session from an exported hand log: rebuilds the tracker and the reads from each
// hand's raw events, and re-runs the solver at every hero decision with this version's code.
// Usage:
//   node test/replay-log.js <patio-hand-log.json> [hands]            advice at every decision
//   node test/replay-log.js <log.json> [hands] --vs <other checkout>  only decisions that changed
// `hands` is "all" or a list of hand numbers (0 = first hand in the log), e.g. 9,25,26.
// `--vs` takes another checkout of the repo (git worktree add /tmp/main origin/main) and prints the
// decisions where its advice differs from this one. Runs are deterministic (mix off, fixed seed).
// Env: ITER=<n> overrides the Monte Carlo iterations, DB=<file> writes the rebuilt reads.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const vsAt = args.indexOf('--vs');
const vsRepo = vsAt >= 0 ? path.resolve(args[vsAt + 1]) : null;
const [logPath, which] = args.filter((a, i) => vsAt < 0 || (i !== vsAt && i !== vsAt + 1));
if (!logPath) { console.log('usage: node test/replay-log.js <log.json> [all|0,5,9] [--vs <other checkout>]'); process.exit(1); }
const hands = JSON.parse(fs.readFileSync(logPath, 'utf8'));
const only = which && which !== 'all' ? which.split(',').map(Number) : null;

function run(repo) {
  const E = require(path.join(repo, 'src/engine.js'));
  const T = require(path.join(repo, 'src/tracker.js'));
  // authUserId by name from the chat log (reads are keyed by it): the id seen most often with each
  // name, because admin lines in the game log carry the target's nick with the admin's id. The hero
  // comes from each hand (screen names can change mid-session).
  const votes = {};
  for (const x of hands) for (const r of x.raw || []) {
    if (r.ev === 'chat_message' && r.d && r.d.username && r.d.userId && r.d.userId !== -1) {
      const v = votes[r.d.username] || (votes[r.d.username] = {});
      v[r.d.userId] = (v[r.d.userId] || 0) + 1;
    }
  }
  const auth = {};
  for (const [name, v] of Object.entries(votes)) auth[name] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  for (const x of hands) for (const p of x.players) if (!auth[p.name]) auth[p.name] = 'name:' + p.name;
  const t = new T({ players: {} });
  t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
  const fmt = (sc) => (sc.label || sc.kind) + (sc.amount ? ' ' + Math.round(sc.amount * 100) / 100 : '');
  const out = [];
  let cur = -1, snap = null;
  t.on((type, p) => {
    if (type !== 'turn' || !p.isHero || (only && !only.includes(cur))) return;
    const b = t.solverInput('typical');
    if (b.error) return;
    const input = Object.assign({}, b.input, { mix: false, seed: 1 });
    if (process.env.ITER) input.iterations = +process.env.ITER;
    const r = E.analyzeSync(input);
    out.push({
      key: `#${cur} ${['pre', , , 'flop', 'turn', 'river'][b.board.length]} ${b.heroCards.join('')} [${b.board.join(' ')}] pot ${input.pot} to call ${input.toCall}`,
      best: r.best ? fmt(r.best) : '?',
      eq: r.equity ? Math.round(r.equity.share * 100) / 100 : null,
      opts: (r.ranked || []).slice(0, 5).map((s) => fmt(s) + ' ' + (Math.round((s.ev || 0) * 100) / 100)).join(', '),
      opps: input.opponents.map((o) => o.name + ' ' + Object.values(o.actions).filter(Boolean).join('/')).join('; '),
    });
  });
  hands.forEach((x, i) => {
    cur = i;
    const heroName = (x.players.find((p) => p.hero) || {}).name;
    for (const r of x.raw || []) {
      if (r.s) {
        snap = {
          heroAuthId: auth[heroName], bigBlind: r.bb || (snap && snap.bigBlind) || x.bigBlind,
          players: r.s.map(([id, name, stack, posType, playState]) => ({ id, name, stack, posType, playState, authUserId: auth[name] })),
        };
      }
      t.handle(r.ev, r.d, r.s ? snap : null);
    }
  });
  if (process.env.DB && repo === path.resolve(__dirname, '..')) fs.writeFileSync(process.env.DB, JSON.stringify(t.db));
  return out;
}

const mine = run(path.resolve(__dirname, '..'));
if (!vsRepo) {
  for (const o of mine) console.log(`${o.key} -> ${o.best} (equity ${o.eq})\n    ${o.opts}\n    ${o.opps}`);
} else {
  const other = run(vsRepo);
  const byKey = new Map(other.map((o) => [o.key, o]));
  let changed = 0;
  for (const o of mine) {
    const v = byKey.get(o.key);
    if (v && v.best === o.best) continue;
    changed++;
    console.log(`${o.key}\n    other: ${v ? v.best + ' (equity ' + v.eq + ')  ' + v.opts : 'no decision'}\n    this:  ${o.best} (equity ${o.eq})  ${o.opts}`);
  }
  console.log(`${changed} of ${mine.length} decisions changed`);
}
