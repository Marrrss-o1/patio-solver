// Where does an A/B difference come from? Splits the paired, luck-corrected difference B - A by hero's
// position and by starting-hand group, using the per-hand records in test/out/sim-<tag>.json.
//   node test/sim/diff.js test/out/sim-<tag>.json
'use strict';
const fs = require('fs');
const { deals, sum } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!deals.length || !deals[0].B) { console.log('not an A/B run'); process.exit(0); }
const n = sum.players;
const POS = n === 2 ? ['button (SB)', 'big blind'] : ['button', 'small blind', 'big blind', 'early 1', 'early 2', 'early 3'].slice(0, n);
// Hand groups by preflop order rank (0 = AA): roughly top 3%, 3-10%, 10-25%, 25-50%, bottom half.
const GROUPS = [[0, 9, 'premium (AA-88, AKs, AQs)'], [9, 25, 'strong'], [25, 55, 'good'], [55, 100, 'medium'], [100, 169, 'weak']];
const stat = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const v = xs.length > 1 ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) : 0;
  return { m, se: Math.sqrt(v / Math.max(1, xs.length)), n: xs.length };
};
const rows = [];
for (const d of deals) d.A.rots.forEach((ra, i) => { const rb = d.B.rots[i]; rows.push({ rank: ra[0], pos: ra[1], diff: rb[2] - ra[2], a: ra[2], b: rb[2] }); });
// Each hand's share of the total: mean over hands x (hands in the group / all hands), in bb per 100 hands.
const total = rows.length;
const line = (label, xs) => {
  const s = stat(xs.map((r) => r.diff));
  const share = (s.m * s.n / total) * 100, shareSe = (s.se * s.n / total) * 100;
  return `${label.padEnd(28)} ${String(s.n).padStart(6)} hands  B-A ${(s.m * 100).toFixed(0).padStart(6)} ± ${(s.se * 100).toFixed(0).padEnd(4)} bb/100 of these hands   adds ${share.toFixed(1).padStart(6)} ± ${shareSe.toFixed(1)} to the total`;
};
console.log(`${sum.players} players, bots ${sum.bots}, ${deals.length} deals. A: ${JSON.stringify(sum.variants.A.solver)} ${sum.variants.A.ref}; B: ${JSON.stringify(sum.variants.B.solver)} ${sum.variants.B.ref}`);
console.log(line('all hands', rows));
console.log('by position');
POS.forEach((nm, p) => console.log('  ' + line(nm, rows.filter((r) => r.pos === p))));
console.log('by starting hand');
for (const [lo, hi, nm] of GROUPS) console.log('  ' + line(nm, rows.filter((r) => r.rank >= lo && r.rank < hi)));
console.log('hands where A and B ended the same: ' + rows.filter((r) => Math.abs(r.diff) < 1e-9).length + ' of ' + total);
