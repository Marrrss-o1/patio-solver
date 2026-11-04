// Measures the friend bots' usual ranges for the v8 bots (bots.js REF): at every decision after the flop, the bot's
// own range (rebuilt from its line, as v8 does) and the made-hand percentile at quantiles 0, 0.05, ..., 1 of it,
// averaged by street and spot (open: checked to, face: facing a bet, raised: re-raised after betting or raising).
// Bots play 4-handed with the baseline player in the fourth seat, rotating lineups, like calibrate.js.
//
//   BOTPROFILES=test/sim/profiles-v7.json node test/sim/v8-ref.js [--hands 6000] [--out test/sim/v8-ref.json]
//   [--bot-params '{"rel":1}'] [--seed 1]
'use strict';
const fs = require('fs');
const path = require('path');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const HANDS = +opt('hands', 6000), OUT = opt('out', null), SEED = +opt('seed', 1);
const extra = JSON.parse(opt('bot-params', '{}'));
const profiles = JSON.parse(fs.readFileSync(process.env.BOTPROFILES ? path.resolve(process.env.BOTPROFILES) : path.join(__dirname, 'profiles-v7.json'), 'utf8'));
const ids = Object.keys(profiles).filter((id) => id !== 'pool' && id !== 'hero');
const Q = 21;
const acc = [0, 1, 2].map(() => Object.fromEntries(bots.SPOTS.map((s) => [s, { n: 0, sum: new Float64Array(Q), mass: 0 }])));
function record(bot, v) {
  if (v.street === 0) return;
  const W = bot.rangeBefore(v), tbl = bots.boardTable(v.board);
  const L = tbl.live.filter((k) => W[k] > 0).sort((a, b) => tbl.hp[a] - tbl.hp[b]);
  let tot = 0; for (const k of L) tot += W[k];
  if (!(tot > 0)) return;
  const sp = bots.spotOf(v);
  recordAt(acc[v.street - 3][sp], L, W, tbl, tot);
  if (sp === 'open') recordAt(acc[v.street - 3][bots.openLine(v)], L, W, tbl, tot);
}
function recordAt(a, L, W, tbl, tot) {
  // hp at quantile x: the first combo whose cumulative weight (mid-point) reaches x, linearly between neighbours.
  const mids = [], hs = []; let cum = 0;
  for (const k of L) { mids.push((cum + W[k] / 2) / tot); hs.push(tbl.hp[k]); cum += W[k]; }
  let j = 0;
  for (let i = 0; i < Q; i++) {
    const x = i / (Q - 1);
    while (j < mids.length - 1 && mids[j + 1] < x) j++;
    let h;
    if (x <= mids[0]) h = hs[0];
    else if (j >= mids.length - 1) h = hs[hs.length - 1];
    else { const f = (x - mids[j]) / Math.max(1e-12, mids[j + 1] - mids[j]); h = hs[j] + Math.min(1, Math.max(0, f)) * (hs[j + 1] - hs[j]); }
    a.sum[i] += h;
  }
  a.n++;
}
const t0 = Date.now();
for (let blk = 0; blk < Math.ceil(HANDS / 100); blk++) {
  const order = ids.map((id, i) => [keyed(SEED, blk, i, 99), id]).sort((x, y) => x[0] - y[0]).map((x) => x[1]).slice(0, 3);
  const seats = [bots.baseline()].concat(order.map((id) => {
    const b = bots.homeBot(Object.assign({}, profiles[id].params, extra));
    return { rangeAware: true, policy(v) { record(b, v); return b.policy(v); }, rangeBefore: b.rangeBefore };
  }));
  for (let h = 0; h < 100; h++) {
    const d = blk * 100 + h;
    const deck = shuffled((SEED * 7919 + d * 104729) >>> 0);
    const hands = []; for (let i = 0; i < 4; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
    playHand({ n: 4, btn: d % 4, hands, boardAll: deck.slice(8, 13), stacks: [300, 300, 300, 300], sb: 1, bb: 2, seats, hero: 0, seed: (SEED * 1000003 + d) >>> 0 });
  }
  if (blk % 10 === 9) process.stderr.write(`${(blk + 1) * 100} hands, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
const out = {};
const r3 = (x) => Math.round(x * 1000) / 1000;
for (let s = 0; s < 3; s++) {
  out[s] = {};
  for (const sp of bots.SPOTS) {
    const a = acc[s][sp];
    out[s][sp] = a.n ? Array.from(a.sum, (x) => r3(x / a.n)) : null;
    console.log(['flop', 'turn', 'river'][s], sp.padEnd(6), 'n', String(a.n).padStart(6), out[s][sp] ? out[s][sp].filter((_, i) => i % 4 === 0).join(' ') : '-');
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
