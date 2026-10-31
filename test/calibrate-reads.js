// How well the starting read (a player we know nothing about) predicts the hands people really
// showed, over every live showdown in one or more exported hand logs. For each shown hand it
// rebuilds the range street by street from the player's line and reports where the hand fell out.
// Usage: node test/calibrate-reads.js <log.json> [more logs...]   (V=1 lists the misses)
//   vsGuess: geometric mean of (weight of the shown hand / average weight). 1 = a random guess.
//   hits: shown hand in the likelier half of the range (calibrated: 50%).
//   outside: shown hand below the top 90% of the range's weight (calibrated: 10%).
const fs = require('fs');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');

const files = process.argv.slice(2);
if (!files.length) { console.log('usage: node test/calibrate-reads.js <log.json> [more logs...]'); process.exit(1); }
const rows = [];
const steps = {};
for (const f of files) {
  for (const x of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (!x.board || x.board.length < 3) continue;
    for (const p of x.players) {
      if (p.hero || !p.shown || p.shown.length !== 2 || p.folded) continue;
      const actions = { pre: T.streetAction(p.actions.pre || [], 0) };
      if (actions.pre === 'pending') actions.pre = 'call';
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (x.board.length >= n) actions[k] = T.streetAction(p.actions[k] || [], n);
      const sizes = {};
      for (const a of x.log || []) if (a.who === p.name && a.st !== 'pre' && a.potPct != null) sizes[a.st] = a.potPct / 100;
      const hole = p.shown.map(E.parseCard), board = x.board.map(E.parseCard);
      if (hole.some((c) => c < 0) || board.some((c) => c < 0)) continue;
      const k = E.comboIndex(Math.max(...hole), Math.min(...hole));
      const stats = E.computeStats(T.blankTally(), 'typical');
      const strengths = { 0: E.boardStrength([]) };
      for (const n of [3, 4, 5]) if (board.length >= n) strengths[n] = E.boardStrength(board.slice(0, n));
      const top = (W) => {
        let tot = 0, above = 0, same = 0;
        for (let j = 0; j < W.length; j++) { tot += W[j]; if (W[j] > W[k] + 1e-12) above += W[j]; else if (Math.abs(W[j] - W[k]) <= 1e-12) same += W[j]; }
        return (above + same / 2) / tot;
      };
      const line = { pre: actions.pre };
      const trail = [['pre:' + actions.pre, top(E.buildRange(stats, line, strengths, board, sizes, undefined, p.position, true))]];
      let W = null;
      for (const st of ['flop', 'turn', 'river']) {
        if (!actions[st]) break;
        line[st] = actions[st];
        W = E.buildRange(stats, line, strengths, board, sizes, undefined, p.position, true);
        const sz = sizes[st];
        trail.push([st + ':' + actions[st] + (sz != null && /bet|raise/.test(actions[st]) ? (sz < 0.3 ? ' <30%' : sz < 0.6 ? ' 30-60%' : ' 60%+') : ''), top(W)]);
      }
      W = W || E.buildRange(stats, line, strengths, board, sizes, undefined, p.position, true);
      let tot = 0, live = 0;
      for (let j = 0; j < W.length; j++) if (W[j] > 0) { tot += W[j]; live++; }
      rows.push({ name: p.name, cards: p.shown.join(''), board: x.board.join(''), trail, lr: Math.log(Math.max(1e-3, W[k] / (tot / live))) });
      trail.forEach(([key, v], i) => {
        const s = steps[key] || (steps[key] = { n: 0, out: 0 });
        s.n++;
        if (v > 0.9 && (i === 0 || trail[i - 1][1] <= 0.9)) s.out++;
      });
    }
  }
}
const fin = (r) => r.trail[r.trail.length - 1][1];
const n = rows.length;
const pct = (c) => Math.round((100 * c) / Math.max(1, n)) + '%';
console.log(`${n} live showdowns. vsGuess ${Math.exp(rows.reduce((a, r) => a + r.lr, 0) / Math.max(1, n)).toFixed(2)}, ` +
  `hits ${pct(rows.filter((r) => fin(r) < 0.5).length)} (calibrated 50%), outside ${pct(rows.filter((r) => fin(r) > 0.9).length)} (calibrated 10%)`);
console.log('step                 times  pushed the shown hand out of the range');
for (const [key, s] of Object.entries(steps).sort((a, b) => b[1].out - a[1].out || b[1].n - a[1].n)) {
  if (s.out) console.log(key.padEnd(20), String(s.n).padStart(5), String(s.out).padStart(6));
}
if (process.env.V) for (const r of rows.filter((x) => fin(x) > 0.9)) console.log(r.name, r.cards, r.board, r.trail.map(([a, v]) => a + ' ' + v.toFixed(2)).join(' | '));
