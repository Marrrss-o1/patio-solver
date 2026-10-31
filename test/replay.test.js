// Replays recorded and synthetic Poker Patio event streams through the tracker
// and solver, and checks the numbers the solver is given. Run: npm test
const assert = require('assert');
const path = require('path');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');

let failures = 0;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

// Feed a list of {ev, data, snap} messages; collect solver inputs at each hero turn.
function replay(msgs, db) {
  const t = new T(db || { players: {} });
  const turns = [];
  t.on((type, p) => {
    if (type === 'turn' && p.isHero) {
      const b = t.solverInput('typical');
      turns.push(b);
    }
  });
  for (const m of msgs) {
    if (m.ev === 'hook:attached') { t.snap = m.snap; continue; }
    t.handle(m.ev, m.data, m.snap);
  }
  return { t, turns };
}

// ---------------------------------------------------------------------------
// 1. Real heads-up hand recorded from a private lobby (Hero = s1, button/SB)
// ---------------------------------------------------------------------------
const real = require(path.join(__dirname, 'fixtures/real-hand.json'));

test('real hand: three hero decisions found', () => {
  const { turns } = replay(real);
  assert.strictEqual(turns.length, 3);
  turns.forEach((x) => assert.ok(!x.error, x.error));
});

test('real hand: preflop numbers', () => {
  const x = replay(real).turns[0];
  assert.deepStrictEqual(x.heroCards, ['2h', 'Jc']);
  assert.strictEqual(x.input.pot, 15);
  assert.strictEqual(x.input.toCall, 5);
  assert.strictEqual(x.input.inPosition, true);
  assert.strictEqual(x.input.opponents[0].actions.pre, 'pending');
});

test('real hand: flop facing a bet', () => {
  const x = replay(real).turns[1];
  assert.deepStrictEqual(x.board, ['4s', '9s', 'Js']);
  assert.strictEqual(x.input.pot, 50);
  assert.strictEqual(x.input.toCall, 30);
  assert.deepStrictEqual(x.input.opponents[0].actions, { pre: 'check', flop: 'bet' });
});

test('real hand: turn facing a small bet', () => {
  const x = replay(real).turns[2];
  assert.strictEqual(x.input.pot, 90);
  assert.strictEqual(x.input.toCall, 10);
  assert.deepStrictEqual(x.input.opponents[0].actions, { pre: 'check', flop: 'bet', turn: 'bet' });
});

test('real hand: opponent tally after the hand', () => {
  const { t } = replay(real);
  const tally = t.db.players.V.tally;
  // BB checked preflop (pfFold); bet flop, bet turn, folded to the raise.
  // The fixture ends with the next hand's set_blinds, which ages counts by one decay step.
  near(tally.pfFold, T.DECAY);
  near(tally.bet, 2 * T.DECAY);
  near(tally.fold, T.DECAY);
});

test('hand log: every action with amount, pot, stack, advice match and result', () => {
  const t = new T({ players: {} });
  t.on((type, p) => {
    if (type === 'turn' && p.isHero) {
      const b = t.solverInput('typical');
      const r = E.analyzeSync(Object.assign({}, b.input, { iterations: 800, riverIterations: 50, mix: false, seed: 1 }));
      t.noteAdvice(r.best.kind, r.best.ev, r, (sc) => sc.kind + ' ' + Math.round(sc.amount || 0));
    }
  });
  for (const m of real) {
    if (m.ev === 'hook:attached') { t.snap = m.snap; continue; }
    t.handle(m.ev, m.data, m.snap);
  }
  const e = t.db.history[0];
  const acts = e.log.map((x) => `${x.st} ${x.who} ${x.act} ${x.amt}`);
  assert.deepStrictEqual(acts, [
    'pre Hero sb 5', 'pre Testforyou bb 10', 'pre Hero call 5', 'pre Testforyou check 0',
    'flop Testforyou bet 30', 'flop Hero call 30', 'turn Testforyou bet 10', 'turn Hero raise 40', 'turn Testforyou fold 0',
  ]);
  const flopBet = e.log[4];
  assert.strictEqual(flopBet.pot, 20);
  assert.strictEqual(flopBet.potPct, 150);
  assert.strictEqual(flopBet.stack, 980);
  const heroRaise = e.log[7];
  assert.strictEqual(heroRaise.facing, 10);
  assert.strictEqual(heroRaise.pot, 90);
  assert.strictEqual(e.advice.length, 3);
  for (const a of e.advice) {
    assert.ok(a.did, 'hero action matched to advice');
    assert.ok(typeof a.followed === 'boolean');
    assert.ok(a.options.length >= 2 && a.pot > 0 && a.equity > 0);
  }
  assert.strictEqual(e.advice[2].did, 'raise 40');
  assert.strictEqual(e.players.find((p) => p.hero).stack, 1010);
  assert.deepStrictEqual(e.net, { Hero: 50, Testforyou: -50 });
  assert.strictEqual(e.heroNetBB, 5);
});

test('real hand: solver returns a sane recommendation on the turn', () => {
  const x = replay(real).turns[2];
  const r = E.analyzeSync(Object.assign({}, x.input, { iterations: 6000 }));
  assert.ok(['call', 'raise', 'allin'].includes(r.best.kind), 'two pair should not fold to a $10 bet, got ' + r.best.kind);
});

// ---------------------------------------------------------------------------
// 2. Synthetic 3-handed hand: checks seat order, position and opponent order
//    Seats: s1 Hero, s3 Ann (button), s7 Bob. Clockwise = ascending seat number.
//    Button s3 -> SB s7 -> BB s1 (Hero).
// ---------------------------------------------------------------------------
function snap3(h, a, b, states) {
  states = states || {};
  return {
    tableType: 'private', heroAuthId: 'H', bigBlind: 10,
    players: [
      { id: 1, authUserId: 'H', name: 'Hero', stack: h, posType: 's1', playState: states.h || 'playing' },
      { id: 3, authUserId: 'A', name: 'Ann', stack: a, posType: 's3', playState: states.a || 'playing' },
      { id: 7, authUserId: 'B', name: 'Bob', stack: b, posType: 's7', playState: states.b || 'playing' },
    ],
  };
}
const three = [];
const push = (ev, data, snap) => three.push({ ev, data, snap });
let s = snap3(1000, 1000, 1000);
push('game:stage_began', { stageType: 'set_blinds' }, s);
push('game:dealer_updated', { dealerSeatPos: 's3' }, s);
push('game:small_blind_paid', { amount: 5, playerId: 7 }, s);
push('game:big_blind_paid', { amount: 10, playerId: 1 }, s);
push('game:cards_dealt_to_player', [{ playerPos: 's1', cardData: { uniqueID: 11 } }, { playerPos: 's1', cardData: { uniqueID: 12 } }], s);
push('game:update_card_data', { cardData: { uniqueID: 11, suite: 'spades', value: 'A' } }, s);
push('game:update_card_data', { cardData: { uniqueID: 12, suite: 'hearts', value: 'K' } }, s);
push('game:stage_began', { stageType: 'pre_flop' }, s);
push('player:game:action_taken', { playerID: 3, actionType: 'raise', makeBetValue: 30 }, s); // Ann opens to 30
push('player:game:action_taken', { playerID: 7, actionType: 'call', makeBetValue: 25 }, snap3(990, 1000, 995)); // Bob calls from SB
s = snap3(990, 970, 970);
push('game:player_turn_started', { playerID: 1 }, s); // Hero in BB facing 30
push('player:game:action_taken', { playerID: 1, actionType: 'call', makeBetValue: 20 }, s);
push('game:stage_began', { stageType: 'flop' }, snap3(970, 970, 970));
push('game:cards_deal_to_stack', [
  { emitData: { stackID: 'community_stack', cardData: { suite: 'diamonds', value: 'K' } } },
  { emitData: { stackID: 'community_stack', cardData: { suite: 'clubs', value: '7' } } },
  { emitData: { stackID: 'community_stack', cardData: { suite: 'hearts', value: '2' } } },
], snap3(970, 970, 970));
push('player:game:action_taken', { playerID: 7, actionType: 'check', makeBetValue: 0 }, snap3(970, 970, 970)); // Bob (SB) first
push('game:player_turn_started', { playerID: 1 }, snap3(970, 970, 970)); // Hero next, Ann (button) behind

test('3-handed: preflop pot, price and opponent order', () => {
  const { turns } = replay(three);
  const x = turns[0];
  assert.ok(!x.error, x.error);
  assert.strictEqual(x.input.pot, 70);       // 30 + 30 + 10
  assert.strictEqual(x.input.toCall, 20);
  assert.deepStrictEqual(x.input.opponents.map((o) => o.name), ['Ann', 'Bob']); // act after hero: s3 then s7
  assert.strictEqual(x.input.opponents[0].actions.pre, 'raise');
  assert.strictEqual(x.input.opponents[1].actions.pre, 'call');
});

test('3-handed: hero is out of position on the flop (button still to act)', () => {
  const x = replay(three).turns[1];
  assert.strictEqual(x.input.pot, 90);
  assert.strictEqual(x.input.toCall, 0);
  assert.strictEqual(x.input.inPosition, false);
  assert.deepStrictEqual(x.input.opponents.map((o) => o.name), ['Ann', 'Bob']);
  assert.deepStrictEqual(x.input.opponents[1].actions, { pre: 'call', flop: 'check' });
  assert.strictEqual(x.input.opponents[0].actions.flop, '');
});

test('3-handed: solver handles two opponents', () => {
  const x = replay(three).turns[1];
  const r = E.analyzeSync(Object.assign({}, x.input, { iterations: 4000 }));
  assert.strictEqual(r.opponents.length, 2);
  assert.ok(r.best && typeof r.best.ev === 'number');
});

// ---------------------------------------------------------------------------
// 3. Synthetic heads-up hand to showdown: Vic calls an open, check-calls the
//    c-bet, bets pot on the turn and 1/6 pot on the river, then shows 7c6c.
// ---------------------------------------------------------------------------
const sd = require(path.join(__dirname, 'fixtures/synth-showdown.json'));

test('showdown hand: detailed tallies', () => {
  const t = replay(sd).t.db.players.V.tally;
  assert.strictEqual(t.pf3betOpp, 1);
  assert.strictEqual(t.pf3bet, 0);
  assert.deepStrictEqual(t.st.flop, { check: 1, bet: 0, call: 1, raise: 0, fold: 0 });
  assert.strictEqual(t.st.turn.bet, 1);
  assert.strictEqual(t.st.river.bet, 1);
  assert.strictEqual(t.vs.medium.call, 1);            // called 30 into 60
  assert.strictEqual(t.vsCbet, 1);
  assert.strictEqual(t.foldCbet, 0);
  assert.strictEqual(t.betSize.n, 2);
  assert.ok(Math.abs(t.betSize.sum - (1 + 60 / 360)) < 1e-9);
  assert.strictEqual(t.sawFlop, 1);
  assert.strictEqual(t.wtsd, 1);
});

test('showdown hand: revealed cards are logged with their bets', () => {
  const shows = replay(sd).t.db.players.V.tally.shows;
  assert.strictEqual(shows.length, 1);
  assert.deepStrictEqual(shows[0].cards, ['7c', '6c']);
  assert.deepStrictEqual(shows[0].board, ['Kd', '8h', '2s', '3d', 'Ac']);
  assert.deepStrictEqual(shows[0].agg, [{ n: 4, frac: 1 }, { n: 5, frac: 0.17 }]);
});

test('showdown hand: bet sizes reach the solver input', () => {
  const x = replay(sd).turns[3];
  assert.strictEqual(x.input.pot, 420);
  assert.strictEqual(x.input.toCall, 60);
  assert.deepStrictEqual(x.input.opponents[0].sizes, { turn: 1, river: 0.17 });
});

test('showdown hand: hero c-bet is counted as hero being the preflop raiser', () => {
  const x = replay(sd).turns[1];
  assert.strictEqual(x.input.opponents[0].pfAggressor, false);
});

test('hand log: shown hands carry how well the read fit, and running accuracy', () => {
  const t = new T({ players: {} });
  t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
  for (const m of sd) {
    if (m.ev === 'hook:attached') { t.snap = m.snap; continue; }
    t.handle(m.ev, m.data, m.snap);
  }
  const v = t.db.history[0].players.find((p) => !p.hero);
  assert.ok(v.fit && v.fit.top >= 0 && v.fit.top <= 1, JSON.stringify(v.fit));
  assert.strictEqual(v.accuracy.n, 1);
});

test('preflop: big raises faced and called are counted', () => {
  const snap = { tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 100, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 100, posType: 's2', playState: 'playing' }] };
  const t = new T({ players: {} });
  t.snap = snap;
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 29 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 28 }],
  ]) t.handle(ev, data, snap);
  const tally = t.db.players.V.tally;
  assert.strictEqual(tally.pfBigOpp, 1);
  assert.strictEqual(tally.pfBigCall, 1);
});

test('old saved reads get the new fields', () => {
  const db = { players: { V: { name: 'Vic', tally: { pfFold: 3, pfCall: 2, pfRaise: 1, check: 4, bet: 2, call: 1, raise: 0, fold: 3 } } } };
  const t = replay(sd, db).t.db.players.V.tally;
  near(t.pfFold, 3 * T.DECAY);
  near(t.pfCall, 2 * T.DECAY + 1);
  assert.strictEqual(t.shows.length, 1);
  assert.strictEqual(t.st.river.bet, 1);
});

// ---------------------------------------------------------------------------
// 4. Engine: opponent modelling from the new reads
// ---------------------------------------------------------------------------
const C = (s) => s.split(' ').map(E.parseCard);
const tallyWith = (extra) => Object.assign(T.blankTally(), { pfFold: 60, pfCall: 45, pfRaise: 25, check: 60, bet: 36, call: 30, raise: 6, fold: 36 }, extra);
const bluffShow = { cards: ['7c', '6c'], board: ['Kd', '8h', '2s', '3d', 'Ac'], agg: [{ n: 4, frac: 1 }, { n: 5, frac: 1 }] };
const valueShow = { cards: ['Ah', 'Kc'], board: ['Kd', '8h', '2s', '3d', 'Ac'], agg: [{ n: 4, frac: 1 }, { n: 5, frac: 1 }] };

test('engine: shown hands are classified as value or bluff', () => {
  const c = E.classifyShows([bluffShow, valueShow]);
  assert.strictEqual(c.bluff, 2);
  assert.strictEqual(c.value, 2);
  assert.strictEqual(c.bigBluff, 2);
});

test('engine: bluffs at showdown lower the value share of big bets', () => {
  const plain = E.computeStats(tallyWith({}), 'typical');
  const bluffer = E.computeStats(tallyWith({ shows: Array(6).fill(0).map(() => ({ ...bluffShow })) }), 'typical');
  const honest = E.computeStats(tallyWith({ shows: Array(6).fill(0).map(() => ({ ...valueShow })) }), 'typical');
  assert.ok(bluffer.valueShareBig < plain.valueShareBig - 0.15, `${bluffer.valueShareBig} vs ${plain.valueShareBig}`);
  assert.ok(honest.valueShareBig > plain.valueShareBig);
  assert.strictEqual(bluffer.shown.bluffs, 12);
});

test('engine: fold rate follows the bet sizes they actually fold to', () => {
  // Never folds to small bets, always folds to big ones.
  const st = E.computeStats(tallyWith({ vs: { small: { fold: 0, call: 30, raise: 0 }, medium: { fold: 8, call: 8, raise: 0 }, large: { fold: 30, call: 0, raise: 0 } } }), 'typical');
  const base = E.computeStats(tallyWith({}), 'typical');
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(base, 0.33, 3) - 0.15);
  assert.ok(E.foldAtSize(st, 1.2, 3) > E.foldAtSize(base, 1.2, 3) + 0.15);
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(st, 0.66, 3));
  assert.ok(E.foldAtSize(st, 0.66, 3) < E.foldAtSize(st, 1.2, 3));
});

test('engine: per-street reads move that street only', () => {
  const st = E.computeStats(tallyWith({ st: { flop: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, turn: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, river: { check: 0, bet: 0, call: 0, raise: 0, fold: 40 } } }), 'typical');
  assert.ok(st.byStreet[5].foldToBet > st.byStreet[3].foldToBet + 0.2);
  assert.ok(Math.abs(st.byStreet[3].foldToBet - st.foldToBet) < 1e-9);
});

test('engine: 3-bet range follows the observed 3-bet rate', () => {
  const tight = E.computeStats(tallyWith({ pf3betOpp: 30, pf3bet: 1 }), 'typical');
  const loose = E.computeStats(tallyWith({ pf3betOpp: 30, pf3bet: 9 }), 'typical');
  const width = (st) => E.preflopRange(st, '3bet').reduce((a, b) => a + b, 0);
  assert.ok(width(loose) > 2 * width(tight));
});

test('more tendencies: check-raise, think time, pots won without showdown, raw events', () => {
  const mk = (h, v) => ({ tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: h, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: v, posType: 's2', playState: 'playing' }] });
  const t = new T({ players: {} });
  const snap = mk(100, 100);
  t.snap = snap;
  const evs = [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'call', makeBetValue: 1 }],
    ['game:player_turn_started', { playerID: 2 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'check', makeBetValue: 0 }],
    ['game:stage_began', { stageType: 'flop' }],
    ['game:cards_deal_to_stack', [{ emitData: { stackID: 'community_stack', cardData: { uniqueID: 1, suite: 'spades', value: '4' } } }]],
    ['player:game:action_taken', { playerID: 2, actionType: 'check', makeBetValue: 0 }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 4 }],
    ['game:some_new_event', { x: 1 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'raise', makeBetValue: 12 }],
    ['player:game:action_taken', { playerID: 1, actionType: 'fold', makeBetValue: 0 }],
    ['game:stage_began', { stageType: 'showdown' }],
    ['game:game_ended', {}],
  ];
  for (const [ev, data] of evs) t.handle(ev, data, snap);
  t.handle('game:stage_began', { stageType: 'set_blinds' }, mk(94, 106));
  const tally = t.db.players.V.tally;
  assert.ok(Math.abs(tally.xrOpp - T.DECAY) < 1e-9 && Math.abs(tally.xr - T.DECAY) < 1e-9, `xr ${tally.xr}/${tally.xrOpp}`);
  assert.ok(Math.abs(tally.wonNoSD - T.DECAY) < 1e-9, 'won without showdown ' + tally.wonNoSD);
  assert.ok(tally.tt.check.n > 0.9, 'think time counted');
  const e = t.db.history[0];
  assert.deepStrictEqual(e.net, { Hero: -6, Vic: 6 });
  assert.ok(e.raw.some((x) => x.ev === 'game:some_new_event'), 'unknown events are recorded raw');
  assert.ok(e.raw[0].ev === 'game:stage_began' && e.raw[0].s.length === 2, 'hand starts with the set_blinds snapshot');
  assert.ok(e.log.find((x) => x.who === 'Vic' && x.act === 'check').ms != null);
});

test('preflop: no 25bb shove with 9-5 offsuit, but aces still shove', () => {
  const spot = (h, bb, extra) => E.analyzeSync(Object.assign({ hero: C(h), board: [], pot: 3, toCall: 1, stack: bb * 2, bigBlind: 2, mix: false, seed: 1,
    heroPosition: 'blinds', inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }], iterations: 3000 }, extra));
  for (const bb of [20, 25]) {
    assert.notStrictEqual(spot('9d 5c', bb).best.kind, 'allin', bb + 'bb');
    assert.notStrictEqual(spot('9d 5c', bb, { preflopSolver: false }).best.kind, 'allin', bb + 'bb, Monte Carlo');
  }
  // The Monte Carlo (still used for multiway spots it can't solve) shoves aces; the preflop
  // solver may limp or raise small with them instead (trapping), but never folds them.
  assert.strictEqual(spot('Ah As', 25, { preflopSolver: false }).best.kind, 'allin');
  const aa = spot('Ah As', 25);
  assert.ok(aa.solver && aa.solver.kind === 'preflop');
  assert.notStrictEqual(aa.best.kind, 'fold');
  assert.ok(aa.ranked.find((x) => x.kind === 'allin').ev > 0);
  const caller = E.computeStats(tallyWith({ pfBigOpp: 20, pfBigCall: 16 }), 'typical');
  const folder = E.computeStats(tallyWith({ pfBigOpp: 20, pfBigCall: 2 }), 'typical');
  assert.ok(caller.callBig > folder.callBig + 0.3, `${caller.callBig} vs ${folder.callBig}`);
});

test('multiway: the river is solved against the whole field', () => {
  const r = E.analyzeSync({ hero: C('Ad Kc'), board: C('Kd 8h 2s 3c 7c'), pot: 120, toCall: 0, stack: 800, bigBlind: 10, mix: false, seed: 3, inPosition: true,
    opponents: [0, 1].map((i) => ({ name: 'V' + i, tally: {}, actions: { pre: 'call', flop: 'call', turn: 'check', river: 'check' } })), iterations: 3000, riverIterations: 100 });
  assert.ok(r.solver, 'river solver ran');
  assert.ok(['bet', 'raise'].includes(r.best.kind), 'top pair top kicker value-bets into two checked ranges, got ' + r.best.kind);
});

test('multiway: look-ahead with raises gives sane, ordered bet EVs', () => {
  const spot = (h) => E.analyzeSync({ hero: C(h), board: C('Kd 8h 4s'), pot: 60, toCall: 0, stack: 1000, bigBlind: 10, mix: false, seed: 5, inPosition: false,
    opponents: ['A', 'B', 'C'].map((n) => ({ name: n, tally: tallyWith({ raise: 20 }), actions: { pre: 'call', flop: 'pending' } })), iterations: 3000 });
  const betEv = (r) => Math.max(...r.ranked.filter((x) => x.kind === 'bet').map((x) => x.ev));
  const set = spot('8c 8d'), pair = spot('Kh Jc'), air = spot('Ah Qd');
  for (const r of [set, pair, air]) { assert.ok(r.lookahead); r.ranked.forEach((x) => assert.ok(isFinite(x.ev))); }
  assert.ok(betEv(set) > betEv(pair) && betEv(pair) > betEv(air));
  assert.strictEqual(air.best.kind, 'check');
});

test('engine: a known bluffer is read as bluffing more often', () => {
  const input = (tally) => ({
    hero: C('Qs Qd'), board: C('Kd 8h 2s 3c Ac'), pot: 200, toCall: 200, stack: 1000, bigBlind: 10,
    opponents: [{ name: 'V', tally, actions: { pre: 'call', flop: 'checkcall', turn: 'bet', river: 'bet' }, sizes: { turn: 1, river: 1 } }],
    iterations: 3000,
  });
  const honest = E.analyzeSync(input(tallyWith({ shows: Array(8).fill(0).map(() => ({ ...valueShow })) })));
  const bluffer = E.analyzeSync(input(tallyWith({ shows: Array(8).fill(0).map(() => ({ ...bluffShow })) })));
  assert.ok(bluffer.opponents[0].bluffChance > honest.opponents[0].bluffChance + 0.1,
    `${bluffer.opponents[0].bluffChance} vs ${honest.opponents[0].bluffChance}`);
  assert.ok(bluffer.ranked.find((s) => s.kind === 'call').ev > honest.ranked.find((s) => s.kind === 'call').ev);
});

// ---------------------------------------------------------------------------
// 5. Engine: lookahead over later streets
// ---------------------------------------------------------------------------
const flopSpot = (hero, extra) => Object.assign({
  hero: C(hero), board: C('7s Kc 2d'), pot: 100, toCall: 0, stack: 1000, bigBlind: 10, inPosition: true,
  opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'check' } }], iterations: 6000,
}, extra);

test('lookahead: used heads-up on the flop and turn, not preflop or river', () => {
  assert.strictEqual(E.analyzeSync(flopSpot('7h 7d')).lookahead, true);
  assert.strictEqual(E.analyzeSync(flopSpot('7h 7d', { board: C('7s Kc 2d 9h') })).lookahead, true);
  assert.strictEqual(E.analyzeSync(flopSpot('7h 7d', { board: C('7s Kc 2d 9h 3c') })).lookahead, false);
  assert.strictEqual(E.analyzeSync(flopSpot('7h 7d', { board: [], opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }] })).lookahead, false);
});

test('lookahead: a set is worth more than this street alone, and betting beats checking', () => {
  const now = E.analyzeSync(flopSpot('7h 7d', { lookahead: false }));
  const ahead = E.analyzeSync(flopSpot('7h 7d'));
  const ev = (r, k) => Math.max(...r.ranked.filter((s) => s.kind === k).map((s) => s.ev));
  assert.ok(ev(ahead, 'bet') > ev(now, 'bet') + 50, `${ev(ahead, 'bet')} vs ${ev(now, 'bet')}`);
  assert.ok(ev(ahead, 'bet') > ev(ahead, 'check'));
});

test('lookahead: an open-ended draw can call a pot-size bet on implied odds', () => {
  const spot = flopSpot('6c 5d', { board: C('8h 9s Kc'), pot: 200, toCall: 100, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'bet' } }] });
  const now = E.analyzeSync(Object.assign({}, spot, { lookahead: false }));
  const ahead = E.analyzeSync(spot);
  const call = (r) => r.ranked.find((s) => s.kind === 'call').ev;
  assert.ok(call(ahead) > call(now) + 15, `${call(ahead)} vs ${call(now)}`);
});

test('lookahead: real hand flop decision stays sane', () => {
  const x = replay(real).turns[1];
  const r = E.analyzeSync(Object.assign({}, x.input, { iterations: 6000, mix: false, seed: 7 }));
  assert.strictEqual(r.lookahead, true);
  // Top pair on a monotone board facing a big bet: calling is close, never a clear fold.
  const call = r.ranked.find((s) => s.kind === 'call');
  assert.ok(call.ev > -0.05 * r.pot, 'call EV ' + call.ev);
  r.ranked.forEach((s) => assert.ok(isFinite(s.ev)));
});

// ---------------------------------------------------------------------------
// 6. Ideas from the poker-AI research write-up
// ---------------------------------------------------------------------------
test('mixing: close spots come back as frequencies, and the seed picks one', () => {
  // A flop spot where checking and a small bet come out close.
  const base = flopSpot('Ah 5c', { board: C('As 9c 4d'), iterations: 3000 });
  let mixed = null;
  for (let seed = 1; seed < 40 && !mixed; seed++) {
    const r = E.analyzeSync(Object.assign({}, base, { seed, board: C(['As 9c 4d', 'Kd 8s 3c', '7h 6h 2c', 'Qs Jd 5h'][seed % 4]) }));
    if (r.mix) mixed = r;
  }
  assert.ok(mixed, 'expected at least one close spot');
  assert.strictEqual(mixed.mix.length, 2);
  assert.ok(Math.abs(mixed.mix[0].freq + mixed.mix[1].freq - 1) < 1e-9);
  assert.ok(mixed.mix[0].freq >= 0.5);
  assert.ok(mixed.mix.some((m) => m.kind === mixed.best.kind && m.amount === mixed.best.amount));
});

test('tracker passes a fresh seed with each decision', () => {
  const t = replay(real).turns;
  assert.ok(t.every((x) => Number.isInteger(x.input.seed)));
});

test('no 2x-pot overbets: they lost money at a real table', () => {
  const has2x = (b) => {
    const r = E.analyzeSync(flopSpot('7h 7d', { board: C(b), iterations: 500, riverIterations: 50 }));
    return r.ranked.some((s) => (s.kind === 'bet') && s.amount >= 200);
  };
  assert.strictEqual(has2x('7s Kc 2d'), false);
  assert.strictEqual(has2x('7s Kc 2d 9h'), false);
  assert.strictEqual(has2x('7s Kc 2d 9h 3c'), false);
});

test('fold rates rise only gently with bet size', () => {
  const st = E.computeStats({}, 'typical');
  assert.ok(E.foldAtSize(st, 2, 5) < 0.62, String(E.foldAtSize(st, 2, 5)));
  assert.ok(E.foldAtSize(st, 2, 5) - E.foldAtSize(st, 0.5, 5) < 0.2);
});

test('bet size: a big bet reads more polarized (fewer medium hands) than a small one', () => {
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(C('Kd 8h 2s')) };
  const st = E.computeStats({}, 'typical');
  const avg = (size) => {
    const W = E.buildRange(st, { pre: 'call', flop: 'bet' }, strengths, C('Kd 8h 2s'), { flop: size });
    let a = 0, t = 0;
    for (let k = 0; k < W.length; k++) { t += W[k]; if (strengths[3].hs[k] > 0.45 && strengths[3].hs[k] < 0.75) a += W[k]; }
    return a / t;
  };
  assert.ok(avg(1.2) < avg(0.3) - 0.05, `${avg(1.2)} vs ${avg(0.3)}`);
});

test('confidence: thin reads lean toward balanced folding, big samples follow the read', () => {
  const never = (n) => E.computeStats(Object.assign(T.blankTally(), { pfFold: n, pfCall: n, check: n, bet: n, call: 2 * n, fold: 0 }), 'typical');
  assert.ok(never(2).exploitWeight < never(60).exploitWeight);
  assert.ok(never(2).foldToBet > never(60).foldToBet);
});

test('lookahead: robust EV sits between the read and the worst opponent version', () => {
  const r = E.analyzeSync(flopSpot('Ah Kd', { board: C('Kc 7s 2d 9h') }));
  assert.ok(r.robustWeight > 0);
  for (const sc of r.ranked) {
    if (sc.kind === 'fold') continue;
    assert.ok(sc.evWorst <= sc.evRead + 1e-9);
    assert.ok(sc.ev <= sc.evRead + 1e-9 && sc.ev >= sc.evWorst - 1e-9);
  }
});

test('position: preflop ranges follow position reads', () => {
  const tight = Object.assign(T.blankTally(), { pfFold: 40, pfCall: 15, pfRaise: 5, pos: { early: { n: 30, vpip: 2, pfr: 1 }, late: { n: 30, vpip: 18, pfr: 4 }, blinds: { n: 0, vpip: 0, pfr: 0 } } });
  const st = E.computeStats(tight, 'typical');
  assert.ok(st.byPos.late.vpip > 2 * st.byPos.early.vpip);
  const strengths = { 0: E.boardStrength([]) };
  const width = (pos) => E.buildRange(st, { pre: 'call' }, strengths, [], null, null, pos).reduce((a, b) => a + b, 0);
  assert.ok(width('late') > width('early'));
});

test('position: tracker groups seats and counts preflop by position', () => {
  const { t, turns } = replay(three);
  // Button s3 (Ann) is late; Bob (SB) and Hero (BB) are blinds.
  assert.strictEqual(turns[0].input.opponents.find((o) => o.name === 'Ann').position, 'late');
  assert.strictEqual(turns[0].input.opponents.find((o) => o.name === 'Bob').position, 'blinds');
  const { t: t2 } = replay(sd);
  assert.deepStrictEqual(t2.db.players.V.tally.pos.blinds, { n: 1, vpip: 1, pfr: 0 });
});

test('read accuracy: shown hands are scored against the predicted range', () => {
  const t = new T({ players: {} });
  t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
  for (const m of sd) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); }
  const show = t.db.players.V.tally.shows[0];
  assert.deepStrictEqual(show.actions, { pre: 'call', flop: 'checkcall', turn: 'bet', river: 'bet' });
  assert.ok(show.fit && show.fit.top >= 0 && show.fit.top <= 1 && show.fit.lr >= 0, JSON.stringify(show.fit));
  const st = E.computeStats(t.db.players.V.tally, 'typical');
  assert.strictEqual(st.accuracy.n, 1);
  assert.ok(/range read right/.test(E.readSummary(st)));
});

test('read accuracy: ranges that keep missing get less trust', () => {
  const base = { pfFold: 30, pfCall: 20, pfRaise: 10, check: 30, bet: 15, call: 15, fold: 15 };
  const shows = (top) => Array(10).fill(0).map(() => ({ cards: ['2c', '3d'], board: ['Kd', '8h', '2s'], agg: [], fit: { top, lr: top < 0.5 ? 2 : 0.2 } }));
  const good = E.computeStats(Object.assign(T.blankTally(), base, { shows: shows(0.3) }), 'typical');
  const bad = E.computeStats(Object.assign(T.blankTally(), base, { shows: shows(0.9) }), 'typical');
  assert.ok(good.exploitWeight > bad.exploitWeight + 0.1);
  assert.ok(good.accuracy.vsGuess > 1 && bad.accuracy.vsGuess < 1);
});

test('read accuracy: players who keep showing weaker hands get weaker ranges', () => {
  const base = { pfFold: 30, pfCall: 20, pfRaise: 10, check: 30, bet: 15, call: 15, fold: 15 };
  const shows = (sq) => Array(12).fill(0).map(() => ({ cards: ['2c', '3d'], board: ['Kd', '8h', '2s'], agg: [], fit: { top: 0.5, lr: 1, sq } }));
  const weak = E.computeStats(Object.assign(T.blankTally(), base, { shows: shows(0.2) }), 'typical');
  const plain = E.computeStats(Object.assign(T.blankTally(), base), 'typical');
  assert.ok(weak.strengthBias < -0.15);
  const board = C('Kd 8h 2s');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board) };
  const avg = (st) => {
    const W = E.buildRange(st, { pre: 'call', flop: 'call' }, strengths, board);
    let a = 0, t = 0;
    for (let k = 0; k < W.length; k++) { a += W[k] * strengths[3].ehs[k]; t += W[k]; }
    return a / t;
  };
  assert.ok(avg(weak) < avg(plain) - 0.03, `${avg(weak)} vs ${avg(plain)}`);
});

test('recency: older counts fade a little each hand the player is dealt into', () => {
  const db = { players: { V: { name: 'Vic', tally: Object.assign(T.blankTally(), { fold: 100 }) } } };
  const t = replay(sd, db).t;
  near(t.db.players.V.tally.fold, 100 * T.DECAY);
});

test('hand log: hands are kept with actions, shown cards and advice', () => {
  const t = new T({ players: {} });
  t.on((type, p) => { if (type === 'turn' && p.isHero) t.noteAdvice('Call $60', 12.5); });
  for (const m of sd) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); }
  const log = t.db.history;
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(log[0].hero, ['Ks', 'Qh']);
  assert.strictEqual(log[0].pot, 480);
  assert.strictEqual(log[0].advice.length, 4);
  const vic = log[0].players.find((p) => p.name === 'Vic');
  assert.deepStrictEqual(vic.shown, ['7c', '6c']);
  assert.deepStrictEqual(vic.actions.river, ['bet']);
});

// ---------------------------------------------------------------------------
// 7. River solver (PR 2)
// ---------------------------------------------------------------------------
const riverSpot = (hero, extra) => Object.assign({
  hero: C(hero), board: C('Kd 8h 2s 3c Ac'), pot: 320, toCall: 120, stack: 1000, bigBlind: 10, inPosition: false, mix: false,
  opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'bet' }, sizes: { river: 0.6 } }],
  heroActions: { pre: 'raise', flop: 'bet', turn: 'check', river: 'check' }, iterations: 2000, riverIterations: 150,
}, extra);

test('river solver: runs on the river only, heads-up and multiway', () => {
  assert.ok(E.analyzeSync(riverSpot('As Kc')).solver);
  assert.strictEqual(E.analyzeSync(riverSpot('As Kc', { board: C('Kd 8h 2s 3c') })).solver, null);
  const multi = riverSpot('As Kc');
  multi.opponents = multi.opponents.concat([{ name: 'W', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'call' } }]);
  assert.ok(E.analyzeSync(multi).solver);
});

test('river solver: raises the nuts-ish hand, folds the bluff-catcher that cannot win', () => {
  const big = E.analyzeSync(riverSpot('As Kc'));
  assert.strictEqual(big.best.kind, 'raise');
  const weak = E.analyzeSync(riverSpot('7c 6d', { opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'bet' }, sizes: { river: 1.5 } }] }));
  assert.strictEqual(weak.best.kind, 'fold');
  const total = big.ranked.reduce((a, s) => a + s.freq, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
});

test('river solver: checking it down is worth equity x pot (showdown math with blockers)', () => {
  const spot = riverSpot('Ah Qd', { toCall: 0, pot: 200, inPosition: true, iterations: 20000,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'check' } }] });
  const r = E.analyzeSync(spot);
  const check = r.ranked.find((s) => s.kind === 'check');
  const expect = r.equity.share * 200;
  assert.ok(Math.abs(check.ev - expect) < 0.04 * 200, `${check.ev} vs ${expect}`);
});

test('river solver: calls a known bluffer more often than an honest bettor', () => {
  const callFreq = (shows) => {
    const tally = Object.assign(T.blankTally(), { pfFold: 60, pfCall: 45, pfRaise: 25, check: 60, bet: 36, call: 30, raise: 6, fold: 36, shows });
    const r = E.analyzeSync(riverSpot('Kh Qh', { opponents: [{ name: 'V', tally, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'bet' }, sizes: { river: 1 } }] }));
    return r.ranked.filter((s) => s.kind === 'call').reduce((a, s) => a + s.freq, 0);
  };
  const bluffer = callFreq(Array(10).fill(0).map(() => ({ ...bluffShow })));
  const honest = callFreq(Array(10).fill(0).map(() => ({ ...valueShow })));
  assert.ok(bluffer > honest + 0.2, `${bluffer} vs ${honest}`);
});

test('river solver: tracker passes hero\'s own line', () => {
  const x = replay(sd).turns[3];
  assert.deepStrictEqual(x.input.heroActions, { pre: 'raise', flop: 'bet', turn: 'call', river: '' });
  assert.strictEqual(x.input.heroPfAggressor, true);
});

// ---------------------------------------------------------------------------
// 8. Everything else (PR 2)
// ---------------------------------------------------------------------------
test('lookahead: raises are played (a set gains from check-raising)', () => {
  const r = E.analyzeSync(flopSpot('7h 7d', { inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise', flop: '' } }], mix: false }));
  const check = r.ranked.find((s) => s.kind === 'check');
  const now = E.analyzeSync(flopSpot('7h 7d', { inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise', flop: '' } }], lookahead: false, mix: false }));
  assert.ok(check.ev > now.ranked.find((s) => s.kind === 'check').ev + 50);
});

test('lookahead: also runs with two opponents left', () => {
  const r = E.analyzeSync(flopSpot('Ah Kd', { board: C('Kc 7s 2d'), mix: false, opponents: [
    { name: 'V', tally: {}, actions: { pre: 'call', flop: 'check' } }, { name: 'W', tally: {}, actions: { pre: 'call', flop: 'check' } }] }));
  const check = r.ranked.find((s) => s.kind === 'check');
  assert.ok(check.lookedPct > 0.9, String(check.lookedPct));
  r.ranked.forEach((s) => assert.ok(isFinite(s.ev)));
});

test('side pots: a short all-in opponent can only pay what they have', () => {
  const spot = riverSpot('As Kc', { riverSolver: false, toCall: 0, pot: 300, inPosition: true, iterations: 4000,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'check' }, stack: 50, committed: 150 }],
    heroCommitted: 150 });
  const r = E.analyzeSync(spot);
  r.ranked.filter((s) => s.kind !== 'fold').forEach((s) => assert.ok(s.ev <= 300 + 50 + 1e-6, `${s.kind} ${s.amount}: ${s.ev}`));
  const noCap = E.analyzeSync(Object.assign({}, spot, { opponents: [Object.assign({}, spot.opponents[0], { stack: null })], heroCommitted: undefined }));
  assert.ok(Math.max(...noCap.ranked.map((s) => s.ev)) > 400);
});

test('side pots: three-way all-in pays each pot to the best eligible hand', () => {
  // Hero has the nuts; short opponent all-in for 100 more, deep opponent calls.
  const r = E.analyzeSync({
    hero: C('As Ad'), board: C('Ac Ah 7d 2c 9s'), pot: 300, toCall: 0, stack: 1000, bigBlind: 10, inPosition: true,
    riverSolver: false, mix: false, iterations: 3000, heroCommitted: 100,
    opponents: [
      { name: 'Short', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'call', river: 'check' }, stack: 0, committed: 100 },
      { name: 'Deep', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'call', river: 'check' }, stack: 2000, committed: 100 },
    ],
  });
  const check = r.ranked.find((s) => s.kind === 'check');
  assert.ok(Math.abs(check.ev - 300) < 1e-6, String(check.ev));
});

test('hero story: a strong-looking line makes opponents fold more', () => {
  const base = flopSpot('5c 4c', { board: C('Kc 7s 2d 9h'), mix: false, lookahead: false });
  const strong = E.analyzeSync(Object.assign({}, base, { heroActions: { pre: 'raise', flop: 'bet', turn: '' } }));
  const weak = E.analyzeSync(Object.assign({}, base, { heroActions: { pre: 'call', flop: 'checkcall', turn: '' } }));
  assert.ok(strong.credibility > weak.credibility);
  const fold = (r) => r.ranked.find((s) => s.kind === 'bet').foldPct;
  assert.ok(fold(strong) > fold(weak));
});

test('preflop: suited connectors realize more than offsuit junk', () => {
  const pre = (h) => E.analyzeSync({ hero: C(h), board: [], pot: 15, toCall: 5, stack: 1000, bigBlind: 10, iterations: 500,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }] }).realize;
  assert.ok(pre('9h 8h') > pre('9h 3c') + 0.05);
});

test('preflop equity table: known matchups, and the two sides add up to 1', () => {
  const EQ = E._pf.preflopEquityTable();
  const cls = (n) => E.CLASS_NAMES.indexOf(n);
  const eq = (a, b) => EQ[cls(a) * 169 + cls(b)];
  assert.ok(Math.abs(eq('AA', 'KK') - 0.82) < 0.01, 'AA vs KK ' + eq('AA', 'KK'));
  assert.ok(Math.abs(eq('AKs', 'QQ') - 0.46) < 0.01, 'AKs vs QQ ' + eq('AKs', 'QQ'));
  assert.ok(Math.abs(eq('72o', 'AA') - 0.12) < 0.01, '72o vs AA ' + eq('72o', 'AA'));
  for (let i = 0; i < 300; i++) {
    const a = (i * 37) % 169, b = (i * 91 + 7) % 169;
    assert.ok(Math.abs(EQ[a * 169 + b] + EQ[b * 169 + a] - 1) < 1e-9);
  }
  // Blocker-aware class totals match the brute-force count of compatible combo pairs.
  const M = E._pf.preflopCompat(), r = new Float64Array(169).map((_, i) => ((i * 7919) % 101) / 100);
  const fast = new Float64Array(169);
  E._pf.classMass(r, fast, 1);
  for (let a = 0; a < 169; a++) {
    let slow = 0;
    for (let b = 0; b < 169; b++) slow += M[a * 169 + b] * r[b];
    assert.ok(Math.abs(slow - fast[a]) < 1e-6 * Math.max(1, slow));
  }
});

const pfSpot = (h, extra) => E.analyzeSync(Object.assign({ hero: C(h), board: [], pot: 1.5, toCall: 0.5, stack: 99.5, bigBlind: 1, inPosition: true, mix: false, seed: 3,
  iterations: 2000, preflopIterations: 200, opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }], heroActions: { pre: 'pending' } }, extra));

test('preflop solver: heads-up spots are solved range against range', () => {
  const aa = pfSpot('Ah As'), junk = pfSpot('7c 2d');
  assert.strictEqual(aa.solver.kind, 'preflop');
  assert.notStrictEqual(aa.best.kind, 'fold');
  assert.strictEqual(junk.best.kind, 'fold');
  assert.ok(aa.ranked.every((x) => isFinite(x.ev) && x.freq >= 0 && x.freq <= 1));
  // Big blind facing a raise: aces re-raise, 7-2 folds.
  const bb = (h) => pfSpot(h, { pot: 3.5, toCall: 1.5, stack: 99, inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise' } }] });
  assert.ok(['raise', 'allin'].includes(bb('Ad Ac').best.kind));
  assert.strictEqual(bb('7h 2s').best.kind, 'fold');
  // Facing a shove the solve is plain equity against the shoving range, as the Monte Carlo says.
  const shove = (h, extra) => pfSpot(h, Object.assign({ pot: 28, toCall: 22, stack: 22, inPosition: false, iterations: 20000, opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise' } }] }, extra));
  for (const h of ['Ah Jc', '6s 6d', 'Kh 9c']) {
    const a = shove(h), b = shove(h, { preflopSolver: false });
    const call = (r) => r.ranked.find((x) => x.kind === 'allin').ev;
    assert.ok(Math.abs(call(a) - call(b)) < 0.8, `${h}: ${call(a)} vs ${call(b)}`);
  }
});

test('preflop solver: an open with several players behind is solved against the field', () => {
  const open = (h) => pfSpot(h, { toCall: 1, stack: 100, inPosition: false, opponents: [1, 2, 3, 4, 5].map((i) => ({ name: 'P' + i, tally: {}, actions: { pre: 'pending' } })) });
  const aa = open('Ks Kd'), junk = open('9s 4d');
  assert.strictEqual(aa.solver.field, 5);
  assert.ok(['raise', 'allin'].includes(aa.best.kind));
  assert.strictEqual(junk.best.kind, 'fold');
  // Limpers in front: solved against the field too, with multiway equity (or the Monte Carlo if asked).
  const limpedIn = { toCall: 1, pot: 3.5, stack: 100, opponents: [{ name: 'L', tally: {}, actions: { pre: 'call' } }, { name: 'B', tally: {}, actions: { pre: 'pending' } }] };
  const limped = pfSpot('Ks Kd', limpedIn);
  assert.strictEqual(limped.solver.kind, 'preflop');
  assert.strictEqual(limped.solver.field, 2);
  assert.ok(['raise', 'allin'].includes(limped.best.kind));
  assert.strictEqual(pfSpot('Ks Kd', Object.assign({ preflopMultiway: false }, limpedIn)).solver, null);
});

test('preflop solver: limped and raised multiway pots use multiway equity', () => {
  const bb = (h) => pfSpot(h, { pot: 3.5, toCall: 0, inPosition: false, heroActions: {},
    opponents: [{ name: 'L1', tally: {}, actions: { pre: 'call' } }, { name: 'L2', tally: {}, actions: { pre: 'call' } }] });
  const aa = bb('As Ad'), junk = bb('9c 4d');
  assert.ok(['raise', 'bet', 'allin'].includes(aa.best.kind));
  assert.strictEqual(junk.best.kind, 'check');
  const vsRaise = (h) => pfSpot(h, { pot: 7.5, toCall: 2, inPosition: false, heroActions: {},
    opponents: [{ name: 'R', tally: {}, actions: { pre: 'raise' }, pfAggressor: true }, { name: 'C', tally: {}, actions: { pre: 'call' } }] });
  const big = vsRaise('As Ad'), weak = vsRaise('9c 4d');
  assert.strictEqual(big.solver.kind, 'preflop');
  assert.ok(['raise', 'allin'].includes(big.best.kind));
  assert.strictEqual(weak.best.kind, 'fold');
  // Hero's multiway share is below the share against the strongest single hand.
  const opps = [0, 1, 2].map(() => ({ W: new Float64Array(1326).fill(1), pending: false }));
  const m = E._pf.preflopMulti(opps, [], [], (x) => x, 0, 400, 7);
  const cls = (n) => E.PREFLOP_ORDER.indexOf(n) >= 0 && E._pf.classIndex(n);
  assert.ok(m.kappa[cls('AA')] < 1 && m.kappa[cls('AA')] > 0.7);
  assert.ok(m.kappa[cls('72o')] < m.kappa[cls('AA')]);
});

const turnSpot = (h, extra) => Object.assign({
  hero: C(h), board: C('Ts 9s 4d 2c'), pot: 20, toCall: 8, stack: 80, bigBlind: 1, inPosition: true, mix: false, seed: 5, iterations: 2000,
  opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise', flop: 'bet', turn: 'bet' } }], heroActions: { pre: 'call', flop: 'call' },
}, extra);

test('turn solver: computer mode only; raises a big draw, gives up on air', () => {
  assert.strictEqual(E.analyzeSync(turnSpot('Qs Js')).solver, null);
  const solve = (h) => E.analyzeSync(turnSpot(h, { turnSolver: true, turnIterations: 40 }));
  const draw = solve('Qs Js'), air = solve('Ah Kh');
  assert.strictEqual(draw.solver.kind, 'turn');
  assert.notStrictEqual(draw.best.kind, 'fold');
  assert.strictEqual(air.best.kind, 'fold');
  for (const r of [draw, air]) assert.ok(r.ranked.every((x) => isFinite(x.ev)));
});

test('turn solver: workers\' solves are averaged in the final pass', () => {
  const parts = [1, 2].map((seed) => E.analyzeSync(turnSpot('Qs Js', { turnSolver: true, turnIterations: 20, seed, partial: true })));
  assert.ok(parts.every((p) => p.partial && p.solved && p.solved.kind === 'turn'));
  const fin = E.analyzeSync(turnSpot('Qs Js', { merge: parts.map((p) => p.partial), solvedMerge: parts.map((p) => p.solved) }));
  assert.strictEqual(fin.solver.kind, 'turn');
  assert.strictEqual(fin.solver.runs, 2);
  const ev = (list, kind) => list.find((a) => a.kind === kind).ev;
  const mean = (ev(parts[0].solved.actions, 'call') + ev(parts[1].solved.actions, 'call')) / 2;
  assert.ok(Math.abs(fin.ranked.find((x) => x.kind === 'call').ev - mean) < 1e-9);
});

test('multiway: the field folds only when every player folds', () => {
  const a = E._pf.computeStats({}, 'typical'), b = E._pf.computeStats({}, 'loose');
  const f = E._pf.fieldStats([a, b], a);
  const want = E._pf.foldAtSize(a, 0.66, 5) * E._pf.foldAtSize(b, 0.66, 5);
  assert.ok(Math.abs(E._pf.foldAtSize(f, 0.66, 5) - want) < 1e-9);
  assert.ok(f.betFreq > Math.max(a.betFreq, b.betFreq));
});

test('turn solver: multiway turns are solved against the field on the computer', () => {
  const two = (h, extra) => E.analyzeSync(Object.assign({
    hero: C(h), board: C('Ts 9s 4d 2c'), pot: 30, toCall: 15, stack: 150, bigBlind: 1, inPosition: true, mix: false, seed: 5,
    iterations: 2000, turnSolver: true, turnIterations: 30, heroActions: { pre: 'call', flop: 'call' },
    opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet', turn: 'bet' }, pfAggressor: true },
      { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'pending' } }],
  }, extra));
  const weak = two('Ah Td'), set = two('4c 4h');
  assert.strictEqual(weak.solver.kind, 'turn');
  assert.strictEqual(weak.solver.field, 2);
  assert.strictEqual(weak.best.kind, 'fold');
  assert.notStrictEqual(set.best.kind, 'fold');
  assert.strictEqual(two('Ah Td', { turnSolver: false }).solver, null);
});

test('tracker passes chips committed and behind for side pots', () => {
  const x = replay(three).turns[1];
  assert.strictEqual(x.input.heroCommitted, 30);
  assert.deepStrictEqual(x.input.opponents.map((o) => [o.committed, o.stack]), [[30, 970], [30, 970]]);
});

// ---------------------------------------------------------------------------
// WebAssembly kernels: the same numbers as the JS loops
// ---------------------------------------------------------------------------
test('kernels: river and preflop solves give bit-identical results with and without WebAssembly', () => {
  if (!E.kernelsActive()) { console.log('     (no WebAssembly SIMD here, JS loops only)'); return; }
  const spots = [
    riverSpot('As Kc', { riverIterations: 60 }),
    riverSpot('7c 6d', { toCall: 0, inPosition: true, riverIterations: 60,
      opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'check' } }, { name: 'W', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'call', river: 'check' } }] }),
    { hero: C('Ah Qd'), board: [], pot: 15, toCall: 5, stack: 1000, bigBlind: 10, inPosition: true, mix: false, seed: 3, iterations: 2000, preflopIterations: 60,
      opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }] },
    { hero: C('Kh Td'), board: [], pot: 15, toCall: 10, stack: 400, bigBlind: 10, inPosition: false, mix: false, seed: 4, iterations: 2000, preflopIterations: 60,
      opponents: ['A', 'B', 'C'].map((n) => ({ name: n, tally: {}, actions: { pre: 'pending' } })) },
    // Multiway preflop leaves (a raise and a caller in front).
    { hero: C('9s 8s'), board: [], pot: 75, toCall: 20, stack: 1000, bigBlind: 10, inPosition: false, mix: false, seed: 5, iterations: 2000, preflopIterations: 60,
      opponents: [{ name: 'R', tally: {}, actions: { pre: 'raise' }, pfAggressor: true }, { name: 'C', tally: {}, actions: { pre: 'call' } }] },
  ];
  const json = (x) => JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  for (const sp of spots) {
    const withK = E.analyzeSync(sp);
    E.useKernels(false);
    let noK;
    try { noK = E.analyzeSync(sp); } finally { E.useKernels(true); }
    assert.ok(withK.solver, 'a solver ran');
    assert.strictEqual(json(withK), json(noK));
  }
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
