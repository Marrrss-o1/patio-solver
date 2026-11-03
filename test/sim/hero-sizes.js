// Hero's own bet-size tell: the solver against friend bots (no luck correction, no duplicate deals), recording each
// postflop bet or raise hero makes when checked to: size as a share of the pot and hero's made-hand percentile.
//   node test/sim/hero-sizes.js [hands] [players] [budget]
'use strict';
const path = require('path'); const fs = require('fs');
const { playHand, keyed, shuffled } = require('./game.js');
const bots = require('./bots.js');
const { solverAgent } = require('./agents.js');
const H = +(process.argv[2] || 400), n = +(process.argv[3] || 4), budget = process.argv[4] || null;
const profiles = JSON.parse(fs.readFileSync(process.env.BOTPROFILES ? path.resolve(process.env.BOTPROFILES) : path.join(__dirname, 'profiles.json'), 'utf8'));
const others = Object.keys(profiles).filter((k) => /^f\d+$/.test(k)).map((k) => 'home:' + k);
const hero = solverAgent(budget ? { budget } : {});
const rows = [];
const inner = hero.act.bind(hero);
hero.act = (v) => {
  const a = inner(v);
  if (v.street >= 3 && v.toCall === 0 && a.t === 'raise') {
    const { hp, outs } = bots.post(v.hand, v.board);
    rows.push({ st: v.street, f: (a.to - v.myBet) / Math.max(1, v.pot), hp, draw: v.street < 5 && outs >= 8 ? 1 : 0, nOpp: v.nOpp });
  }
  return a;
};
const seats = [hero];
for (let i = 1; i < n; i++) seats.push(bots.makeBot(others[(i * 3) % others.length], profiles));
const stacks = new Array(n).fill(300);
const NAMES = ['Hero', 'Ann', 'Ben', 'Cat', 'Dan', 'Eve'];
for (let h = 0; h < H; h++) {
  const deck = shuffled((keyed(11, h) * 4294967296) >>> 0);
  const hands = []; for (let i = 0; i < n; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
  playHand({ n, stacks, sb: 1, bb: 2, seats, hero: 0, btn: h % n, hands, boardAll: deck.slice(2 * n, 2 * n + 5), seed: (keyed(13, h) * 4294967296) >>> 0, names: NAMES,
    emit: (ev, data, snapFn) => hero.onEvent(ev, data, snapFn) });
}
const B = [[0, 0.45, 'under 45% pot'], [0.45, 0.85, '45-85%'], [0.85, 1.25, '85-125%'], [1.25, 9, '125%+']];
for (const [lo, hi, nm] of B) {
  const r = rows.filter((x) => x.f >= lo && x.f < hi);
  if (!r.length) continue;
  const m = (k) => (r.reduce((a, x) => a + x[k], 0) / r.length).toFixed(3);
  console.log(nm.padEnd(14), 'n', String(r.length).padStart(4), 'made-hand pct', m('hp'), 'draws', m('draw'), 'weak (<0.5, no draw)', (r.filter((x) => x.hp < 0.5 && !x.draw).length / r.length).toFixed(2));
}
const lf = rows.map((x) => Math.log(x.f)), hp = rows.map((x) => x.hp);
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
const ml = mean(lf), mh = mean(hp);
const cov = rows.reduce((a, x, i) => a + (lf[i] - ml) * (hp[i] - mh), 0), vh = hp.reduce((a, x) => a + (x - mh) ** 2, 0);
console.log('bets', rows.length, 'slope of log size on made-hand percentile', (cov / vh).toFixed(2));
