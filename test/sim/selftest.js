// Checks the simulator itself: hand logs identical to the real tracker's, chips conserved, side pots,
// AIVAT corrections with zero mean, and results that do not depend on the number of workers.
//   node test/sim/selftest.js
'use strict';
const assert = require('assert');
const path = require('path');
const T = require('../../src/tracker.js');
const { playHand, payouts, shuffled } = require('./game.js');
const bots = require('./bots.js');
const { buildConfig, playBlock, summarize } = require('./run.js');

let checks = 0;
const ok = (c, msg) => { assert.ok(c, msg); checks++; };

// 1. The simulator's own hand-log entries match what the real tracker records from its events.
for (const n of [2, 3, 4, 6]) {
  const tr = new T({ players: {} });
  const seats = [bots.baseline()].concat(Array.from({ length: n - 1 }, (_, i) => bots.makeBot(['home', 'maniac', 'station', 'typical', 'home'][i])));
  for (let d = 0; d < 120; d++) {
    const deck = shuffled(d + 1);
    const hands = []; for (let i = 0; i < n; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
    const res = playHand({ n, btn: d % n, hands, boardAll: deck.slice(2 * n, 2 * n + 5), stacks: new Array(n).fill(200 + (d % 7) * 40), sb: 1, bb: 2, seats, hero: 0,
      names: ['Hero', 'A', 'B', 'C', 'D', 'E'], seed: d, log: true, emit: (ev, data, snapFn) => tr.handle(ev, data, snapFn()) });
    tr.handle('game:stage_began', { stageType: 'set_blinds' }, { tableType: 'private', heroAuthId: 'P0', bigBlind: 2, players: [] });
    const te = tr.db.history[tr.db.history.length - 1], ge = res.entry;
    const strip = (l) => l.map((e) => { const o = Object.assign({}, e); delete o.ms; delete o.hero; return JSON.stringify(o); });
    const pl = (e) => JSON.stringify(e.players.map((p) => [p.name, p.position, p.folded, p.put, p.actions, p.shown]));
    ok(JSON.stringify(strip(te.log)) === JSON.stringify(strip(ge.log)), `log differs from the tracker's (n=${n}, deal ${d})`);
    ok(pl(te) === pl(ge) && JSON.stringify(te.board) === JSON.stringify(ge.board), `players differ from the tracker's (n=${n}, deal ${d})`);
    ok(Math.abs(res.nets.reduce((a, b) => a + b, 0)) < 1e-9, 'chips not conserved');
  }
}

// 1b. A seat watching with its own tracker (solver opponents) records the same hand as hero's overlay would
//     from that seat: same log, players and board as a tracker fed the hand with that seat as hero.
for (const n of [2, 4]) {
  const w = new T({ players: {} }), ref = new T({ players: {} });
  const seats = [bots.baseline()].concat(Array.from({ length: n - 1 }, (_, i) => bots.makeBot(['home', 'maniac', 'station'][i])));
  const end = (tr, me) => tr.handle('game:stage_began', { stageType: 'set_blinds' }, { tableType: 'private', heroAuthId: 'P' + me, bigBlind: 2, players: [] });
  for (let d = 0; d < 60; d++) {
    const deck = shuffled(d + 777);
    const hands = []; for (let i = 0; i < n; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
    const base = { n, btn: d % n, hands, boardAll: deck.slice(2 * n, 2 * n + 5), stacks: new Array(n).fill(300), sb: 1, bb: 2, seats, names: ['Hero', 'A', 'B', 'C'], seed: d };
    playHand(Object.assign({ hero: 0, watchers: [{ seat: 1, onEvent: (ev, data, snapFn) => w.handle(ev, data, snapFn()) }] }, base));
    playHand(Object.assign({ hero: 1, emit: (ev, data, snapFn) => ref.handle(ev, data, snapFn()) }, base));
    end(w, 1); end(ref, 1);
    const a = w.db.history[w.db.history.length - 1], b = ref.db.history[ref.db.history.length - 1];
    const strip = (e) => JSON.stringify([e.hero, e.board, e.log.map((x) => { const o = Object.assign({}, x); delete o.ms; return o; }), e.players.map((p) => [p.name, p.position, p.folded, p.put, p.actions, p.shown])]);
    ok(a && b && strip(a) === strip(b), `watching seat's tracker differs (n=${n}, deal ${d})`);
  }
}

// 2. Side pots: a short all-in can only win the main pot.
{
  const out = new Float64Array(3);
  payouts([50, 100, 100], [false, false, false], [9, 5, 1], out);
  ok(out[0] === 150 && out[1] === 100 && out[2] === 0, 'side pot split wrong: ' + Array.from(out));
  payouts([50, 100, 100], [false, false, true], [1, 5, 9], out);
  ok(out[0] === 0 && out[1] === 250, 'folded player won a pot');
}

// 3. AIVAT corrections average to zero (bots with known strategies in every seat, so it is fast).
{
  const cfg = buildConfig({ hands: '3000', players: '3', bots: 'friends', agent: 'baseline', workers: '1', quiet: true, warm: '0' });
  const res = [];
  for (let b = 0; b < 30; b++) res.push(playBlock(cfg, b));
  const deals = res.flatMap((r) => r.deals);
  for (const k of ['chance', 'action']) {
    const xs = deals.map((d) => d.A[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const se = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
    ok(Math.abs(m) < 3.5 * se + 1e-9, `${k} correction mean ${m.toFixed(3)} bb is not zero (se ${se.toFixed(3)})`);
  }
  const s = summarize(cfg, res, 0).sum.variants.A;
  ok(s.aivatSE100 < s.se100, 'AIVAT did not reduce the noise');
  console.log(`AIVAT check: raw ${s.bb100} ± ${s.se100}, corrected ${s.aivatBB100} ± ${s.aivatSE100} bb/100 (3,000 deals, 3-handed, baseline vs friends)`);
}

// 4. Same seed, same results, however the blocks are spread over workers (blocks are independent).
{
  const cfg = buildConfig({ hands: '40', players: '4', bots: 'mixed', agent: 'baseline', block: '10', quiet: true });
  const a = JSON.stringify([0, 1, 2, 3].map((b) => playBlock(cfg, b).deals));
  const b = JSON.stringify([3, 1, 0, 2].map((x) => playBlock(cfg, x)).sort((x, y) => x.block - y.block).map((x) => x.deals));
  ok(a === b, 'results depend on block order');
}
console.log(`sim selftest: ${checks} checks passed (${path.basename(__filename)})`);
