// Replays recorded and synthetic Poker Patio event streams through the tracker
// and solver, and checks the numbers the solver is given. Run: npm test
const assert = require('assert');
const path = require('path');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');

let failures = 0;
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
  assert.strictEqual(tally.pfFold, 1);
  assert.strictEqual(tally.bet, 2);
  assert.strictEqual(tally.fold, 1);
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

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
