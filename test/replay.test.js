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

test('engine: per-street reads move that street most, and the others a little', () => {
  const base = E.computeStats({}, 'typical');
  const st = E.computeStats(tallyWith({ fold: 76, st: { flop: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, turn: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, river: { check: 0, bet: 0, call: 0, raise: 0, fold: 40 } } }), 'typical');
  const moved = (n) => st.byStreet[n].foldToBet - base.byStreet[n].foldToBet;
  assert.ok(st.byStreet[5].foldToBet > st.byStreet[3].foldToBet + 0.2);
  // Folding every river bet says something about their flop folds too (one fold tendency per
  // player), but much less than about the river.
  assert.ok(moved(3) > 0 && moved(5) > 2 * moved(3), `${moved(3)} ${moved(5)}`);
});

test('reads: a new player starts as the average home player, with street and position effects', () => {
  const st = E.computeStats({}, 'typical');
  const H = E.READ_PRIORS.home;
  assert.ok(Math.abs(st.vpip - H.vpip.mu.all) < 1e-9);
  assert.ok(st.byPos.late.vpip > st.byPos.blinds.vpip);
  assert.ok(st.byStreet[5].betFreq > st.byStreet[3].betFreq, 'friends bet the river more often than the flop');
  // A few hands move the read part of the way; many hands move it close to what they do.
  const loose = (n) => E.computeStats(Object.assign(T.blankTally(), { pfCall: n, pos: { late: { n, vpip: n, pfr: 0 }, early: { n: 0, vpip: 0, pfr: 0 }, blinds: { n: 0, vpip: 0, pfr: 0 } } }), 'typical');
  assert.ok(loose(5).vpip > st.vpip && loose(5).vpip < loose(50).vpip && loose(50).vpip > 0.9);
  // Solid (hero's own range) is the old, tighter typical prior.
  assert.ok(E.computeStats({}, 'solid').vpip < 0.3);
});

test('reads: pooled counts from the table move a new player toward this table', () => {
  const tight = tallyWith({ pfFold: 150, pfCall: 30, pfRaise: 20, pos: { early: { n: 0, vpip: 0, pfr: 0 }, late: { n: 0, vpip: 0, pfr: 0 }, blinds: { n: 0, vpip: 0, pfr: 0 } } });
  const fresh = E.computeStats({}, 'typical', E.poolTally([tight, tight]));
  assert.ok(fresh.vpip < E.computeStats({}, 'typical').vpip - 0.1, String(fresh.vpip));
  // The player's own counts are taken back out of the pool, so they are not counted twice.
  const self = E.computeStats(tight, 'typical', E.poolTally([tight]));
  near(self.vpip, E.computeStats(tight, 'typical').vpip);
});

test('reads: predictAction gives a distribution, and the tracker scores reads on every action', () => {
  const st = E.computeStats({}, 'typical');
  for (const d of [{ kind: 'pf', pos: 'late' }, { kind: 'open', n: 3, cbet: true }, { kind: 'face', n: 5, frac: 0.5, aggLine: true }]) {
    const p = E.predictAction(st, d);
    const tot = Object.values(p).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(tot - 1) < 1e-9 && Object.values(p).every((x) => x >= 0), JSON.stringify(p));
  }
  const t = new T({ players: {} });
  t.predictor = E.makePredictor(() => 'typical', () => t.poolTally());
  for (const m of sd) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); }
  const pred = t.db.players.V.tally.pred;
  assert.ok(pred.n >= 4 && pred.read > 0 && pred.pop > 0, JSON.stringify(pred));
  assert.ok(T.predSummary(t.db.players.V.tally).n >= 4);
});

test('reads: vsOpen counts the response to a single open by its size', () => {
  const mk = () => ({ tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 200, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 200, posType: 's2', playState: 'playing' }] });
  const t = new T({ players: {} });
  const snap = mk();
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 7 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 6 }],
  ]) t.handle(ev, data, snap);
  const vo = t.db.players.V.tally.vsOpen;
  assert.strictEqual(vo.large.call, 1, JSON.stringify(vo));
  // A limper calling a raise is not a response to an open (they keep most of their limping range).
  const t3 = new T({ players: {} });
  const snap3 = { tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 200, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 200, posType: 's2', playState: 'playing' },
    { id: 3, authUserId: 'W', name: 'Wes', stack: 200, posType: 's3', playState: 'playing' }] };
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 2 }], ['game:big_blind_paid', { amount: 2, playerId: 3 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'fold', makeBetValue: 0 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 1 }],
    ['player:game:action_taken', { playerID: 3, actionType: 'raise', makeBetValue: 6 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 6 }],
  ]) t3.handle(ev, data, snap3);
  const vo3 = t3.db.players.V.tally.vsOpen;
  assert.strictEqual(vo3.large.call + vo3.medium.call + vo3.small.call, 0, JSON.stringify(vo3));
  const st = E.computeStats(Object.assign(T.blankTally(), { vsOpen: { small: { fold: 0, call: 0, raise: 0 }, medium: { fold: 0, call: 0, raise: 0 }, large: { fold: 20, call: 0, raise: 0 } } }), 'typical');
  assert.ok(st.vsOpen.large.cont < 0.2 && st.vsOpen.small.cont > 0.5, JSON.stringify(st.vsOpen));
});

test('reads: a bet that then calls a raise reads stronger than a plain bet', () => {
  assert.strictEqual(T.streetAction(['bet', 'call'], 4), 'betcall');
  assert.strictEqual(T.streetAction(['bet'], 4), 'bet');
  assert.strictEqual(T.streetAction(['check', 'call'], 4), 'checkcall');
  const board = C('Ks 9d Kh 6d');
  const st = E.computeStats(T.blankTally(), 'typical');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board.slice(0, 3)), 4: E.boardStrength(board) };
  const mean = (W) => { let a = 0, w = 0; for (let k = 0; k < W.length; k++) if (W[k] > 0 && strengths[4].hs[k] >= 0) { a += W[k] * strengths[4].hs[k]; w += W[k]; } return a / w; };
  const bet = E.buildRange(st, { pre: 'call', flop: 'check', turn: 'bet' }, strengths, board);
  const betcall = E.buildRange(st, { pre: 'call', flop: 'check', turn: 'betcall' }, strengths, board);
  assert.ok(mean(betcall) > mean(bet) + 0.03, mean(bet) + ' vs ' + mean(betcall));
});

test('reads: players who re-raised preflop fold less after the flop', () => {
  const t = T.blankTally();
  const flat = E.computeStats(t, 'typical');
  const rr = E.computeStats(t, 'typical', null, { reraised: true });
  assert.ok(rr.foldToBet < flat.foldToBet - 0.04, flat.foldToBet + ' vs ' + rr.foldToBet);
  assert.ok(rr.byStreet[4].foldToBet < flat.byStreet[4].foldToBet && rr.foldBySize.large < flat.foldBySize.large);
  // The unblended read is left as it is; predictAction applies the same shift by decision.
  assert.strictEqual(rr.read.foldToBet, flat.read.foldToBet);
  const d = { kind: 'face', n: 4, frac: 0.5, mw: false };
  assert.ok(E.predictAction(flat, Object.assign({ reraised: true }, d)).fold < E.predictAction(flat, d).fold);
});

test('reads: limpers facing a raise are counted, and their fold rate is learned', () => {
  const t = new T({ players: {} });
  const snap = { tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 200, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 200, posType: 's2', playState: 'playing' },
    { id: 3, authUserId: 'W', name: 'Wes', stack: 200, posType: 's3', playState: 'playing' }] };
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's3' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 3, actionType: 'call', makeBetValue: 2 }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 9 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'fold', makeBetValue: 0 }],
    ['player:game:action_taken', { playerID: 3, actionType: 'fold', makeBetValue: 0 }],
  ]) t.handle(ev, data, snap);
  const w = t.db.players.W.tally;
  assert.deepStrictEqual([w.limp, w.limpFaceN, w.limpFold], [1, 1, 1]);
  const folder = E.computeStats(Object.assign(T.blankTally(), { limpFaceN: 12, limpFold: 11 }), 'typical');
  const sticky = E.computeStats(Object.assign(T.blankTally(), { limpFaceN: 12, limpFold: 2 }), 'typical');
  assert.ok(folder.limpFold > 0.65 && sticky.limpFold < 0.35, folder.limpFold + ' ' + sticky.limpFold);
});

test('reads: range noise keeps unusual lines possible, and is learned from showdowns', () => {
  const board = C('6d As Qc');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board) };
  const weight = (st) => {
    const W = E.buildRange(st, { pre: 'raise', flop: 'checkraise' }, strengths, board);
    let tot = 0; for (let k = 0; k < W.length; k++) tot += W[k];
    return W[E.comboIndex(E.parseCard('Ah'), E.parseCard('5c'))] / tot;
  };
  const st = E.computeStats({}, 'typical');
  assert.ok(weight(st) > 3 * weight(Object.assign({}, st, { rangeNoise: 0, rangeNoiseAgg: 0 })), 'A5 check-raising A-Q-6 stays in the range');
  // Shows that fit a low noise level better pull this player's noise down.
  const fit = { top: 0.3, lr: 2, sq: 0.5, tl: E.TILTS.map(() => 0), nl: E.NOISES.map((x) => -8 * x), agg: false, v: E.FIT_VERSION };
  const shows = Array(15).fill(0).map(() => ({ cards: ['2c', '3d'], board: ['Kd', '8h', '2s'], agg: [], fit }));
  assert.ok(E.computeStats(tallyWith({ shows }), 'typical').rangeNoise < st.rangeNoise - 0.1);
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
  // Against solid callers: against the home game's loose limpers A-Q high is not air on K-8-4.
  const spot = (h) => E.analyzeSync({ hero: C(h), board: C('Kd 8h 4s'), pot: 60, toCall: 0, stack: 1000, bigBlind: 10, mix: false, seed: 5, inPosition: false, tableStyle: 'solid',
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
  // 8, not 15: with medium hands in the betting range the draw has a little more equity right
  // away, and in the home prior fitted on three logs a bettor folds more later in the hand
  // (foldAfterAgg 0.35, 94 spots), so hitting pays a little less. The lookahead still adds ~9.
  assert.ok(call(ahead) > call(now) + 8, `${call(ahead)} vs ${call(now)}`);
});

test('lookahead: real hand flop decision stays sane', () => {
  const x = replay(real).turns[1];
  const r = E.analyzeSync(Object.assign({}, x.input, { iterations: 6000, mix: false, seed: 7 }));
  assert.strictEqual(r.lookahead, true);
  // Top pair on a monotone board facing a 1.5x pot lead: calling is close, never a clear fold.
  // (Friends lead the flop only about one time in five, so a big lead reads fairly strong.)
  const call = r.ranked.find((s) => s.kind === 'call');
  assert.ok(call.ev > -0.1 * r.pot, 'call EV ' + call.ev);
  r.ranked.forEach((s) => assert.ok(isFinite(s.ev)));
});

// ---------------------------------------------------------------------------
// 6. Ideas from the poker-AI research write-up
// ---------------------------------------------------------------------------
test('mixing: close spots come back as frequencies, and the seed picks one', () => {
  // A flop spot where checking and a small bet come out close.
  const base = flopSpot('Ah 5c', { board: C('As 9c 4d'), iterations: 3000, tableStyle: 'solid' });
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
  assert.ok(E.foldAtSize(st, 2, 5) < st.byStreet[5].foldToBet + 0.18, String(E.foldAtSize(st, 2, 5)));
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
  const shows = (top) => Array(10).fill(0).map(() => ({ cards: ['2c', '3d'], board: ['Kd', '8h', '2s'], agg: [], fit: { top, lr: top < 0.5 ? 2 : 0.2, v: E.FIT_VERSION } }));
  const good = E.computeStats(Object.assign(T.blankTally(), base, { shows: shows(0.3) }), 'typical');
  const bad = E.computeStats(Object.assign(T.blankTally(), base, { shows: shows(0.9) }), 'typical');
  assert.ok(good.exploitWeight > bad.exploitWeight + 0.1);
  assert.ok(good.accuracy.vsGuess > 1 && bad.accuracy.vsGuess < 1);
});

test('read accuracy: players who keep showing weaker hands get weaker ranges', () => {
  const base = { pfFold: 30, pfCall: 20, pfRaise: 10, check: 30, bet: 15, call: 15, fold: 15 };
  // Learned from each show's likelihood under weaker and stronger ranges (fit.tl), here
  // shows that fit the weakest tilt best.
  const shows = (sq) => Array(12).fill(0).map(() => ({ cards: ['2c', '3d'], board: ['Kd', '8h', '2s'], agg: [], fit: { top: 0.5, lr: 1, sq, tl: E.TILTS.map((x) => -3 * x), agg: false, v: E.FIT_VERSION } }));
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
    // Solid table: the home game's average player bets the river so often that K-Q calls both.
    const r = E.analyzeSync(riverSpot('Kh Qh', { tableStyle: 'solid', opponents: [{ name: 'V', tally, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: 'bet' }, sizes: { river: 1 } }] }));
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
  // Same bet size in both (the best-ranked size can differ).
  const fold = (r) => r.ranked.find((s) => s.kind === 'bet' && s.amount === 75).foldPct;
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
  // A solid opponent: against the home game's passive big blind the solver limps 7-2 for a sliver.
  const aa = pfSpot('Ah As'), junk = pfSpot('7c 2d', { tableStyle: 'solid' });
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

test('flop solver: computer mode only; heads-up and against the field', () => {
  const flop = (h, extra) => E.analyzeSync(Object.assign({
    hero: C(h), board: C('Kh 8h 4c'), pot: 20, toCall: 8, stack: 100, bigBlind: 1, inPosition: true, mix: false, seed: 5,
    iterations: 2000, flopIterations: 8, heroActions: { pre: 'call' },
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true }],
  }, extra));
  assert.strictEqual(flop('Ah 5h').solver, null);
  assert.strictEqual(E.solvableSpot({ board: C('Kh 8h 4c'), opponents: [{}] }), null);
  assert.strictEqual(E.solvableSpot({ board: C('Kh 8h 4c'), opponents: [{}], flopSolver: true }), 'flop');
  const draw = flop('Ah 5h', { flopSolver: true }), air = flop('Qc 2d', { flopSolver: true });
  assert.strictEqual(draw.solver.kind, 'flop');
  assert.notStrictEqual(draw.best.kind, 'fold');
  assert.strictEqual(air.best.kind, 'fold');
  for (const r of [draw, air]) assert.ok(r.ranked.every((x) => isFinite(x.ev)));
  const field = flop('Ah 5h', { flopSolver: true, pot: 34, opponents: [
    { name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true },
    { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call' } }] });
  assert.strictEqual(field.solver.kind, 'flop');
  assert.strictEqual(field.solver.field, 2);
  assert.ok(field.ranked.every((x) => isFinite(x.ev)));
  // River betting at the end of the turn lines (flopRiverBet): a made flush draw gets paid.
  const rb = flop('Ah 5h', { flopSolver: true, flopRiverBet: 0.5 });
  const ev = (r, k) => r.ranked.find((x) => x.kind === k).ev;
  assert.ok(rb.ranked.every((x) => isFinite(x.ev)));
  assert.ok(ev(rb, 'call') > ev(draw, 'call'));
});

test('river: hands that play a straight-or-better board call, so bluffing into them is no edge', () => {
  // Marwin's log, hand 93: three passive players, board 8-Q straight, hero 2d7h plays the board.
  const opps = ['A', 'B', 'C'].map((name) => ({ name, tally: {}, actions: { pre: 'call', flop: 'check', turn: 'check', river: '' } }));
  const spot = (extra) => E.analyzeSync(Object.assign({ hero: C('2d 7h'), board: C('Jd Qc Tc 9h 8c'), pot: 8, toCall: 0, stack: 300,
    bigBlind: 2, inPosition: false, mix: false, seed: 1, iterations: 6000, opponents: opps,
    heroActions: { pre: 'call', flop: 'check', turn: 'check' } }, extra));
  assert.strictEqual(spot({ riverSolver: false }).best.kind, 'check');
  assert.strictEqual(spot({ riverSolver: false, opponents: [opps[0]] }).best.kind, 'check');
  for (const r of [spot({}), spot({ opponents: [opps[0]] })]) {
    const ev = (k) => Math.max(...r.ranked.filter((a) => a.kind === k).map((a) => a.ev));
    assert.ok(ev('bet') - ev('check') < 0.25, `bet ${ev('bet')} vs check ${ev('check')}`);
  }
});

test('multiway solves run when every shorter stack still has a few pots behind', () => {
  const opps = (short) => [130, 335, short].map((stack, i) => ({ name: 'P' + i, tally: {}, stack, committed: 2,
    actions: { pre: 'call', flop: 'check', turn: 'check', river: '' } }));
  const spot = (short) => ({ hero: C('Ah Kd'), board: C('Jd 7c 4c 9h 2s'), pot: 8, toCall: 0, stack: 300, heroCommitted: 2,
    bigBlind: 2, inPosition: false, mix: false, seed: 1, iterations: 3000, opponents: opps(short),
    heroActions: { pre: 'call', flop: 'check', turn: 'check' } });
  const deep = E.analyzeSync(spot(218));
  assert.strictEqual(deep.solver && deep.solver.kind, 'river');
  assert.strictEqual(E.solvableSpot(spot(218)), 'river');
  // One player with less than a pot behind: side pots matter, the Monte Carlo decides.
  assert.strictEqual(E.analyzeSync(spot(5)).solver, null);
  assert.strictEqual(E.solvableSpot(spot(5)), null);
});

test('tracker passes chips committed and behind for side pots', () => {
  const x = replay(three).turns[1];
  assert.strictEqual(x.input.heroCommitted, 30);
  assert.deepStrictEqual(x.input.opponents.map((o) => [o.committed, o.stack]), [[30, 970], [30, 970]]);
});

// ---------------------------------------------------------------------------
// WebAssembly kernels: the same numbers as the JS loops
// ---------------------------------------------------------------------------
test('kernels: river, preflop and turn solves give bit-identical results with and without WebAssembly', () => {
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
    // Turn solver: facing a bet, first to act (odd and even hand counts), and multiway.
    turnSpot('Qs Js', { turnSolver: true, turnIterations: 6, heroActions: { pre: 'raise', flop: 'call' } }),
    turnSpot('Ah Kd', { turnSolver: true, turnIterations: 6, toCall: 0, inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'call', turn: '' } }], heroActions: { pre: 'raise', flop: 'bet' } }),
    // Boards where a straight can be (or is) on the board: ties for every hand that plays it.
    turnSpot('As Qd', { turnSolver: true, turnIterations: 6, board: C('Ts 9d 8c 7h') }),
    riverSpot('As Qd', { riverIterations: 60, board: C('Ts 9d 8c 7h 6s') }),
    turnSpot('4c 4h', { turnSolver: true, turnIterations: 6, pot: 30, toCall: 15, stack: 150,
      opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet', turn: 'bet' }, pfAggressor: true }, { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'pending' } }] }),
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

// ---------------------------------------------------------------------------
// 9. Audit: chip accounting (pot odds, side pots, all-ins, blinds)
// ---------------------------------------------------------------------------
test('short hero vs a bigger bet: the part hero cannot match is not in the pot', () => {
  // Pot 300, a deep opponent bets 300, hero has only 100 behind. Calling all-in plays for
  // 300 + 100 + 100 = 500 (the other 200 goes back to them), so the price is 100 / 500.
  const spot = { hero: C('Th 9h'), board: C('Kd 8h 2s 3c'), pot: 600, toCall: 100, stack: 100, bigBlind: 10, mix: false, seed: 1, iterations: 6000,
    heroCommitted: 50, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'bet' }, stack: 700, committed: 350 }] };
  const r = E.analyzeSync(spot);
  assert.strictEqual(r.potWin, 400);
  assert.ok(Math.abs(r.potOdds - 0.2) < 1e-9, String(r.potOdds));
  const call = r.ranked.find((s) => s.kind === 'allin');
  assert.ok(Math.abs(call.ev - (r.equity.share * 500 - 100)) < 1e-6, `${call.ev} vs ${r.equity.share * 500 - 100}`);
  // The river solver plays for the same pot.
  const river = E.analyzeSync(Object.assign({}, spot, { board: C('Kd 8h 2s 3c 7d'), opponents: [Object.assign({}, spot.opponents[0], { actions: { pre: 'call', flop: 'call', turn: 'call', river: 'bet' } })] }));
  assert.ok(river.solver);
  river.ranked.forEach((s) => assert.ok(s.ev <= 400 + 1e-6, `${s.kind}: ${s.ev}`));
  assert.strictEqual(E.solvableSpot(Object.assign({}, spot, { board: C('Kd 8h 2s 3c 7d'), opponents: [spot.opponents[0], Object.assign({}, spot.opponents[0], { name: 'W' })] })), null);
});

test('an opponent who is already all-in cannot fold to a bet', () => {
  const r = E.analyzeSync({ hero: C('Ah Qd'), board: C('Kd 8h 2s 3c'), pot: 300, toCall: 0, stack: 1000, bigBlind: 10, mix: false, seed: 1, iterations: 3000, inPosition: true,
    heroCommitted: 100, opponents: [
      { name: 'Short', tally: {}, actions: { pre: 'call', flop: 'call', turn: '' }, stack: 0, committed: 100 },
      { name: 'Deep', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'check' }, stack: 2000, committed: 100 }] });
  for (const s of r.ranked.filter((x) => x.kind === 'bet' || x.kind === 'allin')) {
    assert.strictEqual(s.oppFolds[0], 0, `${s.kind} ${s.amount}: Short folded ${s.oppFolds[0]} times`);
    assert.strictEqual(s.foldPct, 0, 'nobody can fold everyone out of an all-in pot');
  }
});

test('blinds already posted are not counted twice when they call', () => {
  // CO opens to 6 (bb 2), hero on the button calls, SB (1 in) and BB (2 in) still to act.
  const r = E.analyzeSync({ hero: C('9h 8h'), board: [], pot: 9, toCall: 6, stack: 200, bigBlind: 2, mix: false, seed: 1, iterations: 500, inPosition: true,
    heroBet: 0, opponents: [
      { name: 'SB', tally: {}, actions: { pre: 'pending' }, bet: 1 },
      { name: 'BB', tally: {}, actions: { pre: 'pending' }, bet: 2 },
      { name: 'CO', tally: {}, actions: { pre: 'raise' }, bet: 6 }] });
  const call = r.scenarios.find((s) => s.kind === 'call');
  assert.deepStrictEqual(call.opp.map((o) => o.add), [5, 4, 0]);
  const raise = r.scenarios.find((s) => s.kind === 'raise');
  assert.deepStrictEqual(raise.opp.map((o) => o.add), [raise.amount - 1, raise.amount - 2, raise.amount - 6]);
  // The tracker passes what each player has in on this street.
  const x = replay(three).turns[0];
  assert.strictEqual(x.input.heroBet, 10);
  assert.deepStrictEqual(x.input.opponents.map((o) => o.bet), [30, 30]);
});

test('no discount for later streets when nobody can bet any more', () => {
  // The opponent is all-in: calling just runs the board out, so EV = equity x pot - call.
  const r = E.analyzeSync({ hero: C('Ah Kh'), board: C('Qh 7h 2c'), pot: 300, toCall: 100, stack: 1000, bigBlind: 10, mix: false, seed: 2, iterations: 4000, inPosition: false,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'raise' }, stack: 0 }] });
  const call = r.ranked.find((s) => s.kind === 'call');
  assert.ok(Math.abs(call.ev - (r.equity.share * 400 - 100)) < 1e-6, `${call.ev} vs ${r.equity.share * 400 - 100}`);
});

test('look-ahead bets stop at the chips the opponent has left', () => {
  // Hero has top set; the opponent has 20 behind after their bet. Hero can win at most the
  // pot (with their bet) plus those 20.
  const r = E.analyzeSync({ hero: C('Kh Ks'), board: C('Kd 7c 2s'), pot: 200, toCall: 100, stack: 1000, bigBlind: 10, mix: false, seed: 4, iterations: 4000, inPosition: true,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'bet' }, stack: 20 }] });
  const call = r.ranked.find((s) => s.kind === 'call');
  assert.ok(call.lookedPct > 0.9);
  assert.ok(call.evRead <= 200 + 20 + 1e-6, String(call.evRead));
});

test('robust EV: shoves on the flop and turn are stress-tested like other bets', () => {
  // A draw with a short stack: the all-in leans on fold equity, so an opponent who calls
  // more than the read says must cost it, as it costs the smaller bets.
  const r = E.analyzeSync({ hero: C('9c 8c'), board: C('Tc 7d 2h 3s'), pot: 150, toCall: 0, stack: 300, bigBlind: 10, mix: false, seed: 3, iterations: 6000, inPosition: true,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'check' } }] });
  assert.ok(r.robustWeight > 0);
  const shove = r.ranked.find((s) => s.kind === 'allin');
  assert.ok(shove.evWorst < shove.evRead - 10, `${shove.evWorst} vs ${shove.evRead}`);
  assert.ok(shove.ev < shove.evRead);
  assert.notStrictEqual(r.best.kind, 'allin');
});

test('multiway: position is taken against each opponent, not the whole table', () => {
  // Hero in the big blind on the flop: the small blind acts before hero, the button after.
  const x = replay(three).turns[1];
  assert.strictEqual(x.input.inPosition, false);
  assert.deepStrictEqual(x.input.opponents.map((o) => [o.name, o.heroIP]), [['Ann', false], ['Bob', true]]);
  // The play-outs (multiway, and heads-up once one folds) use hero's position against each
  // opponent: a draw that bets is worth more acting last against both than acting first.
  const spot = (ip) => E.analyzeSync({ hero: C('9h 8h'), board: C('Kd 7c 2h'), pot: 90, toCall: 0, stack: 970, bigBlind: 10, mix: false, seed: 6, iterations: 8000, inPosition: false,
    opponents: ['A', 'B'].map((n) => ({ name: n, tally: {}, actions: { pre: 'call', flop: 'check' }, heroIP: ip })) });
  const bet = (r) => r.ranked.find((s) => s.kind === 'bet').evRead;
  const ip = spot(true), oop = spot(false);
  assert.ok(bet(ip) > bet(oop) + 3, `${bet(ip)} vs ${bet(oop)}`);
});

// Real 5-handed hand (names anonymized). Seats s1, s7, s8, s3_v2, s10; the server's blinds
// and preflop action order put s3_v2 between s8 and s10, although its digits read as 32.
const fiveV2 = require(path.join(__dirname, 'fixtures/real-5handed-seat-v2.json'));
function seatsAtFirstTurn(msgs) {
  const t = new T({ players: {} });
  let first = null;
  t.on((type, p) => {
    if (type === 'turn' && p.isHero && !first) first = { order: t.seatOrder().map((x) => x.pos), b: t.solverInput('typical') };
  });
  for (const m of msgs) t.handle(m.ev, m.data, m.snap);
  return first;
}

test('seat order: the s3_v2 seat sits between s9 and s10, blinds and UTG come from the server', () => {
  const x = seatsAtFirstTurn(fiveV2);
  assert.deepStrictEqual(x.order, ['s10', 's1', 's7', 's8', 's3_v2']);
  const i = x.b.input;
  assert.strictEqual(i.heroPosition, 'early');
  assert.strictEqual(i.inPosition, false);
  assert.deepStrictEqual(i.opponents.map((o) => [o.name, o.position, o.heroIP]),
    [['P2', 'late', false], ['P4', 'late', false], ['P3', 'blinds', true], ['P1', 'blinds', true]]);
  // Without the blinds and UTG in dealer_updated (older recordings), the seat order alone
  // gives the same ring.
  const bare = fiveV2.map((m) => (m.ev === 'game:dealer_updated' ? Object.assign({}, m, { data: { dealerSeatPos: m.data.dealerSeatPos } }) : m));
  assert.deepStrictEqual(seatsAtFirstTurn(bare).order, x.order);
});

// ---------------------------------------------------------------------------
// 10. Property tests: random spots and random hands (test/fuzz.js)
// ---------------------------------------------------------------------------
const F = require('./fuzz.js');

test('fuzz: advice is legal and EVs stay within what can be lost or won (random spots)', () => {
  const bad = [];
  const run = (seed, n, extra) => {
    const r = F.rng32(seed);
    for (let k = 0; k < n;) {
      const s = F.randomSpot(r, extra);
      if (!s) continue;
      k++;
      for (const x of F.adviceProblems(s, E.analyzeSync(s))) bad.push(`seed ${seed} spot ${k} (street ${s.board.length}, ${s.opponents.length} opp): ${x}`);
    }
  };
  run(11, 200);
  // Computer mode: turn and flop solvers too.
  run(12, 30, { turnSolver: true, turnIterations: 3, turnTimeMs: 200, flopSolver: true, flopIterations: 2, flopTimeMs: 200 });
  assert.deepStrictEqual(bad, []);
});

test('fuzz: random hands through the tracker match the table (chips, price, stacks, seats) and get legal advice', () => {
  const r = F.rng32(5);
  const db = { players: {} };
  const bad = [];
  let turns = 0;
  for (let h = 0; h < 150; h++) {
    const hand = F.randomHand(r);
    const t = new T(db);
    t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
    const got = [];
    t.on((type, p) => { if (type === 'turn' && p.isHero) got.push(t.solverInput('typical')); });
    for (const m of hand.msgs) t.handle(m.ev, m.data, m.snap);
    if (got.length !== hand.truth.length) { bad.push(`hand ${h}: ${got.length} hero turns, expected ${hand.truth.length}`); continue; }
    got.forEach((b, k) => {
      turns++;
      const w = hand.truth[k], tag = `hand ${h} turn ${k}`;
      if (b.error) { bad.push(`${tag}: ${b.error}`); return; }
      const i = b.input;
      for (const f of ['pot', 'toCall', 'stack']) if (Math.abs(i[f] - w[f]) > 1e-9) bad.push(`${tag}: ${f} ${i[f]}, table says ${w[f]}`);
      // pending: no action yet on this street.
      const nm = ['pre', null, null, 'flop', 'turn', 'river'][i.board.length];
      const pending = (o) => (nm === 'pre' ? (o.actions.pre || 'pending') === 'pending' : !o.actions[nm]);
      const mine = JSON.stringify(i.opponents.map((o) => [o.name, o.committed, o.stack, o.bet, o.heroIP, pending(o)]));
      const real = JSON.stringify(w.opponents.map((o) => [o.name, o.committed, o.stack, o.bet, o.heroIP, o.pending]));
      if (mine !== real) bad.push(`${tag}: opponents ${mine}, table says ${real}`);
      if (h % 3 === 0) {
        const res = E.analyzeSync(Object.assign({}, i, { iterations: 400, riverIterations: 20, preflopIterations: 20, mix: false, seed: 1 }));
        for (const x of F.adviceProblems(i, res)) bad.push(`${tag}: ${x}`);
      }
    });
  }
  assert.ok(turns > 250, String(turns));
  assert.deepStrictEqual(bad, []);
});

test('fuzz: extreme players (nit, maniac, station, always-raise, always-fold) keep reads finite and advice legal', () => {
  const styles = {
    A1: { fold: 0.85, call: 0.98, check: 0.95 }, A2: { fold: 0.02, call: 0.3, check: 0.1 }, A3: { fold: 0, call: 1, check: 0.9 },
    A4: { fold: 0, call: 0, check: 0 }, A5: { fold: 1, call: 1, check: 1 }, A6: { fold: 0.5, call: 0.5, check: 0 },
  };
  const r = F.rng32(9);
  const db = { players: {} };
  const bad = [];
  let checked = 0;
  for (let h = 0; h < 120; h++) {
    const hand = F.randomHand(r, { styles });
    const t = new T(db);
    t.scorer = (show, tally) => E.scoreShow(show, tally, 'home');
    const got = [];
    t.on((type, p) => { if (type === 'turn' && p.isHero) got.push(t.solverInput('home')); });
    for (const m of hand.msgs) t.handle(m.ev, m.data, m.snap);
    if (h < 60 || h % 2) continue; // reads build up first
    got.forEach((b, k) => {
      if (b.error) { bad.push(`hand ${h} turn ${k}: ${b.error}`); return; }
      const i = b.input;
      const res = E.analyzeSync(Object.assign({}, i, { iterations: 400, riverIterations: 20, preflopIterations: 20, mix: false, seed: 1,
        turnSolver: true, turnIterations: 4, flopSolver: true, flopIterations: 2 }));
      checked++;
      for (const x of F.adviceProblems(i, res)) bad.push(`hand ${h} turn ${k}: ${x}`);
      for (const o of res.opponents || []) for (const [key, v] of Object.entries(o.stats || {})) if (typeof v === 'number' && !isFinite(v)) bad.push(`hand ${h}: ${o.name} ${key} = ${v}`);
    });
  }
  assert.ok(checked > 40, String(checked));
  assert.deepStrictEqual(bad, []);
});

test('solver bets are at least the big blind (small pots on the river)', () => {
  // Heads-up limped pot checked to the river: 2 big blinds. A third of the pot is less than a big blind.
  const r = E.analyzeSync({ hero: C('Ah 7d'), board: C('Kd 8h 4s 2c 7c'), pot: 20, toCall: 0, stack: 990, bigBlind: 10, mix: false, seed: 1, iterations: 3000, inPosition: true,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'check', turn: 'check', river: 'check' } }] });
  assert.ok(r.solver, 'river solver ran');
  for (const s of r.ranked) if (s.kind === 'bet') assert.ok(s.amount >= 10, `bet ${s.amount}`);
});

test('solver EVs: an option hero never takes is valued with good play after it (check-fold is not a loss)', () => {
  // Air, first to act on the river. The solver bets it as a bluff every time, so its average
  // strategy after a check never trained on this hand and stayed near uniform: it called and
  // shoved 2 times in 3 after checking, and checking showed -18 chips. Checking and then folding
  // to a bet loses nothing.
  const spot = { hero: C('6h 2d'), board: C('5c 5d Kc 3d Ac'), pot: 176, toCall: 0, stack: 180, bigBlind: 10, inPosition: false, mix: false, seed: 1,
    iterations: 3000, riverIterations: 150, heroCommitted: 6,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'check', flop: 'check', turn: 'call', river: '' }, stack: 200, committed: 134, heroIP: false }] };
  for (const extra of [{}, { riverIterations: 1500 }]) {
    const r = E.analyzeSync(Object.assign({}, spot, extra));
    assert.strictEqual(r.solver && r.solver.kind, 'river');
    const check = r.ranked.find((s) => s.kind === 'check');
    assert.ok(check.ev >= 0, `check EV ${check.ev}`);
  }
  // The same on the turn (turn and river in one solve) and preflop: every check is worth at least 0.
  const turn = E.analyzeSync(Object.assign({}, spot, { board: C('5c 5d Kc 3d'), turnSolver: true, turnIterations: 12,
    opponents: [Object.assign({}, spot.opponents[0], { actions: { pre: 'check', flop: 'check', turn: '' } })] }));
  assert.strictEqual(turn.solver && turn.solver.kind, 'turn');
  assert.ok(turn.ranked.find((s) => s.kind === 'check').ev >= 0);
  const bb = E.analyzeSync({ hero: C('7h 2d'), board: [], pot: 20, toCall: 0, stack: 990, bigBlind: 10, inPosition: false, mix: false, seed: 1, iterations: 2000,
    preflopIterations: 200, heroActions: { pre: 'pending' }, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call' } }] });
  assert.strictEqual(bb.solver && bb.solver.kind, 'preflop');
  assert.ok(bb.ranked.find((s) => s.kind === 'check').ev >= 0);
});

test('blinds: a big blind posted short (all-in for less) does not change the big blind', () => {
  // Ann (s3) is the big blind with 4 chips left; the table's big blind is 10.
  const msgs = [];
  const add = (ev, data, snap) => msgs.push({ ev, data, snap });
  const s0 = snap3(1000, 4, 1000);
  add('admin:game:new_hand_started', { gameSettings: { big_blind: 10, small_blind: 5 } }, s0);
  add('game:stage_began', { stageType: 'set_blinds' }, s0);
  add('game:dealer_updated', { dealerSeatPos: 's7', smallBlindSeatPos: 's1', bigBlindSeatPos: 's3', underTheGunSeatPos: 's7' }, s0);
  add('game:small_blind_paid', { amount: 5, playerId: 1 }, s0);
  add('game:big_blind_paid', { amount: 4, playerId: 3 }, snap3(995, 4, 1000));
  add('game:cards_dealt_to_player', [{ playerPos: 's1', cardData: { uniqueID: 11 } }, { playerPos: 's1', cardData: { uniqueID: 12 } }], snap3(995, 0, 1000));
  add('game:update_card_data', { cardData: { uniqueID: 11, suite: 'spades', value: 'A' } }, snap3(995, 0, 1000));
  add('game:update_card_data', { cardData: { uniqueID: 12, suite: 'hearts', value: 'K' } }, snap3(995, 0, 1000));
  add('game:stage_began', { stageType: 'pre_flop' }, snap3(995, 0, 1000));
  add('player:game:action_taken', { playerID: 7, actionType: 'raise', makeBetValue: 30 }, snap3(995, 0, 1000));
  add('game:player_turn_started', { playerID: 1 }, snap3(995, 0, 970));
  const { t, turns } = replay(msgs);
  assert.strictEqual(t.hand.bigBlind, 10);
  assert.strictEqual(turns[0].input.bigBlind, 10);
  // Without the settings event, the snapshot's big blind is used for the short post.
  const { t: t2 } = replay(msgs.slice(1));
  assert.strictEqual(t2.hand.bigBlind, 10);
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
