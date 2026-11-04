// TD check of the solver's EVs on simulated hands (run.js --diag): for each hero decision, the chosen action's EV
// against the EV at hero's next decision less the chips put in between (or, at the last decision, what came back).
// Mean TD by kind of spot is how far the EVs are from what follows; the preflop rows check the preflop solver's flop
// leaves against the postflop solver. Usage: node test/sim/td.js test/out/sim-<tag>.json [variant=A]
'use strict';
const fs = require('fs');
const [file, vname] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
const V = vname || 'A';
const rows = [];
let hand = 0;
for (const d of R.deals) {
  const v = d[V]; if (!v) continue;
  for (const rot of v.rots) {
    hand++;
    const net = rot[3], diag = rot[4];
    if (!Array.isArray(diag)) continue;
    diag.forEach((x, k) => {
      const [st, facing, kind, amt, solver, Q, put, pot, nOpp] = x;
      if (Q == null) return;
      const nx = diag[k + 1];
      const td = nx ? nx[5] - (nx[6] - put) - Q : net + put - Q;
      rows.push({ hand, st, facing, kind, amt, solver, Q, put, pot, nOpp, td, next: nx ? nx[0] : -1, last: !nx });
    });
  }
}
function summ(name, rs) {
  rs = rs.filter((r) => r.kind !== 'fold');
  if (!rs.length) return;
  const by = new Map(); for (const r of rs) { const v = by.get(r.hand) || { s: 0, n: 0 }; v.s += r.td; v.n++; by.set(r.hand, v); }
  const N = rs.length, m = rs.reduce((s, r) => s + r.td, 0) / N;
  let va = 0; for (const x of by.values()) va += (x.s - x.n * m) ** 2; va /= N * N;
  const srt = rs.map((r) => r.td).sort((a, b) => a - b);
  console.log(`${name.padEnd(36)} n ${String(N).padStart(5)}  Q ${(rs.reduce((s, r) => s + r.Q, 0) / N).toFixed(2).padStart(6)}  td ${m.toFixed(2).padStart(6)} ± ${Math.sqrt(va).toFixed(2).padStart(5)}  median ${srt[Math.floor(N / 2)].toFixed(2).padStart(6)}`);
}
const SN = { 0: 'pre', 3: 'flop', 4: 'turn', 5: 'river' };
summ('all', rows);
for (const st of [0, 3, 4, 5]) {
  summ(SN[st], rows.filter((r) => r.st === st));
  for (const k of ['check', 'call', 'bet', 'raise', 'allin']) summ(`  ${SN[st]} ${k}`, rows.filter((r) => r.st === st && r.kind === k));
}
console.log('--- preflop decisions whose next decision is on the flop');
for (const k of ['check', 'call', 'raise', 'allin']) for (const hu of [1, 2]) {
  summ(`pre ${k} -> flop ${hu === 1 ? 'HU' : 'MW'}`, rows.filter((r) => r.st === 0 && r.kind === k && r.next === 3 && (hu === 1 ? r.nOpp === 1 : r.nOpp > 1)));
}
summ('pre raise (any next)', rows.filter((r) => r.st === 0 && r.kind === 'raise'));
summ('pre raise pot<5bb', rows.filter((r) => r.st === 0 && r.kind === 'raise' && r.pot < 5));
console.log('--- to-go: what came back from the decision on, minus its EV');
const togo = new Map();
for (const r of rows) (togo.get(r.hand) || togo.set(r.hand, []).get(r.hand)).push(r);
const tg = [];
for (const list of togo.values()) { let s = 0; for (let k = list.length - 1; k >= 0; k--) { s += list[k].td; tg.push(Object.assign({}, list[k], { td: s })); } }
summ('to-go pre raise', tg.filter((r) => r.st === 0 && r.kind === 'raise'));
summ('to-go pre call', tg.filter((r) => r.st === 0 && r.kind === 'call'));
summ('to-go first flop decision', tg.filter((r) => r.st === 3 && !rows.some((x) => x.hand === r.hand && x.st === 3 && x.put < r.put)));
summ('to-go flop all', tg.filter((r) => r.st === 3));
