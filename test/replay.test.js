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

test('old saved reads get the new fields', () => {
  const db = { players: { V: { name: 'Vic', tally: { pfFold: 3, pfCall: 2, pfRaise: 1, check: 4, bet: 2, call: 1, raise: 0, fold: 3 } } } };
  const t = replay(sd, db).t.db.players.V.tally;
  assert.strictEqual(t.pfFold, 3);
  assert.strictEqual(t.pfCall, 3);
  assert.strictEqual(t.shows.length, 1);
  assert.strictEqual(t.st.river.bet, 1);
});

// ---------------------------------------------------------------------------
// 4. Engine: opponent modelling from the new reads
// ---------------------------------------------------------------------------
const C = (s) => s.split(' ').map(E.parseCard);
const tallyWith = (extra) => Object.assign(T.blankTally(), { pfFold: 10, pfCall: 8, pfRaise: 4, check: 20, bet: 12, call: 10, raise: 2, fold: 12 }, extra);
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
  const st = E.computeStats(tallyWith({ vs: { small: { fold: 0, call: 12, raise: 0 }, medium: { fold: 3, call: 3, raise: 0 }, large: { fold: 12, call: 0, raise: 0 } } }), 'typical');
  const base = E.computeStats(tallyWith({}), 'typical');
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(base, 0.33, 3) - 0.15);
  assert.ok(E.foldAtSize(st, 1.2, 3) > E.foldAtSize(base, 1.2, 3) + 0.15);
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(st, 0.66, 3));
  assert.ok(E.foldAtSize(st, 0.66, 3) < E.foldAtSize(st, 1.2, 3));
});

test('engine: per-street reads move that street only', () => {
  const st = E.computeStats(tallyWith({ st: { flop: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, turn: { check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, river: { check: 0, bet: 0, call: 0, raise: 0, fold: 20 } } }), 'typical');
  assert.ok(st.byStreet[5].foldToBet > st.byStreet[3].foldToBet + 0.2);
  assert.ok(Math.abs(st.byStreet[3].foldToBet - st.foldToBet) < 1e-9);
});

test('engine: 3-bet range follows the observed 3-bet rate', () => {
  const tight = E.computeStats(tallyWith({ pf3betOpp: 30, pf3bet: 1 }), 'typical');
  const loose = E.computeStats(tallyWith({ pf3betOpp: 30, pf3bet: 9 }), 'typical');
  const width = (st) => E.preflopRange(st, '3bet').reduce((a, b) => a + b, 0);
  assert.ok(width(loose) > 2 * width(tight));
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
  assert.ok(call(ahead) > call(now) + 20, `${call(ahead)} vs ${call(now)}`);
});

test('lookahead: real hand flop decision stays sane', () => {
  const x = replay(real).turns[1];
  const r = E.analyzeSync(Object.assign({}, x.input, { iterations: 6000 }));
  assert.strictEqual(r.lookahead, true);
  assert.notStrictEqual(r.best.kind, 'fold');
  r.ranked.forEach((s) => assert.ok(isFinite(s.ev)));
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
