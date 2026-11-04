// Checks the river solver's EVs facing a bet against the bots' real hands (run.js with RIVERDUMP=<file>).
// Heads-up river decisions facing a bet, first decision of the hand only. With the bettor's cards known, calling has an
// exact value (hero's share of the pot after the call, minus the call), so for each raise the paired gap
// (what the raise brought - what a call would have) - (raise EV - call EV) shows whether the solver's raise
// EVs are too high against calling, apart from how good hero's hand is.
// Usage: node test/sim/river-check.js <dump.jsonl> [variant=A]
'use strict';
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '../../src/engine.js'));
const [file, vname] = process.argv.slice(2);
const V = vname || 'A';
const seen = new Set();
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  const x = JSON.parse(line);
  if (x.v !== V) continue;
  const key = x.d + ':' + x.rot;
  if (seen.has(key)) continue;
  seen.add(key);
  const inp = x.input, o = inp.opponents[0];
  const seat = x.names.indexOf(o.name);
  if (seat < 0 || !x.board || x.board.length < 5 || !x.log) continue;
  const toCard = (c) => (typeof c === 'number' ? c : E.parseCard(c));
  const board = x.board.map(toCard), hero = x.hands[0].map(toCard), opp = x.hands[seat].map(toCard);
  const hs = E.evaluate(hero.concat(board), 7), os = E.evaluate(opp.concat(board), 7);
  const share = hs > os ? 1 : hs === os ? 0.5 : 0;
  // Hero's chips in before this decision: everything hero put in before the first river action facing a bet.
  let put = 0, k = -1;
  for (let i = 0; i < x.log.length; i++) {
    const e = x.log[i];
    if (e.hero && e.st === 'river' && (e.facing || 0) > 0) { k = i; break; }
    if (e.hero) put += e.amt || 0;
  }
  if (k < 0) continue;
  const after = x.log.slice(k + 1).filter((e) => e.st === 'river' && !e.hero && e.who === o.name).map((e) => e.act);
  const R = x.net + put;
  const C = share * (inp.pot + inp.toCall) - inp.toCall;
  const ev = (kind) => { const r = x.ranked.find((s) => s.kind === kind || (kind === 'raise' && s.kind === 'allin' && s.amount > inp.toCall)); return r ? r.ev : null; };
  rows.push({ kind: x.best.kind === 'allin' && x.best.amount <= inp.toCall + 1e-9 ? 'call' : x.best.kind === 'allin' ? 'raise' : x.best.kind,
    bb: inp.bigBlind, R, C, share, eq: x.eq, evBest: x.best.ev, evCall: ev('call') != null ? ev('call') : ev('allin'), evRaise: ev('raise'),
    resp: after[0] || null, pot: inp.pot, toCall: inp.toCall, frac: inp.toCall / Math.max(1, inp.pot - inp.toCall), solver: x.solver });
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const se = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1) / Math.max(1, a.length)); };
const f = (a) => `${mean(a).toFixed(2).padStart(6)} ± ${se(a).toFixed(2).padStart(5)}`;
console.log(`heads-up river decisions facing a bet: ${rows.length} (variant ${V}); values in bb`);
for (const kind of ['fold', 'call', 'raise']) {
  const rs = rows.filter((r) => r.kind === kind);
  if (!rs.length) continue;
  console.log(`\n${kind}: n ${rs.length}, solver eq ${mean(rs.map((r) => r.eq)).toFixed(3)}, real share ${mean(rs.map((r) => r.share)).toFixed(3)}`);
  console.log(`  EV of the advice ${f(rs.map((r) => r.evBest / r.bb))}   came back ${f(rs.map((r) => (kind === 'fold' ? 0 : r.R) / r.bb))}`);
  console.log(`  call: solver EV ${f(rs.map((r) => (r.evCall || 0) / r.bb))}   exact value ${f(rs.map((r) => r.C / r.bb))}`);
  if (kind === 'raise') {
    console.log(`  raise - call: solver ${f(rs.map((r) => (r.evRaise - r.evCall) / r.bb))}   real ${f(rs.map((r) => (r.R - r.C) / r.bb))}   gap ${f(rs.map((r) => ((r.R - r.C) - (r.evRaise - r.evCall)) / r.bb))}`);
    const resp = {}; for (const r of rs) resp[r.resp || '?'] = (resp[r.resp || '?'] || 0) + 1;
    console.log(`  bettor's answer: ${JSON.stringify(resp)}`);
    for (const [lo, hi, nm] of [[0, 0.55, 'eq < 0.55'], [0.55, 0.8, 'eq 0.55-0.8'], [0.8, 1.01, 'eq 0.8+']]) {
      const z = rs.filter((r) => r.eq >= lo && r.eq < hi);
      if (z.length) console.log(`  ${nm.padEnd(12)} n ${String(z.length).padStart(3)} share ${mean(z.map((r) => r.share)).toFixed(2)} raise-call solver ${f(z.map((r) => (r.evRaise - r.evCall) / r.bb))} real ${f(z.map((r) => (r.R - r.C) / r.bb))}`);
    }
  }
  for (const [lo, hi, nm] of [[0, 0.6, 'bet < 0.6 pot'], [0.6, 1.1, 'bet 0.6-1.1'], [1.1, 99, 'bet 1.1+']]) {
    const z = rs.filter((r) => r.frac >= lo && r.frac < hi);
    if (z.length) console.log(`  ${nm.padEnd(14)} n ${String(z.length).padStart(3)} solver eq ${mean(z.map((r) => r.eq)).toFixed(3)} real share ${mean(z.map((r) => r.share)).toFixed(3)}`);
  }
}
