// Checks what an exploiter preset does (bot-only hands, a simple regular in hero's seat): expected action shares in the
// spots each red-team preset changes, for the preset and for the plain base bot.
//   node test/sim/xp-check.js <preset> [hands] [players]
'use strict';
const path = require('path');
const fs = require('fs');
const { playHand, keyed, shuffled } = require('./game.js');
const bots = require('./bots.js');
const { makeSeatBot } = require('./exploiters.js');

const preset = process.argv[2] || 'none', H = +(process.argv[3] || 3000), n = +(process.argv[4] || 4);
const profiles = JSON.parse(fs.readFileSync(process.env.BOTPROFILES ? path.resolve(process.env.BOTPROFILES) : path.join(__dirname, 'profiles.json'), 'utf8'));
const others = Object.keys(profiles).filter((k) => /^f\d+$/.test(k)).map((k) => 'home:' + k);
function run(spec) {
  const acc = {};
  const add = (k, x, w = 1) => { const a = acc[k] || (acc[k] = { n: 0, s: 0 }); a.n += w; a.s += x * w; };
  const xp = makeSeatBot(spec, profiles);
  const wrapped = { policy(v) {
    const d = xp.policy(v);
    const tot = d.reduce((a, x) => a + x.p, 0);
    const m = (pred) => d.filter(pred).reduce((a, x) => a + x.p, 0) / tot;
    const bet = (x) => x.t === 'raise';
    if (v.street === 0) {
      if (v.raises === 0) add('pre: plays first in/over limps', m((x) => x.t !== 'fold' && !(x.t === 'check' && v.toCall > 0)) - (v.toCall === 0 ? m((x) => x.t === 'check') : 0));
      if (v.raises === 0) add('pre: raises first in/over limps', m(bet));
      if (v.raises >= 1 && v.toCall > 0) add('pre: continues facing a raise', 1 - m((x) => x.t === 'fold'));
      return d;
    }
    const { hp, outs } = bots.post(v.hand, v.board);
    const air = hp < 0.5 && !(v.street < 5 && outs >= 8), strong = hp > 0.85;
    const key = { 3: 'flop', 4: 'turn', 5: 'river' }[v.street], prevKey = { 4: 'flop', 5: 'turn' }[v.street];
    if (v.toCall === 0) {
      const pb = m(bet);
      add(`${key}: bets when checked to`, pb);
      if (prevKey && (v.seq[prevKey] || []).includes('call') && !(v.seq[prevKey] || []).some((k) => k === 'bet' || k === 'raise')) {
        add(`${key}: bets after calling ${prevKey}`, pb);
        add(`${key}: share of those bets with air`, air ? 1 : 0, pb);
      }
      for (const x of d) if (bet(x) && x.p > 0) { const f = x.to / Math.max(1, v.pot); add(f >= 0.95 ? `${key}: hand strength of bets >= pot` : f <= 0.55 ? `${key}: hand strength of bets <= 0.55 pot` : `${key}: hand strength of other bets`, hp, x.p / tot); }
      if (v.heroIn && strong && v.street <= 4) add(`${key}: strong hand bets in hero's pot`, pb);
      if (v.heroIn && v.heroChecked && v.street === 5) {
        add('river: bets after hero checked', pb);
        add('river: hand strength of bets after hero checked', hp, pb);
        add('river: hand strength of checks after hero checked', hp, 1 - pb);
        add('river: share of bets after hero checked under 0.4', hp < 0.4 ? 1 : 0, pb);
      }
    } else {
      const checked = (v.seq[key] || []).includes('check');
      if (checked && v.raises === 1) add(`${key}: check-raises after checking`, m(bet));
      if (checked && v.raises === 1) add(`${key}: folds after checking`, m((x) => x.t === 'fold'));
      if (v.heroIn && strong && v.street <= 4) add(`${key}: strong hand raises facing a bet in hero's pot`, m(bet));
    }
    return d;
  } };
  if (xp.onHand) wrapped.onHand = xp.onHand;
  const hero = bots.baseline();
  const seats = [hero, wrapped];
  for (let i = 2; i < n; i++) seats.push(bots.makeBot(others[i % others.length], profiles));
  const stacks = new Array(n).fill(300);
  if (process.env.XPSTACK) stacks[1] = +process.env.XPSTACK * 2;
  for (let h = 0; h < H; h++) {
    if (xp.onHand) xp.onHand(h);
    const deck = shuffled((keyed(7, h) * 4294967296) >>> 0);
    const hands = []; for (let i = 0; i < n; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
    playHand({ n, stacks, sb: 1, bb: 2, seats, hero: 0, btn: h % n, hands, boardAll: deck.slice(2 * n, 2 * n + 5), seed: (keyed(9, h) * 4294967296) >>> 0 });
  }
  return acc;
}
const a = run('xp:' + preset), b = run('xp:none');
const keys = [...new Set(Object.keys(a).concat(Object.keys(b)))].sort();
for (const k of keys) {
  const f = (x) => (x ? (x.s / x.n).toFixed(3) + ' (' + Math.round(x.n) + ')' : '-');
  console.log(k.padEnd(55), 'preset', f(a[k]).padEnd(16), 'base', f(b[k]));
}
