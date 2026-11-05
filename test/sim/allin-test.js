// Preflop all-in re-raises: how often a player facing a raise goes all-in, by their chips (stack + chips in, in big
// blinds) and by how many raises came before, and which hands do it (class rank, 0 = AA, from the shown hands in a log,
// from every hand for bots). Fits the jam rate over one raise as jam x (40bb / chips)^k (the v10 bots' `jam`, `jamK`).
//
//   node test/sim/allin-test.js <export.json> ...                     (hand-log exports; hands in several are counted once)
//   node test/sim/allin-test.js --bots test/sim/profiles-v10.json --hands 6000 [--stacks 150,30,60,100]
//        (bots against each other, 4-handed with the hero bot like range-test.js; the stacks rotate with the button)
'use strict';
const fs = require('fs');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');
const E = require('../../src/engine.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));

function botHands(profFile, N, stacksBB) {
  const profiles = JSON.parse(fs.readFileSync(profFile, 'utf8'));
  const ids = Object.keys(profiles).filter((id) => id !== 'hero' && id !== 'pool');
  const hero = profiles.hero ? bots.homeBot(profiles.hero.params) : bots.baseline();
  const st = stacksBB.map((x) => Math.round(x * 2));
  const out = [];
  for (let blk = 0; blk < Math.ceil(N / 100); blk++) {
    const order = ids.map((id, i) => [keyed(blk, i, 4711), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 3);
    const names = ['hero'].concat(order);
    const seats = [hero].concat(order.map((id) => bots.homeBot(profiles[id].params)));
    for (let h = 0; h < 100 && out.length < N; h++) {
      const d = blk * 100 + h, deck = shuffled((d * 2654435761 + 12345) >>> 0);
      const hands = []; for (let i = 0; i < 4; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
      const stacks = st.map((_, i) => st[(i + d) % 4]);
      const entry = playHand({ n: 4, btn: d % 4, hands, boardAll: deck.slice(8, 13), stacks, sb: 1, bb: 2, seats, hero: 0, names, seed: (d * 40503 + 7) >>> 0, log: true }).entry;
      out.push({ entry, hole: (nm) => hands[names.indexOf(nm)] });
    }
  }
  return out;
}

function logHands(fs_) {
  const byT = new Map();
  for (const f of fs_) for (const h of JSON.parse(fs.readFileSync(f, 'utf8'))) if (!byT.has(h.t)) byT.set(h.t, h);
  const card = (c) => { const x = E.parseCard(c); return x == null || x < 0 ? null : x; };
  return [...byT.values()].map((h) => ({ entry: h, hole: (nm) => {
    const p = (h.players || []).find((x) => x.name === nm), s = p && p.shown;
    const c = s && s.length === 2 ? s.map(card) : null;
    return c && c.every((x) => x != null) ? c : null;
  } }));
}

const isBots = !!opt('bots', null);
const H = isBots ? botHands(opt('bots'), +opt('hands', 6000), String(opt('stacks', '150,150,150,150')).split(',').map(Number)) : logHands(files);
const rows = [];
for (const { entry: h, hole } of H) {
  const bb = h.bigBlind || 2, put = {};
  let raises = 0;
  for (const e of h.log || []) {
    if (e.st !== 'pre') break;
    if (e.act === 'sb' || e.act === 'bb') { put[e.who] = (put[e.who] || 0) + e.amt; continue; }
    const isR = e.act === 'raise' || e.act === '3bet' || e.act === 'bet';
    if (raises >= 1 && !e.hero && e.who !== 'hero') {
      const c = hole(e.who);
      rows.push({ raises, chips: (e.stack + (put[e.who] || 0)) / bb, rr: isR, allin: isR && e.stack - e.amt < 0.1 * e.to, pct: c ? bots.pfPct(c) : null });
    }
    if (isR) raises++;
    put[e.who] = (put[e.who] || 0) + e.amt;
  }
}
const f3 = (x) => x.toFixed(3);
console.log(`${H.length} hands, ${rows.length} answers to a raise, ${rows.filter((r) => r.rr).length} re-raises, ${rows.filter((r) => r.allin).length} all-in`);
for (const [lo, hi] of [[0, 30], [30, 60], [60, 100], [100, 200], [200, Infinity]]) {
  const F = rows.filter((r) => r.chips >= lo && r.chips < hi); if (!F.length) continue;
  const A = F.filter((r) => r.allin), sh = A.filter((r) => r.pct != null).map((r) => r.pct).sort((a, b) => a - b);
  const byK = [1, 2, 3].map((k) => { const f = F.filter((r) => Math.min(3, r.raises) === k); return `${f.filter((r) => r.allin).length}/${f.length}`; }).join(', ');
  const few = sh.length <= 12 ? sh : Array.from({ length: 11 }, (_, i) => sh[Math.round((i * (sh.length - 1)) / 10)]);
  console.log(`chips ${lo}-${hi}bb: ${F.length} spots, re-raise ${f3(F.filter((r) => r.rr).length / F.length)}, all-in ${f3(A.length / F.length)} ` +
    `(over 1 / 2 / 3+ raises ${byK}); all-in hands' class rank ${sh.length ? `median ${sh[sh.length >> 1].toFixed(2)} [${few.map((x) => x.toFixed(2)).join(' ')}]${sh.length > 12 ? ' (deciles)' : ''}` : '-'}`);
}
const RR = rows.filter((r) => r.rr && !r.allin && r.pct != null).map((r) => r.pct).sort((a, b) => a - b);
if (RR.length) console.log(`re-raises not all-in: class rank median ${RR[RR.length >> 1].toFixed(2)}, 80th percentile ${RR[Math.floor(RR.length * 0.8)].toFixed(2)} (n ${RR.length})`);
// Jams over one raise: Poisson fit of exp(a + b ln(chips / 40bb)).
const S = rows.filter((r) => r.raises === 1);
let a = -3, b = -1;
for (let it = 0; it < 100; it++) {
  let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
  for (const s of S) { const x = Math.log(Math.max(5, s.chips) / 40), m = Math.exp(a + b * x), y = s.allin ? 1 : 0; ga += y - m; gb += (y - m) * x; haa += m; hab += m * x; hbb += m * x * x; }
  const det = haa * hbb - hab * hab; if (!(det > 0)) break;
  a += (hbb * ga - hab * gb) / det; b += (haa * gb - hab * ga) / det;
}
console.log(`jams over one raise: ${S.filter((r) => r.allin).length} of ${S.length}; fit jam ${Math.exp(a).toFixed(4)} x (40bb / chips)^${(-b).toFixed(2)}` +
  ` (${[20, 40, 80, 150].map((d) => `${d}bb ${f3(Math.exp(a + b * Math.log(d / 40)))}`).join(', ')})`);
