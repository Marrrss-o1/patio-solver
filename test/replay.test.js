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

test('tracker: preflop raises carry the raise-to, the chips left behind and the biggest stack still in, in big blinds (sizes.preTo / preBehind / preCover)', () => {
  const { turns } = replay(require(path.join(__dirname, 'fixtures/three-hand-150bb.json')));
  const ann = turns.find((b) => b.input && b.input.board.length === 0).input.opponents.find((o) => o.name === 'Ann');
  assert.deepStrictEqual(ann.sizes, { pre: 2, preTo: 3, preBehind: 147, preCover: 150 });
});

test('tracker: shown preflop all-in re-raises go in tally.jamShows at any board; raises with chips behind do not', () => {
  const t = new T({ players: {} });
  t.snap = { players: [], heroAuthId: 'H' };
  const pl = (pos, id, preBehind) => ({ pos, id, auth: id, name: id, shown: [], seq: { pre: ['raise', '3bet'] }, preTop: 3, sizes: { pre: 25, preTo: 500, preBehind, preCover: 258 } });
  t.hand = { board: [], players: { M: pl('s1', 'M', 0), K: pl('s2', 'K', 200) } };
  for (const [pos, c] of [['s1', 'Jh'], ['s1', 'Js'], ['s2', 'Ah'], ['s2', 'Kh']]) t.onReveal(pos, c);
  assert.deepStrictEqual(t.db.players.M.tally.jamShows, [{ cards: ['Jh', 'Js'], pre: '4bet', to: 500, cover: 258 }]);
  assert.ok(!t.db.players.K || !(t.db.players.K.tally.jamShows || []).length);
});

test('tracker: tagJamShows fills in shown all-in re-raises from stored hands, once', () => {
  const t = new T({ players: { M: { name: 'Mark', tally: {} }, J: { name: 'Jo', tally: {} } } });
  const hand = (t0, cards, behind) => ({
    t: t0, bigBlind: 2, board: [],
    players: [{ name: 'Hero', hero: true, stack: 260, shown: [] }, { name: 'Mark', stack: 600, shown: cards }, { name: 'Jo', stack: 400, shown: ['Ah', 'Kh'] }],
    log: [
      { st: 'pre', who: 'Hero', act: 'sb', amt: 1 }, { st: 'pre', who: 'Mark', act: 'bb', amt: 2 },
      { st: 'pre', who: 'Jo', act: 'raise', amt: 6, to: 6, stack: 400 }, { st: 'pre', who: 'Hero', act: 'fold', amt: 0 },
      { st: 'pre', who: 'Mark', act: '3bet', amt: 598 - behind, to: 600 - behind, stack: 598, allin: !behind }, { st: 'pre', who: 'Jo', act: 'call', amt: 394, to: 400, stack: 394 },
    ],
  });
  // Jo's open isn't a re-raise; Mark's 3-bet keeping 100bb behind isn't all-in.
  assert.strictEqual(t.tagJamShows([hand(2, ['Jh', 'Js'], 0), hand(1, ['Qd', 'Qs'], 200)]), 1);
  assert.deepStrictEqual(t.db.players.M.tally.jamShows, [{ cards: ['Jh', 'Js'], pre: '3bet', to: 300, cover: 200 }]);
  assert.ok(!(t.db.players.J.tally.jamShows || []).length);
  assert.strictEqual(t.tagJamShows([hand(2, ['Jh', 'Js'], 0)]), 0, 'already there');
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

test('followed: a call matches "Call all-in" advice but not an all-in raise', () => {
  const f = T.followedAdvice;
  assert.strictEqual(f({ kind: 'allin', amount: 40, toCall: 40 }, 'call'), true);
  assert.strictEqual(f({ kind: 'allin', amount: 300, toCall: 40 }, 'call'), false);
  assert.strictEqual(f({ kind: 'allin', amount: 300, toCall: 40 }, 'raise'), true);
  assert.strictEqual(f({ kind: 'raise', amount: 120, toCall: 40 }, 'allin'), true);
  assert.strictEqual(f({ kind: 'call', amount: 40, toCall: 40 }, 'call'), true);
  assert.strictEqual(f({ kind: 'check', amount: 0, toCall: 0 }, 'bet'), false);
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
  assert.strictEqual(t.vs.medium.fn, 1);              // ... a half-pot bet, kept for the size read
  assert.ok(Math.abs(t.vs.medium.fs - 0.5) < 1e-9);
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

test('showdown hand: the show records whether hero was in and what they put in (heroPotShows)', () => {
  const t = new T({ players: {} });
  t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical', t.poolTally());
  t.fitVersion = E.FIT_VERSION;
  for (const m of sd) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); }
  const sh = t.db.players.V.tally.shows[0];
  assert.deepStrictEqual(sh.hp, { in: true, put: 24 }); // check-called the flop, 24bb in, hero to showdown
  const hps = t.heroPotShows();
  assert.strictEqual(hps.hiN, 1); assert.strictEqual(hps.hoN, 0);
  assert.deepStrictEqual(hps.hi, sh.fit.tl);
  sh.actions.flop = 'bet'; // flop aggression: not counted
  assert.strictEqual(t.heroPotShows().hiN, 0);
});

test('shows saved before v1.8.9 get their hp from the stored hands (tagHeroPot)', () => {
  const t = new T({ players: {} });
  for (const m of sd) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); }
  const sh = t.db.players.V.tally.shows[0], hist = t.db.history;
  const want = sh.hp;
  delete sh.hp;
  assert.strictEqual(t.tagHeroPot([]), 0);
  assert.strictEqual(sh.hp, undefined);
  assert.strictEqual(t.tagHeroPot(JSON.parse(JSON.stringify(hist))), 1);
  assert.deepStrictEqual(sh.hp, want);
  assert.strictEqual(t.tagHeroPot(hist), 0, 'tagged shows are left alone');
  // A show made before the river (an all-in) matches the hand by the board's first cards.
  delete sh.hp; const full = sh.board; sh.board = full.slice(0, 3);
  assert.strictEqual(t.tagHeroPot(hist), 1);
  assert.deepStrictEqual(sh.hp, want);
  delete sh.hp; sh.board = ['Kd', '8h', '3s']; // a different board: no match
  assert.strictEqual(t.tagHeroPot(hist), 0);
  sh.board = full;
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

test('engine: fold rate follows the bet sizes they actually fold to, slowly', () => {
  // Never folds to small bets, always folds to big ones, seen n times at each size.
  const sized = (n) => E.computeStats(tallyWith({ vs: { small: { fold: 0, call: n, raise: 0 }, medium: { fold: n / 2, call: n / 2, raise: 0 }, large: { fold: n, call: 0, raise: 0 } } }), 'typical');
  const base = E.computeStats(tallyWith({}), 'typical');
  const st = sized(30);
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(base, 0.33, 3) - 0.1);
  assert.ok(E.foldAtSize(st, 1.2, 3) > E.foldAtSize(base, 1.2, 3) + 0.06);
  assert.ok(E.foldAtSize(st, 0.33, 3) < E.foldAtSize(st, 0.66, 3));
  assert.ok(E.foldAtSize(st, 0.66, 3) < E.foldAtSize(st, 1.2, 3));
  // A few bets of each size barely move it: in the logs, how a friend answers one size compared
  // with the others was noise at home-game sample sizes (their fold rate by street is not).
  const few = sized(5);
  for (const f of [0.33, 0.66, 1.2]) assert.ok(Math.abs(E.foldAtSize(few, f, 3) - E.foldAtSize(base, f, 3)) < 0.04, `size ${f}`);
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

test('reads: after checking a street they fold more and check-raise less; facing a lead they raise more', () => {
  const base = E.computeStats(tallyWith({}), 'typical');
  const checked = E.computeStats(tallyWith({}), 'typical', null, { street: 4, line: 'checked' });
  const unacted = E.computeStats(tallyWith({}), 'typical', null, { street: 4, line: 'unacted' });
  assert.ok(checked.byStreet[4].foldToBet > base.byStreet[4].foldToBet + 0.02);
  assert.ok(checked.byStreet[4].raiseFreq < 0.7 * base.byStreet[4].raiseFreq);
  assert.ok(unacted.byStreet[4].raiseFreq > 1.2 * base.byStreet[4].raiseFreq);
  assert.ok(Math.abs(unacted.byStreet[4].foldToBet - base.byStreet[4].foldToBet) < 1e-9);
  // Only that street moves.
  for (const n of [3, 5]) assert.ok(Math.abs(checked.byStreet[n].foldToBet - base.byStreet[n].foldToBet) < 1e-9 && Math.abs(checked.byStreet[n].raiseFreq - base.byStreet[n].raiseFreq) < 1e-9);
  assert.ok(E.foldAtSize(checked, 0.5, 4) > E.foldAtSize(base, 0.5, 4));
  // predictAction reads the same thing from d.checked.
  const st = E.computeStats({}, 'typical');
  const d = { kind: 'face', n: 4, frac: 0.5 };
  const p0 = E.predictAction(st, d), pc = E.predictAction(st, Object.assign({ checked: true }, d)), pu = E.predictAction(st, Object.assign({ checked: false }, d));
  assert.ok(pc.fold > p0.fold && pc.raise < p0.raise && pu.raise > p0.raise && Math.abs(pu.fold - p0.fold) < 1e-12);
  // The tracker tells the predictor which of the two it was.
  const mk = () => ({ tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 200, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 200, posType: 's2', playState: 'playing' }] });
  const t = new T({ players: {} });
  const seen = [];
  t.predictor = (tally, dd) => { if (dd.kind === 'face') seen.push([dd.n, dd.checked]); return [{ fold: 0.5, call: 0.4, raise: 0.1 }, { fold: 0.5, call: 0.4, raise: 0.1 }]; };
  const snap = mk();
  // Heads-up the dealer (s1, Hero) posts the small blind and acts last after the flop.
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'call', makeBetValue: 1 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'check', makeBetValue: 0 }],
    ['game:stage_began', { stageType: 'flop' }],
    ['player:game:action_taken', { playerID: 2, actionType: 'check', makeBetValue: 0 }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 2 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 2 }],
    ['game:stage_began', { stageType: 'turn' }],
    ['player:game:action_taken', { playerID: 2, actionType: 'check', makeBetValue: 0 }],
    ['player:game:action_taken', { playerID: 1, actionType: 'check', makeBetValue: 0 }],
    ['game:stage_began', { stageType: 'river' }],
  ]) t.handle(ev, data, snap);
  assert.deepStrictEqual(seen, [[3, true]], JSON.stringify(seen));
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

test('reads: answers to 8bb+ opens and shoves are kept apart from 4bb opens (vsOpenSplit, v1.8.20, off by default)', () => {
  // A 10bb shove answered: counted in 'huge', not in 'large'.
  const t = new T({ players: {} });
  const snap = { tableType: 'private', heroAuthId: 'H', bigBlind: 2, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: 20, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 200, posType: 's2', playState: 'playing' }] };
  for (const [ev, data] of [
    ['game:stage_began', { stageType: 'set_blinds' }], ['game:dealer_updated', { dealerSeatPos: 's1' }],
    ['game:small_blind_paid', { amount: 1, playerId: 1 }], ['game:big_blind_paid', { amount: 2, playerId: 2 }],
    ['game:stage_began', { stageType: 'pre_flop' }],
    ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 19 }],
    ['player:game:action_taken', { playerID: 2, actionType: 'fold', makeBetValue: 0 }],
  ]) t.handle(ev, data, snap);
  const vo = t.db.players.V.tally.vsOpen;
  assert.strictEqual(vo.huge.fold, 1, JSON.stringify(vo));
  assert.strictEqual(vo.large.fold + vo.large.call + vo.large.raise, 0, JSON.stringify(vo));
  // A player who calls 4bb opens and folds every shove: each size gets its own read.
  const f = (n) => ({ fold: n, call: 0, raise: 0 }), c = (n) => ({ fold: 0, call: n, raise: 0 });
  const tally = Object.assign(T.blankTally(), { pfBigOpp: 20, pfBigCall: 0, vsOpen: { small: f(0), medium: f(0), large: c(20), huge: f(20) } });
  const st = E.computeStats(tally, 'typical');
  const open4 = E.predictAction(st, { kind: 'vo', toBB: 4, vsOpenSplit: true }), shove = E.predictAction(st, { kind: 'vo', toBB: 15, vsOpenSplit: true });
  assert.ok(open4.fold < 0.25, JSON.stringify(open4));
  assert.ok(shove.fold > 0.75, JSON.stringify(shove));
  // The old single bucket ('largeAll', the default) mixes the two.
  assert.ok(st.vsOpen.largeAll.cont > 0.35 && st.vsOpen.largeAll.cont < 0.65, JSON.stringify(st.vsOpen.largeAll));
  const off4 = E.predictAction(st, { kind: 'vo', toBB: 4 }), offFalse = E.predictAction(st, { kind: 'vo', toBB: 4, vsOpenSplit: false });
  assert.deepStrictEqual(off4, offFalse);
  assert.ok(off4.fold > open4.fold + 0.2, JSON.stringify(off4));
});

test('preflop: a big blind yet to act holds an untilted dealt hand (pendingTilt: false, off by default)', () => {
  // Small blind opens to 4bb heads-up; the big blind's learned answer to opens that size continues 37%.
  const tally = Object.assign(T.blankTally(), { vsOpen: { small: { fold: 0, call: 0, raise: 0 }, medium: { fold: 0, call: 0, raise: 0 }, large: { fold: 25, call: 15, raise: 0 } } });
  const spot = (extra) => E.analyzeSync(Object.assign({ hero: C('Ah 6h'), board: [], pot: 3, toCall: 1, stack: 120, bigBlind: 2, mix: false, seed: 1,
    heroPosition: 'blinds', inPosition: true, opponents: [{ name: 'V', tally, actions: { pre: 'pending' }, position: 'blinds' }], iterations: 6000 }, extra));
  const foldAt = (r) => r.scenarios.find((s) => s.kind !== 'fold' && s.amount === 7).foldPct;
  const cont = E.computeStats(tally, 'typical').vsOpen.largeAll.cont;
  const tilted = foldAt(spot()), untilted = foldAt(spot({ pendingTilt: false }));
  // With the home prior's passive tilt the dealt hand leans weak, so the Monte Carlo folded far more than the read says.
  assert.ok(Math.abs(untilted - (1 - cont)) < 0.04, `untilted ${untilted} vs read ${1 - cont}`);
  assert.ok(tilted > untilted + 0.05, `tilted ${tilted} vs untilted ${untilted}`);
  // Off by default: no input and pendingTilt true read the same.
  assert.strictEqual(foldAt(spot({ pendingTilt: true })), tilted);
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

test('reads: a raise that then calls a re-raise reads stronger than a plain raise (v1.8.10)', () => {
  assert.strictEqual(T.streetAction(['raise', 'call'], 3), 'raisecall');
  assert.strictEqual(T.streetAction(['check', 'raise', 'call'], 3), 'checkraisecall');
  assert.strictEqual(T.streetAction(['bet', 'raise'], 3), 'betraise');
  assert.strictEqual(T.streetAction(['raise', 'raise'], 3), 'reraise');
  assert.strictEqual(T.streetAction(['check', 'raise', 'raise', 'call'], 3), 'reraisecall');
  assert.strictEqual(T.streetAction(['raise'], 3), 'raise');
  assert.strictEqual(T.streetAction(['call', 'raise'], 3), 'raise');
  const board = C('8h Td 3h');
  const st = E.computeStats(T.blankTally(), 'typical');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board) };
  const mean = (W) => { let a = 0, w = 0; for (let k = 0; k < W.length; k++) if (W[k] > 0 && strengths[3].hs[k] >= 0) { a += W[k] * strengths[3].hs[k]; w += W[k]; } return a / w; };
  const raise = E.buildRange(st, { pre: 'raise', flop: 'raise' }, strengths, board);
  const raisecall = E.buildRange(st, { pre: 'raise', flop: 'raisecall' }, strengths, board);
  assert.ok(mean(raisecall) > mean(raise) + 0.02, mean(raise) + ' vs ' + mean(raisecall));
});

test('reads: a re-raise war after the flop reads stronger than one raise (v1.8.10)', () => {
  // 2 Nov: meww raised hero's flop bet on 4h 6c 7d and re-raised hero's raise; K6 (one pair) was read at 61%.
  const board = C('4h 6c 7d');
  const st = E.computeStats(T.blankTally(), 'typical');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board) };
  const mean = (W) => { let a = 0, w = 0; for (let k = 0; k < W.length; k++) if (W[k] > 0 && strengths[3].hs[k] >= 0) { a += W[k] * strengths[3].hs[k]; w += W[k]; } return a / w; };
  const raise = mean(E.buildRange(st, { pre: 'call', flop: 'raise' }, strengths, board, { flop: 0.5 }));
  const reraise = mean(E.buildRange(st, { pre: 'call', flop: 'reraise' }, strengths, board, { flop: 0.5 }));
  const betraise = mean(E.buildRange(st, { pre: 'call', flop: 'betraise' }, strengths, board, { flop: 0.5 }));
  assert.ok(reraise > raise + 0.05, raise + ' vs ' + reraise);
  assert.ok(betraise > raise + 0.05, raise + ' vs ' + betraise);
  const off = Object.assign({}, st, { reraiseLines: false });
  assert.ok(Math.abs(mean(E.buildRange(off, { pre: 'call', flop: 'reraise' }, strengths, board, { flop: 0.5 })) - raise) < 1e-9);
});

test('a player who checked and still owes the bet answers hero\'s call (v1.8.10)', () => {
  // 2 Nov: Dew666 checked, etestraight bet, hero to call with Dew666 still to answer. The call treated Dew666 as in for free.
  const tally = Object.assign(T.blankTally(), { check: 20, bet: 10, call: 10, raise: 3, fold: 15 });
  const input = {
    hero: C('Ad Js'), board: C('2s Qs 9s'), pot: 60, toCall: 20, stack: 300, bigBlind: 2, iterations: 4000, mix: false, seed: 3,
    heroBet: 0, heroCommitted: 20,
    opponents: [
      { name: 'Checker', tally, actions: { pre: 'raise', flop: 'check' }, committed: 20, stack: 280, bet: 0, heroIP: false },
      { name: 'Bettor', tally, actions: { pre: 'call', flop: 'bet' }, committed: 40, stack: 260, bet: 20, heroIP: true },
    ],
  };
  const call = (r) => r.ranked.find((s) => s.kind === 'call');
  const on = call(E.analyzeSync(input)), off = call(E.analyzeSync(Object.assign({}, input, { checkersFace: false })));
  assert.ok(on.oppFolds[0] > 0.2 * on.n, 'checker folds to the bet ' + on.oppFolds[0] / on.n);
  assert.strictEqual(off.oppFolds[0], 0);
});

test('commitment: players with most of their stack in fold less; a bet leaving 2 chips is an all-in (v1.8.10)', () => {
  // 2 Nov: KQs king-high on 8h Td 3h 6d against meww, who raised the flop and called a re-raise (163 in, 110 behind).
  const tally = Object.assign(T.blankTally(), { check: 27, bet: 16, call: 9, raise: 6, fold: 22 });
  const input = (extra) => Object.assign({
    hero: C('Qc Kc'), board: C('8h Td 3h 6d'), pot: 327, toCall: 0, stack: 110, bigBlind: 2, inPosition: false,
    opponents: [{ name: 'V', tally, actions: { pre: 'raise', flop: 'raisecall', turn: '' }, sizes: { pre: 2, flop: 0.3 }, committed: 163, stack: 110, bet: 0 }],
    heroActions: { pre: '3bet', flop: 'raise', turn: '' }, heroBet: 0, heroCommitted: 163, iterations: 6000, mix: false, seed: 1,
  }, extra || {});
  const on = E.analyzeSync(input()), off = E.analyzeSync(input({ commitFold: false }));
  const bet = (r) => r.ranked.find((s) => s.kind !== 'check');
  assert.ok(on.ranked.every((s) => s.kind === 'check' || s.kind === 'allin'), on.ranked.map((s) => s.kind + ' ' + s.amount).join(', '));
  assert.ok(bet(on).foldPct < bet(off).foldPct - 0.08, bet(on).foldPct + ' vs ' + bet(off).foldPct);
  assert.strictEqual(on.best.kind, 'check', on.ranked.map((s) => s.label + ' ' + s.amount + ' ' + Math.round(s.ev)).join(', '));
  // Multiway decisions keep the plain read unless input.commitHUOnly is false (it lost multiway in the simulator).
  const mw = (extra) => input(Object.assign({
    pot: 490, stack: 300, heroCommitted: 163,
    opponents: [
      { name: 'V', tally, actions: { pre: 'raise', flop: 'raisecall', turn: '' }, sizes: { pre: 2, flop: 0.3 }, committed: 163, stack: 110, bet: 0 },
      { name: 'W', tally, actions: { pre: 'call', flop: 'call', turn: '' }, committed: 163, stack: 300, bet: 0, heroIP: true },
    ],
  }, extra || {}));
  const mwOn = bet(E.analyzeSync(mw())), mwOff = bet(E.analyzeSync(mw({ commitFold: false }))), mwAll = bet(E.analyzeSync(mw({ commitHUOnly: false })));
  assert.strictEqual(mwOn.foldPct, mwOff.foldPct);
  assert.ok(mwAll.foldPct < mwOff.foldPct - 0.03, mwAll.foldPct + ' vs ' + mwOff.foldPct);
});

test('re-raising a flop raiser: they rarely fold, so king-high calls instead of re-raising (v1.8.10)', () => {
  // 2 Nov: hero c-bet 16 with KQs on 8h Td 3h, meww raised to 40 (23 in before the flop, 250 behind).
  const tally = Object.assign(T.blankTally(), { check: 27, bet: 16, call: 9, raise: 6, fold: 22 });
  const input = (extra) => Object.assign({
    hero: C('Qc Kc'), board: C('8h Td 3h'), pot: 103, toCall: 24, stack: 234, bigBlind: 2, inPosition: false,
    opponents: [{ name: 'V', tally, actions: { pre: 'raise', flop: 'raise' }, sizes: { pre: 2, flop: 0.3 }, committed: 63, stack: 210, bet: 40 }],
    heroActions: { pre: '3bet', flop: 'bet' }, heroBet: 16, heroCommitted: 39, iterations: 6000, mix: false, seed: 1,
  }, extra || {});
  const raise = (r) => r.ranked.find((s) => s.kind === 'raise');
  const on = E.analyzeSync(input()), old = E.analyzeSync(input({ reraiseRaiserFold: false }));
  assert.ok(raise(on).foldPct < raise(old).foldPct - 0.1, raise(on).foldPct + ' vs ' + raise(old).foldPct);
  assert.notStrictEqual(on.best.kind, 'raise', on.ranked.map((s) => s.label + ' ' + s.amount + ' ' + Math.round(s.ev)).join(', '));
});

test('preflop: a player with a quarter of the raise-to in is not faded by the big-raise cliff (v1.8.10)', () => {
  // Hero shoves 150bb over a 3-bettor who put 40bb in: they continue far more than a cold caller would.
  const tally = Object.assign(T.blankTally(), { pfFold: 20, pfCall: 15, pfRaise: 8 });
  const input = (extra) => Object.assign({
    hero: C('As 5s'), board: [], pot: 103, toCall: 60, stack: 280, bigBlind: 2, inPosition: true,
    opponents: [{ name: 'V', tally, actions: { pre: '3bet' }, committed: 80, stack: 220, bet: 80, position: 'late' }],
    heroActions: { pre: 'raise' }, heroBet: 20, heroCommitted: 20, iterations: 4000, preflopSolver: false, mix: false, seed: 1,
    pfCommitRamp: false, // a quarter of their stack in: the ramp (v1.8.18) would already move "off" halfway
  }, extra || {});
  const shove = (r) => r.ranked.find((s) => s.kind === 'allin');
  const on = E.analyzeSync(input({ pfCommit: true })), off = E.analyzeSync(input());
  assert.ok(shove(on).foldPct < shove(off).foldPct - 0.15, shove(on).foldPct + ' vs ' + shove(off).foldPct);
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

test('size reads sit at the bets actually seen: folds to min-bets do not pull down the third-pot read', () => {
  // Folded 2 of 10 min-bets (0.1 pot) and nothing else seen in the small bucket.
  const minBets = Object.assign(T.blankTally(), { vs: { small: { fold: 2, call: 8, raise: 0, fs: 1, fn: 10 }, medium: { fold: 0, call: 0, raise: 0, fs: 0, fn: 0 }, large: { fold: 0, call: 0, raise: 0, fs: 0, fn: 0 } } });
  const st = E.computeStats(minBets, 'typical');
  const at = (s, f) => E.foldAtSize(s, f, 3);
  // Read at the min-bets' size, the low fold count says little about a third-pot bet.
  const old = E.computeStats(Object.assign(T.blankTally(), { vs: { small: { fold: 2, call: 8, raise: 0 } } }), 'typical');
  assert.ok(st.sizeAnchor.small < 0.2, String(st.sizeAnchor.small));
  assert.ok(at(st, 0.33) > at(old, 0.33), `${at(st, 0.33)} vs ${at(old, 0.33)}`);
});

test('fold rates rise with bet size up to about pot, then barely (overbets buy no folds)', () => {
  const st = E.computeStats({}, 'typical');
  const f = (x) => E.foldAtSize(st, x, 5);
  // The logs: 20% folds to min-bets, 44% to a third of the pot, 67-74% to 0.55-0.9 pot, the same above.
  assert.ok(f(0.33) - f(0.1) > 0.12 && f(0.75) - f(0.33) > 0.1, `${f(0.1)} ${f(0.33)} ${f(0.75)}`);
  assert.ok(f(2) - f(1) < 0.05, `${f(1)} vs ${f(2)}`);
  assert.ok(f(2) - f(0.5) < 0.2);
});

test('bet size: a solid player\'s big bet reads polarized, a friend\'s pot-size bet keeps the medium hands', () => {
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(C('Kd 8h 2s')) };
  const avg = (style, size) => {
    const W = E.buildRange(E.computeStats({}, style), { pre: 'call', flop: 'bet' }, strengths, C('Kd 8h 2s'), { flop: size });
    let a = 0, t = 0;
    for (let k = 0; k < W.length; k++) { t += W[k]; if (strengths[3].hs[k] > 0.45 && strengths[3].hs[k] < 0.75) a += W[k]; }
    return a / t;
  };
  // Hero's own range (solid): fewer medium hands the bigger the bet.
  assert.ok(avg('solid', 1.2) < avg('solid', 0.3) - 0.05, `${avg('solid', 1.2)} vs ${avg('solid', 0.3)}`);
  // The home game (READ_PRIORS.home.bigBetMedium): the friends' pot-size bets showed medium pairs about as often
  // as their small bets, so a pot-size bet holds more medium hands than a 60% one.
  assert.ok(avg('home', 1.2) > avg('home', 0.6) + 0.02, `${avg('home', 1.2)} vs ${avg('home', 0.6)}`);
  const off = E.computeStats({}, 'home');
  off.bigBetMedium = null;
  const W = E.buildRange(off, { pre: 'call', flop: 'bet' }, strengths, C('Kd 8h 2s'), { flop: 1.2 });
  let a = 0, t = 0;
  for (let k = 0; k < W.length; k++) { t += W[k]; if (strengths[3].hs[k] > 0.45 && strengths[3].hs[k] < 0.75) a += W[k]; }
  assert.ok(a / t < avg('home', 1.2) - 0.02, `off ${a / t} vs on ${avg('home', 1.2)}`);
});

test('a turn bet after calling the flop is read stronger (READ_PRIORS.home.afterCall); off without it', () => {
  // leballs' line on 2 Nov: called a flop bet and hero's raise on Qs Kh 2s, then led 55% pot on the Td (he had J9).
  const board = C('Qs Kh 2s Td');
  const strengths = { 0: E.boardStrength([]), 3: E.boardStrength(board.slice(0, 3)), 4: E.boardStrength(board) };
  const strong = (stats, actions) => {
    const W = E.buildRange(stats, actions, strengths, board.concat(C('Kc 3h')), { turn: 0.55 });
    let a = 0, t = 0;
    for (let k = 0; k < W.length; k++) { t += W[k]; if (strengths[4].hs[k] >= 0.9) a += W[k]; }
    return a / t;
  };
  const on = E.computeStats({}, 'home'), off = E.computeStats({}, 'home');
  off.afterCall = null;
  const lead = { pre: 'call', flop: 'checkcall', turn: 'bet' };
  assert.ok(strong(on, lead) > strong(off, lead) + 0.15, `two pair or better ${strong(on, lead)} vs ${strong(off, lead)}`);
  // A bet after betting the flop, or after a checked flop, is read as before.
  for (const flop of ['bet', 'check']) near(strong(on, { pre: 'call', flop, turn: 'bet' }), strong(off, { pre: 'call', flop, turn: 'bet' }));
  // Hero's own range (solid) has no afterCall.
  assert.strictEqual(E.computeStats({}, 'solid').afterCall, null);
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

test('river solver: riverRaiseFold (off): a bettor facing a pot-size raise folds at least half its range, less to a small all-in', () => {
  const ev = (r, kind) => r.ranked.find((s) => s.kind === kind).ev;
  const on = E.analyzeSync(riverSpot('As Kc', { riverRaiseFold: true })), off = E.analyzeSync(riverSpot('As Kc'));
  // Value raises get paid less; calling is unchanged.
  assert.ok(ev(on, 'raise') < ev(off, 'raise') - 0.1 * 320, `${ev(on, 'raise')} vs ${ev(off, 'raise')}`);
  assert.ok(Math.abs(ev(on, 'call') - ev(off, 'call')) < 1e-6);
  // A second pair that raised before (K-Q on K-8-2-3-A) now calls by a clear margin.
  const kq = E.analyzeSync(riverSpot('Kh Qh', { riverRaiseFold: true }));
  assert.strictEqual(kq.best.kind, 'call');
  assert.ok(ev(kq, 'call') > ev(kq, 'raise') + 0.1 * 320);
  // An all-in for under the pot is scaled down: 300 into 320 moves little.
  const short = (o) => E.analyzeSync(riverSpot('As Kc', Object.assign({ stack: 300 }, o)));
  assert.ok(ev(short({}), 'allin') - ev(short({ riverRaiseFold: true }), 'allin') < 0.03 * 320);
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

test('river solver: a player who bet earlier and then checks folds like anyone else (aggroFold)', () => {
  // They bet the flop, then checked the turn and the river; hero has air. Players who bet an earlier
  // street and then check fold more than their read, not less, so the old fold-after-aggression scale
  // ('all') no longer applies once they checked on this street.
  const betEV = (r) => Math.max(...r.ranked.filter((s) => s.kind === 'bet').map((s) => s.ev));
  // riverMadeCall off: with it, made hands call whatever the scale, so the scale only moves the weakest hands.
  const spot = (opp, heroActions, extra) => riverSpot('6d 5d', Object.assign({ toCall: 0, pot: 200, board: C('Ks 9h 2c 7s 3h'), seed: 3, heroPotTilt: false, riverMadeCall: false,
    opponents: [Object.assign({ name: 'V', tally: {}, pfAggressor: true }, opp)], heroActions }, extra));
  const gaveUp = (extra) => spot({ actions: { pre: 'raise', flop: 'bet', turn: 'check', river: 'check' }, sizes: { flop: 0.5 } },
    { pre: 'call', flop: 'call', turn: 'check' }, Object.assign({ inPosition: true }, extra));
  const now = betEV(E.analyzeSync(gaveUp())), old = betEV(E.analyzeSync(gaveUp({ aggroFold: 'all' })));
  assert.ok(now > old + 0.01 * 200, `${now} vs ${old}`);
  // Before they act on the street (hero leads into the turn bettor) the scale still applies.
  const lead = (extra) => spot({ actions: { pre: 'raise', flop: 'check', turn: 'bet', river: '' }, sizes: { turn: 0.5 } },
    { pre: 'call', flop: 'check', turn: 'call' }, Object.assign({ inPosition: false }, extra));
  assert.strictEqual(betEV(E.analyzeSync(lead())), betEV(E.analyzeSync(lead({ aggroFold: 'all' }))));
  assert.ok(betEV(E.analyzeSync(lead({ aggroFold: 'none' }))) > betEV(E.analyzeSync(lead())));
});

test('reads: a few shown bluffs move a player\'s value share a little, many move it a lot', () => {
  const vs = (n) => E.computeStats(Object.assign(T.blankTally(), { pfFold: 60, pfCall: 45, pfRaise: 25, check: 60, bet: 36, call: 30, raise: 6, fold: 36,
    shows: Array(n).fill(0).map(() => ({ ...bluffShow })) }), 'typical').valueShare;
  const v0 = vs(0), v3 = vs(3), v30 = vs(30);
  // Each show here has two bets (turn and river); with 5 pseudo-shows three of them took it down by 0.47.
  assert.ok(v0 - v3 > 0.05 && v0 - v3 < 0.2, `${v0} ${v3}`);
  assert.ok(v0 - v30 > 0.4, `${v0} ${v30}`);
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
  const spot = riverSpot('As Kc', { riverSolver: false, toCall: 0, pot: 300, inPosition: true, iterations: 4000, heroPotTilt: false,
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
  // A solid opponent: against the home game's passive big blind the solver limps 7-2 for a sliver. Without hero's flop
  // edge (pfFlopEdge, below) 7-2 folds; with it the heads-up button opens everything.
  const aa = pfSpot('Ah As'), junk = pfSpot('7c 2d', { tableStyle: 'solid', pfFlopEdge: false });
  assert.strictEqual(aa.solver.kind, 'preflop');
  assert.notStrictEqual(aa.best.kind, 'fold');
  assert.strictEqual(junk.best.kind, 'fold');
  assert.ok(aa.ranked.every((x) => isFinite(x.ev) && x.freq >= 0 && x.freq <= 1));
  // Big blind facing a raise: aces re-raise, 7-2 folds.
  const bb = (h) => pfSpot(h, { pot: 3.5, toCall: 1.5, stack: 99, inPosition: false, pfFlopEdge: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise' } }] });
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

test('preflop solver: hero\'s flop edge (pfFlopEdge) makes marginal opens worth playing, not junk', () => {
  // The flop leaves give hero PF_FLOP_EDGE x t of the pot on top of the realized share (audit, 4 Nov: the postflop
  // solver values the flops hero sees above the old leaves). K9o first in with three players behind folds without it.
  const open = (h, extra) => pfSpot(h, Object.assign({ toCall: 1, stack: 100, inPosition: false, opponents: [1, 2, 3].map((i) => ({ name: 'P' + i, tally: {}, actions: { pre: 'pending' } })) }, extra));
  const k9 = open('Ks 9h'), k9off = open('Ks 9h', { pfFlopEdge: false });
  assert.strictEqual(k9off.best.kind, 'fold');
  assert.ok(['raise', 'allin'].includes(k9.best.kind), k9.best.kind);
  const ev = (r) => Math.max(...r.ranked.filter((x) => x.kind === 'raise').map((x) => x.ev));
  assert.ok(ev(k9) > ev(k9off) + 0.2, ev(k9) + ' vs ' + ev(k9off));
  assert.strictEqual(open('7c 2d').best.kind, 'fold');
  assert.strictEqual(open('9s 4d', { opponents: [1, 2, 3, 4, 5].map((i) => ({ name: 'P' + i, tally: {}, actions: { pre: 'pending' } })) }).best.kind, 'fold');
  // A number replaces the default; 0 and false are the old leaves.
  assert.strictEqual(ev(open('Ks 9h', { pfFlopEdge: 0 })), ev(k9off));
  assert.ok(ev(open('Ks 9h', { pfFlopEdge: 0.15 })) > ev(k9));
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

test('multiway: until someone stays, everyone folds as often as each heads-up read folds, multiplied', () => {
  // #39: a bet into two players is answered with each one's heads-up read until one of them stays,
  // so the chance that both fold is the product of their heads-up fold rates (same pot, same bet).
  // The multiway first answers' extra folds (mwBetFold, v1.8.28) are off for that; with them on, bets of
  // 45% of the pot or more get folded more than the product, and a third of the pot about as often.
  const T2 = { bet: 10, check: 20, call: 14, raise: 2, fold: 6 };
  const A = { name: 'A', tally: {}, actions: { pre: 'call', flop: '' }, committed: 6, stack: 300 };
  const B = { name: 'B', tally: T2, actions: { pre: 'raise', flop: '' }, committed: 6, stack: 300 };
  const spot = (opponents, extra) => E.analyzeSync(Object.assign({ hero: C('Ah 5h'), board: C('Kc 7d 2s'), pot: 18, toCall: 0, stack: 300, bigBlind: 2,
    inPosition: false, mix: false, seed: 7, iterations: 6000, lookahead: false, mwBetFold: false, opponents }, extra));
  const ra = spot([A]), rb = spot([B]), rab = spot([A, B]), rabOn = spot([A, B], { mwBetFold: true });
  const fold = (r, amt) => r.ranked.find((s) => s.kind === 'bet' && s.amount === amt).foldPct;
  for (const amt of [6, 14, 27]) {
    const want = fold(ra, amt) * fold(rb, amt), got = fold(rab, amt);
    assert.ok(Math.abs(got - want) < 0.02, `bet ${amt}: both fold ${got}, heads-up rates multiplied ${want}`);
  }
  assert.ok(Math.abs(fold(rabOn, 6) - fold(rab, 6)) < 0.04, `mwBetFold, bet 6: both fold ${fold(rabOn, 6)} vs ${fold(rab, 6)}`);
  for (const amt of [14, 27]) assert.ok(fold(rabOn, amt) > fold(rab, amt) + 0.08, `mwBetFold, bet ${amt}: both fold ${fold(rabOn, amt)} vs ${fold(rab, amt)}`);
});

test('mwBetFold per player (v1.8.29): no answers read as the table, folds raise the odds, calls lower them', () => {
  // A player's own first answers to hero's multiway bets (tally.mwFolds) move the table's x2 (MW_BET_FOLD); with
  // none, or with tau 0, everyone gets x2. Answers under 30% of the pot, preflop ones and answers to someone else
  // don't count.
  const st = E.computeStats({}, 'typical');
  const cfg = E.MW_BET_FOLD;
  const ans = (y, m, f) => Array.from({ length: m }, () => ({ y, f: f || 0.66, n: 3, ck: 0, ag: 0, rr: 0, k: 2 }));
  assert.strictEqual(E.mwBetOdds(st, cfg, []).odds, cfg.odds);
  assert.strictEqual(E.mwBetOdds(st, cfg, undefined).odds, cfg.odds);
  assert.strictEqual(E.mwBetOdds(st, Object.assign({}, cfg, { tau: 0 }), ans(1, 10)).odds, cfg.odds);
  assert.strictEqual(E.mwBetOdds(st, cfg, ans(1, 10, 0.25)).n, 0, 'under 30% of the pot');
  const folds = E.mwBetOdds(st, cfg, ans(1, 10)), calls = E.mwBetOdds(st, cfg, ans(0, 10));
  assert.ok(folds.odds > cfg.odds * 1.3 && folds.n === 10, 'ten folds: x' + folds.odds);
  assert.ok(calls.odds < cfg.odds / 1.3, 'ten calls: x' + calls.odds);
  // More answers move it further, and the prior keeps it within reach of the table.
  assert.ok(E.mwBetOdds(st, cfg, ans(1, 30)).odds > folds.odds);
  assert.ok(E.mwBetOdds(st, cfg, ans(1, 3)).odds < folds.odds);
  // Through the engine: one player who always folds to hero's multiway bets, one who always calls; the same tallies otherwise.
  const T2 = { bet: 10, check: 20, call: 14, raise: 2, fold: 6 };
  const A = (mw) => ({ name: 'A', tally: Object.assign({}, T2, { mwFolds: mw }), actions: { pre: 'call', flop: '' }, committed: 6, stack: 300 });
  const B = { name: 'B', tally: T2, actions: { pre: 'raise', flop: '' }, committed: 6, stack: 300 };
  const spot = (mw, extra) => E.analyzeSync(Object.assign({ hero: C('Ah 5h'), board: C('Kc 7d 2s'), pot: 18, toCall: 0, stack: 300, bigBlind: 2,
    inPosition: false, mix: false, seed: 7, iterations: 6000, lookahead: false, opponents: [A(mw), B] }, extra));
  const fold = (r) => r.ranked.find((s) => s.kind === 'bet' && s.amount === 14).foldPct;
  const r0 = spot([]), rf = spot(ans(1, 12)), rc = spot(ans(0, 12)), rflat = spot(ans(1, 12), { mwBetFold: { tau: 0 } });
  assert.ok(fold(rf) > fold(r0) + 0.02 && fold(rc) < fold(r0) - 0.02, `all-fold at 14: folder ${fold(rf)}, none ${fold(r0)}, caller ${fold(rc)}`);
  assert.strictEqual(fold(rflat), fold(r0), 'tau 0 is the flat v1.8.28 rule');
});

test('checkBetTilt per player (v1.8.29): the table tilt without shows, the shows move it', () => {
  const cfg = E.CHECK_BET_TILT;
  assert.strictEqual(E.checkBetLearned([], cfg).tilt, cfg.tilt);
  assert.strictEqual(E.checkBetLearned(undefined, cfg).tilt, cfg.tilt);
  // A show whose likelihood peaks at no tilt, and one that peaks at the top; only river bets after hero's check count.
  const show = (peak, extra) => Object.assign({ hck: true, actions: { river: 'bet' }, fit: { v: E.FIT_VERSION, tl: E.TILTS.map((x) => -4 * (x - peak) * (x - peak)) } }, extra);
  const weak = Array.from({ length: 6 }, () => show(0)), strong = Array.from({ length: 6 }, () => show(0.75));
  const w = E.checkBetLearned(weak, cfg), s = E.checkBetLearned(strong, cfg);
  assert.ok(w.tilt < cfg.tilt - 0.02 && w.n === 6, 'weak shows: ' + w.tilt);
  assert.ok(s.tilt > cfg.tilt + 0.02, 'strong shows: ' + s.tilt);
  assert.strictEqual(E.checkBetLearned(weak.map((x) => Object.assign({}, x, { hck: false })), cfg).n, 0, 'hero did not check');
  assert.strictEqual(E.checkBetLearned(weak.map((x) => Object.assign({}, x, { actions: { river: 'call' } })), cfg).n, 0, 'not a bet');
  assert.strictEqual(E.checkBetLearned(weak, Object.assign({}, cfg, { learn: false })).tilt, cfg.tilt);
});

test('tracker: tagMwFolds and tagCheckBet fill in multiway answers and river checks from stored hands, once', () => {
  const t = new T({ players: { A: { name: 'Al', tally: {} }, B: { name: 'Bo', tally: {} } } });
  const hand = (t0, betAmt, bAct) => ({
    t: t0, bigBlind: 2, board: ['Kc', '7d', '2s', '9h', '3c'],
    players: [{ name: 'Hero', hero: true, stack: 300, shown: [] }, { name: 'Al', stack: 300, shown: [] }, { name: 'Bo', stack: 300, shown: ['Kd', 'Qd'] }],
    log: [
      { st: 'pre', who: 'Hero', act: 'sb', amt: 1 }, { st: 'pre', who: 'Al', act: 'bb', amt: 2 }, { st: 'pre', who: 'Bo', act: 'call', amt: 2 },
      { st: 'pre', who: 'Hero', act: 'call', amt: 1 }, { st: 'pre', who: 'Al', act: 'check', amt: 0 },
      { st: 'flop', who: 'Hero', act: 'bet', amt: betAmt, pot: 6, hero: true }, { st: 'flop', who: 'Al', act: 'fold', amt: 0 },
      { st: 'flop', who: 'Bo', act: bAct, amt: betAmt },
      { st: 'river', who: 'Hero', act: 'check', amt: 0, hero: true }, { st: 'river', who: 'Bo', act: 'bet', amt: 10 },
    ],
  });
  // Bo's show is in his read with no hck; the second hand's flop bet is under 30% of the pot.
  t.db.players.B.tally.shows = [{ cards: ['Kd', 'Qd'], board: ['Kc', '7d', '2s', '9h', '3c'], actions: { river: 'bet' } }];
  assert.strictEqual(t.tagMwFolds([hand(2, 1, 'call'), hand(1, 4, 'call')]), 2);
  assert.deepStrictEqual(t.db.players.A.tally.mwFolds, [{ y: 1, f: 0.667, n: 3, ck: 0, ag: 0, rr: 0, k: 2 }]);
  assert.deepStrictEqual(t.db.players.B.tally.mwFolds, [{ y: 0, f: 0.667, n: 3, ck: 0, ag: 0, rr: 0, k: 2 }]);
  assert.strictEqual(t.tagCheckBet([hand(1, 4, 'call')]), 1);
  assert.strictEqual(t.db.players.B.tally.shows[0].hck, true);
  assert.strictEqual(t.tagCheckBet([hand(1, 4, 'call')]), 0, 'already there');
});

test("multiway: hero's story moves every player's folds, as heads-up", () => {
  // The credibility shift (hero's line looks strong) used to reach only o.stats; multiway bets are
  // answered with the heads-up read until someone stays (#39), so all-fold rates ignored it.
  const spot = (n, heroActions) => E.analyzeSync({ hero: C('Ah 5h'), board: C('Kc 7d 2s'), pot: 6 * (n + 1), toCall: 0, stack: 300,
    bigBlind: 2, inPosition: false, heroActions, heroPfAggressor: true, heroCommitted: 6, mix: false, seed: 7, iterations: 4000, lookahead: false,
    opponents: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, tally: {}, actions: { pre: 'call', flop: '' }, committed: 6, stack: 300 })) });
  for (const n of [1, 2]) {
    const plain = spot(n), story = spot(n, { pre: 'raise', flop: '' });
    assert.ok(story.credibility > 0.1, 'credibility ' + story.credibility);
    const bet = (r) => r.ranked.filter((s) => s.kind === 'bet').sort((a, b) => b.amount - a.amount)[0];
    assert.strictEqual(bet(plain).amount, bet(story).amount);
    const d = bet(story).foldPct - bet(plain).foldPct;
    assert.ok(d > 0.04, `${n} opponent(s): all fold ${bet(plain).foldPct} without the story, ${bet(story).foldPct} with it`);
  }
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
  // River betting at the end of the turn lines (flopRiverBet): a made flush draw gets paid. The gain
  // is small next to the solver's noise at a few iterations, so this compares 30-iteration solves.
  const rb = flop('Ah 5h', { flopSolver: true, flopRiverBet: 0.5, flopIterations: 30 });
  const draw30 = flop('Ah 5h', { flopSolver: true, flopIterations: 30 });
  const ev = (r, k) => r.ranked.find((x) => x.kind === k).ev;
  assert.ok(rb.ranked.every((x) => isFinite(x.ev)));
  assert.ok(ev(rb, 'call') > ev(draw30, 'call'));
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

test('multiway lookahead: no stabs or raises with weak hands that only win when opponents pay off too much', () => {
  // Three real 3-4 way flops (names removed) where v1.6.0 bet or raised: J-high stab into three
  // players on 7-7-3, raising middle pair weak kicker into a bet and a check-raise, raising K-high
  // into a bet and a call. Players who had called once kept calling at whole-range rates later.
  const spots = require('./fixtures/real-multiway-flops.json');
  const run = (x) => E.analyzeSync(Object.assign({}, x, { mix: false, seed: 1, iterations: 6000 }));
  const ev = (r, kind) => Math.max(...r.ranked.filter((s) => s.kind === kind).map((s) => s.ev));
  // The J-high stab: v1.6.0 had the bets above check from later streets (bet 8 was 1.72 over check
  // with 3% everyone-folds, 0.72 chips of fold equity). A stab may win on folds the logs support (the
  // fitted fold curve, per-player size reads shrunk toward it), but J-high gains little when called,
  // so no bet may beat checking by more than its immediate fold equity (plus 1.5 SE of noise).
  const stab = run(spots.stabJackHigh);
  const chk = stab.ranked.find((s) => s.kind === 'check');
  for (const b of stab.ranked.filter((s) => s.kind === 'bet' || s.kind === 'allin')) {
    const fe = b.foldPct * spots.stabJackHigh.pot;
    assert.ok(b.ev - chk.ev <= fe + 1.5 * (b.se || 0), `J-high 4-way: bet ${b.amount} EV ${b.ev} vs check ${chk.ev}, fold equity ${fe} (SE ${b.se})`);
  }
  for (const k of ['raiseMiddlePair', 'raiseKingHigh']) {
    const r = run(spots[k]);
    assert.notStrictEqual(r.best.kind, 'raise', k + ': best was raise ' + r.best.amount);
    assert.ok(ev(r, 'raise') < 0, k + ': raise EV ' + ev(r, 'raise'));
  }
  // A strong hand still wins a lot, and betting it is about as good as anything (the lookahead alone: with
  // heroPotTilt the bet is about 93% of checking here). With the multiway first answers' extra folds (mwBetFold,
  // v1.8.28: in the logs everyone folded to hero's multiway bets of 40%+ of the pot 47% of the time, read 28%)
  // the pot-and-a-half bet is everyone-folded 56% of the time instead of 35%, so checking to let them bet comes out
  // ahead (the bet about 77% of checking); top set still wins about as much.
  const qqSpot = (extra) => run(Object.assign({ hero: C('Qs Qc'), board: C('Qh 8d 3c'), pot: 24, toCall: 0, stack: 250, bigBlind: 2, inPosition: false, heroPotTilt: false,
    heroActions: { pre: 'call', flop: '' }, heroCommitted: 8,
    opponents: [0, 1].map((i) => ({ name: 'P' + i, tally: {}, actions: { pre: i ? 'call' : 'raise', flop: '' }, committed: 8, stack: 250 })) }, extra));
  const qq = qqSpot({ mwBetFold: false }), qqOn = qqSpot({});
  assert.ok(qq.ranked[0].ev > 50, 'top set EV ' + qq.ranked[0].ev);
  assert.ok(ev(qq, 'bet') >= 0.95 * qq.ranked[0].ev, 'top set bet EV ' + ev(qq, 'bet') + ' vs best ' + qq.ranked[0].ev);
  assert.ok(qqOn.ranked[0].ev > 0.95 * qq.ranked[0].ev, 'mwBetFold: top set EV ' + qqOn.ranked[0].ev + ' vs ' + qq.ranked[0].ev);
  assert.ok(ev(qqOn, 'bet') >= 0.7 * qqOn.ranked[0].ev, 'mwBetFold: top set bet EV ' + ev(qqOn, 'bet') + ' vs best ' + qqOn.ranked[0].ev);
});

test('multiway stabs from the logs: a stab alone loses, and the lookahead adds only a small edge', () => {
  // Four real spots (names removed; 2026-10-31 log hands 35, 101, 112, 125): air checked to hero in
  // a pot with two or three friends. Everyone folded to such bets only 14-35% of the time in the logs.
  // The advice bets small in all four. On its own the bet loses about 1.8 chips: its edge over
  // checking is a river bluff after a call, which the logs support (players who called a flop or turn
  // bet in a multiway pot folded to a river bet 70-80% of the time, 25 spots) and which the river
  // advice makes. Before #35 the lookahead checked all four. If a reads change makes these stabs win
  // on the spot, or the lookahead's edge grows past a small one, this fails. The limit was 1.2 chips;
  // overcall folds (v1.7.7: players still to act fold more once someone has called, logs 54% vs 47%)
  // put the flop king-high stab at 1.34 through more heads-up river bluffs, so it is 1.5 now.
  // The multiway first answers' extra folds (mwBetFold, v1.8.28) are fitted on all of hero's multiway bets in the logs
  // to 5 Nov: at 40%+ of the pot everyone folded 47% of the time (n 34), the read without it said 28%, with it 46%.
  // With it the stabs alone are about even (flop king-high -0.01, the turns -0.2 and +0.16, flop seven-high -1.0) and
  // the king-high half-pot stab comes out 0.6 over checking with the lookahead; without it the old limits still hold.
  const spots = require('./fixtures/real-multiway-stabs.json');
  for (const [name, x] of Object.entries(spots)) {
    const run = (extra) => E.analyzeSync(Object.assign({}, x, { mix: false, seed: 1, iterations: 6000 }, extra));
    const gap = (r) => Math.max(...r.ranked.filter((s) => s.kind === 'bet' || s.kind === 'allin').map((s) => s.ev)) - r.ranked.find((s) => s.kind === 'check').ev;
    for (const mwBetFold of [false, true]) {
      const now = run({ lookahead: false, mwBetFold }), later = run({ mwBetFold });
      const tag = mwBetFold ? ' (mwBetFold)' : '';
      assert.ok(gap(now) < (mwBetFold ? 0.5 : -1), `${name}${tag}: without the lookahead the best stab is ${gap(now).toFixed(2)} chips over checking`);
      assert.ok(gap(later) < 1.5, `${name}${tag}: with the lookahead the best stab is ${gap(later).toFixed(2)} chips over checking`);
      for (const s of later.ranked.filter((b) => b.kind === 'bet' && b.amount <= 0.5 * x.pot)) {
        assert.ok(s.foldPct < 0.35, `${name}${tag}: everyone folds ${s.foldPct} to ${s.amount} into ${x.pot}`);
      }
    }
  }
});

test('tracker passes chips committed and behind for side pots', () => {
  const x = replay(three).turns[1];
  assert.strictEqual(x.input.heroCommitted, 30);
  assert.deepStrictEqual(x.input.opponents.map((o) => [o.committed, o.stack]), [[30, 970], [30, 970]]);
});

// ---------------------------------------------------------------------------
// WebAssembly kernels: the same numbers as the JS loops
// ---------------------------------------------------------------------------
test('sorts: the radix and packed sorts give the stable comparator order', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pools = [[0, -0, 0.5, 0.25, 1, -1, Infinity, -Infinity, 1e-300, -1e-300, 3.5, 0.1 + 0.2, 0.3], [0, 1, 2]];
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rnd() * 1326);
    const score = new Float64Array(1326), pool = pools[trial % 2];
    for (let k = 0; k < 1326; k++) score[k] = trial % 3 === 2 ? rnd() * 2 - 1 : pool[Math.floor(rnd() * pool.length)];
    const list = [];
    for (let k = 0; k < 1326 && list.length < n; k++) if (rnd() < 0.8) list.push(k);
    const want = list.slice().sort((a, b) => score[a] - score[b]);
    assert.deepStrictEqual(Array.from(E._pf.sortByValue(list, score)), want);
    const ints = Int32Array.from(score, (x) => (isFinite(x) ? Math.floor(Math.abs(x) * 1e6) : 7) % (1 << 24));
    assert.deepStrictEqual(Array.from(E._pf.sortByScore(list, ints)), list.slice().sort((a, b) => ints[a] - ints[b]));
  }
  const nan = new Float64Array([0.5, NaN, 0.1]);
  assert.deepStrictEqual(Array.from(E._pf.sortByValue([0, 1, 2], nan)), [0, 1, 2].sort((a, b) => nan[a] - nan[b]));
});

test('kernels: river, preflop, turn and flop solves give bit-identical results with and without WebAssembly', () => {
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
    // Flop solver: facing a bet, first to act, river bets (flopRiverBet), all-ins on the flop
    // (short stack), and against the field with and without river bets.
    ...[
      { hero: C('Ah 5h'), extra: {} },
      { hero: C('Ah 5h'), extra: { flopRiverBet: 0.5 } },
      { hero: C('Qs Jd'), extra: { toCall: 0, inPosition: false, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: '' } }], heroActions: { pre: 'raise' } } },
      { hero: C('9h 9d'), extra: { stack: 25, flopRiverBet: 0.5 } },
      { hero: C('Ah 5h'), extra: { pot: 34, opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true }, { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call' } }] } },
      { hero: C('7c 7d'), extra: { pot: 30, toCall: 0, inPosition: false, flopRiverBet: 0.5,
        opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: '' }, pfAggressor: true }, { name: 'B', tally: {}, actions: { pre: 'call', flop: '' } }] } },
    ].map(({ hero, extra }) => Object.assign({ hero, board: C('Kh 8h 4c'), pot: 20, toCall: 8, stack: 100, bigBlind: 1, inPosition: true, mix: false, seed: 5,
      iterations: 2000, flopSolver: true, flopIterations: 4, heroActions: { pre: 'call' },
      opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true }] }, extra)),
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

test('preflop sizes: a 2.6x raise with one opponent left, up to a 30bb raise-to (v1.8.6)', () => {
  const raises = (r) => r.scenarios.filter((s) => s.kind === 'raise' || s.kind === 'allin').map((s) => s.amount).sort((a, b) => a - b);
  // Heads-up (small blind against the big blind, blinds 5/10): 2.5bb, 3.5bb, 5bb and the new 7.5bb.
  const hu = { hero: C('Ac Kc'), board: [], pot: 15, toCall: 5, stack: 1500, bigBlind: 10, heroBet: 5, inPosition: false, mix: false, seed: 3, iterations: 2000, preflopIterations: 60,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }] };
  const r = E.analyzeSync(hu);
  assert.deepStrictEqual(raises(r), [15, 25, 35, 55]);
  assert.ok(r.solver && r.solver.kind === 'preflop', 'the preflop solver ran with the extra size');
  assert.deepStrictEqual(raises(E.analyzeSync(Object.assign({}, hu, { pfBigRaise: false }))), [15, 25, 35]);
  if (E.kernelsActive()) {
    E.useKernels(false);
    let noK;
    try { noK = E.analyzeSync(hu); } finally { E.useKernels(true); }
    assert.strictEqual(JSON.stringify(noK.ranked), JSON.stringify(r.ranked));
  }
  // Facing a 4-bet heads-up the 2.6x size would go past 30bb, so only the usual sizes.
  const deep = Object.assign({}, hu, { pot: 360, toCall: 150, heroBet: 100, opponents: [{ name: 'V', tally: {}, actions: { pre: '4bet' }, pfAggressor: true }] });
  assert.strictEqual(raises(E.analyzeSync(deep)).length, raises(E.analyzeSync(Object.assign({}, deep, { pfBigRaise: false }))).length);
  // Multiway (two limpers and a player behind): the usual three sizes; pfRaiseHUOnly: false adds the 2.6x one.
  const spot = { hero: C('Ac Kc'), board: [], pot: 55, toCall: 10, stack: 1500, bigBlind: 10, inPosition: true, mix: false, seed: 3, iterations: 2000, preflopIterations: 60,
    opponents: [{ name: 'L1', tally: {}, actions: { pre: 'call' } }, { name: 'L2', tally: {}, actions: { pre: 'call' } }, { name: 'P', tally: {}, actions: { pre: 'pending' } }] };
  assert.deepStrictEqual(raises(E.analyzeSync(spot)), [50, 75, 115]);
  assert.deepStrictEqual(raises(E.analyzeSync(Object.assign({}, spot, { pfRaiseHUOnly: false }))), [50, 75, 115, 180]);
  // The cap (180 chips = 18bb here) and a list of sizes for the simulator.
  assert.deepStrictEqual(raises(E.analyzeSync(Object.assign({}, spot, { pfRaiseHUOnly: false, pfRaiseCapBB: 15 }))), [50, 75, 115]);
  assert.deepStrictEqual(raises(E.analyzeSync(Object.assign({}, spot, { pfRaiseFracs: [0.6, 1, 1.6, 2.6, 4], pfRaiseHUOnly: false, pfRaiseCapBB: 100 }))), [50, 75, 115, 180, 270]);
  // The big blind's option (nothing to call): opening-bet fractions of the pot.
  const opt = { hero: C('Qh Qd'), board: [], pot: 40, toCall: 0, stack: 1500, bigBlind: 10, inPosition: false, mix: false, seed: 3, iterations: 2000, preflopIterations: 60,
    opponents: [{ name: 'L1', tally: {}, actions: { pre: 'call' } }, { name: 'L2', tally: {}, actions: { pre: 'call' } }] };
  const bets = (x) => x.scenarios.filter((s) => s.kind === 'bet').map((s) => s.amount).sort((a, b) => a - b);
  assert.deepStrictEqual(bets(E.analyzeSync(opt)), [30, 40, 60]);
  assert.deepStrictEqual(bets(E.analyzeSync(Object.assign({}, opt, { pfBetFracs: [0.75, 1, 1.5, 2.5] }))), [30, 40, 60, 100]);
});

test('mwRaiseEq: no raise against a bet in a multiway pot below that showdown share (simulator option, off by default)', () => {
  const mk = (hero, board, extra) => Object.assign({ hero: C(hero), board: C(board), pot: 30, toCall: 10, stack: 300, bigBlind: 2, inPosition: false, mix: false, seed: 5, iterations: 6000,
    heroActions: { pre: 'call' }, opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true }, { name: 'B', tally: {}, actions: { pre: 'call', flop: 'pending' } }] }, extra);
  // A strong hand still raises; the gate leaves it alone.
  const kk = E.analyzeSync(mk('Kc Kd', 'Kh 8h 4c', { mwRaiseEq: 0.5 }));
  assert.strictEqual(kk.best.kind, 'raise');
  // A draw: raises go below the passive options.
  const r = E.analyzeSync(mk('Ah 5h', 'Kh 8h 4c', { mwRaiseEq: 0.5 }));
  assert.ok(r.equity.share < 0.5);
  assert.notStrictEqual(r.best.kind, 'raise');
  const firstRaise = r.ranked.findIndex((s) => s.kind === 'raise');
  assert.ok(r.ranked.slice(0, firstRaise).every((s) => s.kind === 'fold' || s.kind === 'call'));
  // A solver's raise share moves to the other actions (turn solver against the field).
  const t = E.analyzeSync(mk('Kd Qd', 'Kh 8h 4c 2s', { mwRaiseEq: 0.5, turnSolver: true, turnIterations: 6, iterations: 4000,
    opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet', turn: 'bet' }, pfAggressor: true }, { name: 'B', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'pending' } }] }));
  if (t.solver && t.equity.share < 0.5) {
    const raised = t.ranked.filter((a) => a.kind === 'raise' || (a.kind === 'allin' && a.amount > 10)).reduce((x, a) => x + a.freq, 0);
    assert.strictEqual(raised, 0);
    assert.ok(Math.abs(t.ranked.reduce((x, a) => x + a.freq, 0) - 1) < 1e-9);
  }
  // Heads-up the option does nothing.
  const hu = mk('Ah 5h', 'Kh 8h 4c', { opponents: [{ name: 'A', tally: {}, actions: { pre: 'raise', flop: 'bet' }, pfAggressor: true }] });
  assert.strictEqual(JSON.stringify(E.analyzeSync(Object.assign({}, hu, { mwRaiseEq: 0.5 })).ranked), JSON.stringify(E.analyzeSync(hu).ranked));
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

// A player who raises most bets they face (and bets a lot): re-raises of hero's bets come up often.
const RAISER_ST = { bet: 8, check: 4, call: 4, raise: 14, fold: 3 };
const RAISER = { bet: 24, check: 12, call: 12, raise: 42, fold: 9, pfCall: 20, pfRaise: 10, pfFold: 10,
  st: { flop: Object.assign({}, RAISER_ST), turn: Object.assign({}, RAISER_ST), river: Object.assign({}, RAISER_ST) } };

test('fuzz: random spots against players who re-raise a lot give legal advice (re-raise play-out)', () => {
  const r = F.rng32(14);
  const bad = [];
  let rr = 0;
  for (let k = 0; k < 120;) {
    const s = F.randomSpot(r);
    if (!s) continue;
    k++;
    for (const o of s.opponents) o.tally = RAISER;
    const res = E.analyzeSync(s);
    rr += res.ranked.reduce((a, x) => a + (x.rrN || 0), 0);
    for (const x of F.adviceProblems(s, res)) bad.push(`spot ${k} (street ${s.board.length}, ${s.opponents.length} opp): ${x}`);
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(rr > 1000, 're-raised deals played out: ' + rr);
});

test('re-raises after the flop: strong hands call them, air folds, and preflop has no play-out', () => {
  const spot = (h, extra) => E.analyzeSync(Object.assign({ hero: C(h), board: C('Ks 8d 2c'), pot: 20, toCall: 0, stack: 290, bigBlind: 2,
    inPosition: true, mix: false, seed: 3, iterations: 3000, heroActions: { pre: 'raise' }, heroPfAggressor: true,
    opponents: [{ name: 'M', tally: RAISER, actions: { pre: 'call', flop: 'check' }, committed: 10, stack: 290 }] }, extra));
  const bets = (r) => r.ranked.filter((x) => x.kind === 'bet');
  const strong = spot('Ah Kd'), air = spot('7c 3d');
  for (const x of bets(strong).concat(bets(air))) assert.ok(x.rrN > 0.15 * x.n, `bet ${x.amount}: ${x.rrN} of ${x.n} deals re-raised`);
  for (const x of bets(strong)) assert.strictEqual(x.callsReraise, true, 'top pair top kicker folds to a re-raise of ' + x.amount);
  for (const x of bets(air)) assert.strictEqual(x.callsReraise, false, '7-high calls a re-raise of ' + x.amount);
  // A bluff that folds to every re-raise loses at most its bet.
  for (const x of bets(air)) assert.ok(x.ev > -x.amount - 1e-9, `7-high bet ${x.amount}: EV ${x.ev}`);
  const off = spot('Ah Kd', { reraiseModel: false });
  assert.ok(off.ranked.every((x) => !x.rrN), 'reraiseModel: false still played re-raises out');
  const pre = E.analyzeSync({ hero: C('Ah Kd'), board: [], pot: 3, toCall: 1, stack: 298, bigBlind: 2, inPosition: true, mix: false, seed: 3,
    iterations: 2000, heroActions: {}, opponents: [{ name: 'M', tally: RAISER, actions: { pre: 'pending' }, stack: 298 }] });
  assert.ok(pre.ranked.every((x) => !x.rrN), 'preflop re-raises were played out');
});

// The computer's worker pool (offscreen.js): each worker returns its Monte Carlo tallies
// (partial), and one final analysis adds them up (merge). A tally the merge leaves out (the
// re-raise play-out's rrN/rrCall were new in #40) would change the advice on the computer only.
test('worker pool: merging one worker\'s tallies gives that worker\'s own result', () => {
  const stabs = require('./fixtures/real-multiway-stabs.json');
  const spots = {
    'flop bet into a re-raiser': flopSpot('Ah Kd', { iterations: 2000, opponents: [{ name: 'V', tally: RAISER, actions: { pre: 'call', flop: 'check' } }] }),
    'flop facing a bet': flopSpot('Qh Qd', { iterations: 2000, toCall: 60, opponents: [{ name: 'V', tally: RAISER, actions: { pre: 'raise', flop: 'bet' }, sizes: { flop: 0.6 } }] }),
    'flop without lookahead': flopSpot('9h 8h', { iterations: 2000, lookahead: false }),
    'river solver': riverSpot('As Kc'),
    'preflop solver': { hero: C('Ah Qs'), board: [], pot: 1.5, toCall: 0.5, stack: 99.5, bigBlind: 1, inPosition: true, iterations: 2000, preflopIterations: 200,
      opponents: [{ name: 'V', tally: {}, actions: { pre: 'pending' } }], heroActions: { pre: 'pending' } },
    'multiway flop from the logs': Object.assign({}, stabs.flopKingHighBoard, { iterations: 2000 }),
  };
  for (const [name, x] of Object.entries(spots)) {
    const input = Object.assign({}, x, { mix: false, seed: 7 });
    const own = E.analyzeSync(input);
    const part = E.analyzeSync(Object.assign({}, input, { partial: true }));
    const merged = E.analyzeSync(Object.assign({}, input, { merge: [part.partial], solvedMerge: [part.solved] }));
    assert.strictEqual(merged.ranked.length, own.ranked.length, name);
    for (const sc of own.ranked) {
      const m = merged.ranked.find((y) => y.kind === sc.kind && Math.abs(y.amount - sc.amount) < 1e-9);
      assert.ok(m, `${name}: ${sc.kind} ${sc.amount} is missing after the merge`);
      for (const f of ['ev', 'evRead', 'evWorst', 'se', 'n', 'foldPct', 'equityWhenCalled', 'reraisedPct', 'rrN', 'callsReraise']) {
        assert.ok(sc[f] === m[f] || Math.abs(sc[f] - m[f]) < 1e-9, `${name}: ${sc.kind} ${sc.amount} ${f} is ${sc[f]} alone, ${m[f]} merged`);
      }
    }
    assert.deepStrictEqual([merged.best.kind, merged.best.amount], [own.best.kind, own.best.amount], name);
  }
  // The spots above really exercise the re-raise play-out and both solvers.
  assert.ok(E.analyzeSync(Object.assign({}, spots['flop facing a bet'], { mix: false, seed: 7 })).ranked.some((s) => s.rrN > 0));
  assert.strictEqual(E.analyzeSync(Object.assign({}, spots['river solver'], { mix: false, seed: 7 })).solver.kind, 'river');
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

test('hand log: results come from the payout, so a bust and a rebuy is a loss (and a player who left still has one)', () => {
  const mk = (heroStack, players) => ({ tableType: 'private', heroAuthId: 'H', bigBlind: 10, players: players || [
    { id: 1, authUserId: 'H', name: 'Hero', stack: heroStack, posType: 's1', playState: 'playing' },
    { id: 2, authUserId: 'V', name: 'Vic', stack: 300, posType: 's5', playState: 'playing' },
    { id: 3, authUserId: 'W', name: 'Wes', stack: 50, posType: 's7', playState: 'playing' }] });
  const play = (ended) => {
    const t = new T({ players: {} });
    const s = mk(100);
    for (const [ev, data] of [
      ['game:stage_began', { stageType: 'set_blinds' }],
      ['game:dealer_updated', { dealerSeatPos: 's7', smallBlindSeatPos: 's1', bigBlindSeatPos: 's5', underTheGunSeatPos: 's7' }],
      ['game:small_blind_paid', { amount: 5, playerId: 1 }], ['game:big_blind_paid', { amount: 10, playerId: 2 }],
      ['game:stage_began', { stageType: 'pre_flop' }],
      ['player:game:action_taken', { playerID: 3, actionType: 'call', makeBetValue: 10 }],
      ['player:game:action_taken', { playerID: 1, actionType: 'raise', makeBetValue: 95 }],
      ['player:game:action_taken', { playerID: 2, actionType: 'call', makeBetValue: 90 }],
      ['player:game:player_play_state_changed', { newPlayState: 'folded', userId: 'W' }],
      ['player:game:action_taken', { playerID: 3, actionType: 'fold', makeBetValue: 0 }],
      ['game:stage_began', { stageType: 'flop' }], ['game:stage_began', { stageType: 'turn' }], ['game:stage_began', { stageType: 'river' }],
      ['game:stage_began', { stageType: 'showdown' }],
      ['game:game_ended', ended],
    ]) t.handle(ev, data, s);
    // Hero busted and buys back in for 200; Wes has left.
    t.handle('game:stage_began', { stageType: 'set_blinds' }, mk(200, mk(200).players.slice(0, 2)));
    return t.db.history[0];
  };
  const paid = (won) => ({ endPopupData: { gameResults: {
    winnersInfo: { V: { playerData: { authUserId: 'V', posType: 's5' }, wonAmount: won, refundUncalledBetsAmount: 0 } },
    sidePotsWithWinners: [{ isMainPot: true, potAmount: won, potRake: 0, netPotAmount: won }] } } });
  const e = play(paid(210));
  assert.deepStrictEqual(e.net, { Hero: -100, Vic: 110, Wes: -10 });
  assert.strictEqual(e.heroNet, -100);
  assert.strictEqual(e.heroNetBB, -10);
  // A payout that doesn't account for the chips in the pot (or none at all): the stacks decide.
  assert.deepStrictEqual(play(paid(150)).net, { Hero: 100, Vic: 0 });
  assert.deepStrictEqual(play({}).net, { Hero: 100, Vic: 0 });
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

// ---------------------------------------------------------------------------
// Reading the table at the edges: all-ins, players who leave, missed events
// ---------------------------------------------------------------------------
// 3-handed: Ann (s3) button, Bob (s7) small blind with `bob` chips, Hero (s1) big blind.
// Ann opens to 30, Bob calls all-in (or is all-in from the blind), Hero calls; on the flop the
// server gives Bob a turn on each betting round and checks for him (wasServerAutoAction), as it
// did for an all-in player in Marwin's log, even when there is a bet to call.
function allinHand(bob, opts) {
  opts = opts || {};
  const msgs = [];
  const add = (ev, data, snap) => msgs.push({ ev, data, snap });
  const hero0 = opts.heroStack || 1000;
  let h = hero0, a = 1000, b = bob;
  const S = () => snap3(h, a, b);
  add('game:stage_began', { stageType: 'set_blinds' }, S());
  add('game:dealer_updated', { dealerSeatPos: 's3', smallBlindSeatPos: 's7', bigBlindSeatPos: 's1', underTheGunSeatPos: 's3' }, S());
  const sb = Math.min(5, b);
  add('game:small_blind_paid', { amount: sb, playerId: 7 }, S()); b -= sb;
  add('game:big_blind_paid', { amount: 10, playerId: 1 }, S()); h -= 10;
  add('game:cards_dealt_to_player', [{ playerPos: 's1', cardData: { uniqueID: 11 } }, { playerPos: 's1', cardData: { uniqueID: 12 } }], S());
  add('game:update_card_data', { cardData: { uniqueID: 11, suite: 'spades', value: 'A' } }, S());
  add('game:update_card_data', { cardData: { uniqueID: 12, suite: 'hearts', value: 'K' } }, S());
  add('game:stage_began', { stageType: 'pre_flop' }, S());
  add('game:player_turn_started', { playerID: 3 }, S());
  add('player:game:action_taken', { playerID: 3, actionType: 'raise', makeBetValue: 30, wasServerAutoAction: false }, S()); a -= 30;
  add('game:player_turn_started', { playerID: 7 }, S());
  if (b > 0) { const x = b; add('player:game:action_taken', { playerID: 7, actionType: 'call', makeBetValue: x, wasServerAutoAction: false }, S()); b = 0; }
  else add('player:game:action_taken', { playerID: 7, actionType: 'check', makeBetValue: 0, wasServerAutoAction: true }, S());
  add('game:player_turn_started', { playerID: 1 }, S());
  const heroCall = Math.min(h, 20);
  add('player:game:action_taken', { playerID: 1, actionType: 'call', makeBetValue: heroCall, wasServerAutoAction: false }, S()); h -= heroCall;
  add('game:stage_began', { stageType: 'flop' }, S());
  add('game:cards_deal_to_stack', [
    { emitData: { stackID: 'community_stack', cardData: { suite: 'diamonds', value: 'K' } } },
    { emitData: { stackID: 'community_stack', cardData: { suite: 'clubs', value: '7' } } },
    { emitData: { stackID: 'community_stack', cardData: { suite: 'hearts', value: '2' } } },
  ], S());
  add('game:player_turn_started', { playerID: 7 }, S());
  add('player:game:action_taken', { playerID: 7, actionType: 'check', makeBetValue: 0, wasServerAutoAction: true }, S());
  add('game:player_turn_started', { playerID: 1 }, S());
  add('player:game:action_taken', { playerID: 1, actionType: 'check', makeBetValue: 0, wasServerAutoAction: !!opts.heroAllin }, S());
  add('game:player_turn_started', { playerID: 3 }, S());
  add('player:game:action_taken', { playerID: 3, actionType: 'raise', makeBetValue: 50, wasServerAutoAction: false }, S()); a -= 50;
  add('game:player_turn_started', { playerID: 7 }, S());
  add('player:game:action_taken', { playerID: 7, actionType: 'check', makeBetValue: 0, wasServerAutoAction: true }, S());
  add('game:player_turn_started', { playerID: 1 }, S()); // hero faces Ann's 50
  return msgs;
}

test('all-in player: the server\'s automatic checks are no decisions (range, reads and hand log)', () => {
  const { t, turns } = replay(allinHand(40));
  assert.strictEqual(turns.length, 3);
  const x = turns[2].input;
  assert.ok(!turns[2].error, turns[2].error);
  assert.strictEqual(x.toCall, 50);
  assert.strictEqual(x.pot, 30 + 40 + 30 + 50);
  const bob = x.opponents.find((o) => o.name === 'Bob');
  assert.strictEqual(bob.stack, 0);
  assert.strictEqual(bob.actions.flop, '', 'an automatic check narrowed the all-in player\'s range');
  const tally = t.db.players.B.tally;
  assert.strictEqual(tally.check, 0);
  assert.strictEqual(tally.st.flop.check, 0);
  assert.strictEqual(t.hand.log.filter((e) => e.who === 'Bob' && e.st === 'flop').length, 0);
  assert.ok(t.hand.log.every((e) => !(e.act === 'check' && e.facing > 0)), 'the hand log has a check facing a bet');
  // Ann's real actions still count.
  assert.strictEqual(t.db.players.A.tally.st.flop.bet, 1);
});

test('all-in player: a blind that takes the whole stack is all-in from the start', () => {
  const { t, turns } = replay(allinHand(5));
  assert.ok(t.hand.players[7].allin);
  // No preflop choice: any two cards ('pending'), not a calling range.
  assert.strictEqual(turns[2].input.opponents.find((o) => o.name === 'Bob').actions.pre, 'pending');
  assert.strictEqual(t.db.players.B.tally.st.flop.check, 0);
  assert.strictEqual(t.db.players.B.tally.check, 0);
});

test('all-in hero: no advice for the server\'s automatic turns', () => {
  // Hero has 40 chips: posts 10, calls 20 preflop... and 10 more is all-in. Use 30 so the call is all-in.
  const msgs = allinHand(1000, { heroStack: 30, heroAllin: true });
  const { t, turns } = replay(msgs);
  assert.ok(t.hand.players[1].allin);
  // Only the preflop decision asks for advice; the flop turns are the server's.
  assert.strictEqual(turns.length, 1);
  assert.match(t.solverInput('typical').error, /all-in/);
});

test('a player who leaves mid-hand is out of the hand (no fold is sent for them)', () => {
  const msgs = three.slice(0, -1);
  // The game is paused on the flop and Ann leaves the table, as a live player did in Marwin's log.
  msgs.push({ ev: 'admin:game:game_paused', data: {}, snap: snap3(970, 970, 970) });
  msgs.push({ ev: 'player:game:player_play_state_changed', data: { newPlayState: 'exiting', userId: 'A', wasKickedByUsername: false }, snap: snap3(970, 970, 970, { a: 'playing' }) });
  msgs.push({ ev: 'admin:game:game_unpaused', data: { turnTimeLeft: 20000 }, snap: snap3(970, 970, 970, { a: 'exiting' }) });
  msgs.push({ ev: 'game:player_turn_started', data: { playerID: 1 }, snap: snap3(970, 970, 970, { a: 'exiting' }) });
  const { t, turns } = replay(msgs);
  const x = turns[1];
  assert.ok(!x.error, x.error);
  assert.deepStrictEqual(x.input.opponents.map((o) => o.name), ['Bob']);
  assert.strictEqual(x.input.pot, 90, 'Ann\'s chips stay in the pot');
  assert.strictEqual(x.input.inPosition, true);
  t.handle('game:game_ended', {}, snap3(1060, 970, 970, { a: 'exiting' }));
  assert.strictEqual(t.db.history[0].players.find((p) => p.name === 'Ann').left, true);
  // A play state change for a player who already folded, or after the hand, changes nothing.
  const r2 = replay(three);
  r2.t.handle('player:game:player_play_state_changed', { newPlayState: 'away', userId: 'A' }, null);
  assert.ok(!r2.t.hand.players[3].folded);
});

test('safety net: when the chips stop matching the table, advice stops for the hand', () => {
  // Bob's flop check is lost (as after a reconnect) and so is a bet: the table shows Ann 40 lower.
  const msgs = three.slice(0, -2);
  msgs.push({ ev: 'game:player_turn_started', data: { playerID: 1 }, snap: snap3(970, 930, 970) });
  const { t, turns } = replay(msgs);
  assert.match(turns[1].error, /Lost track of the chips this hand \(Ann: 970 counted, 930 at the table\)/);
  assert.deepStrictEqual(t.hand.desync, { who: 'Ann', tracked: 970, table: 930, street: 3 });
  // The hand log keeps it, and the next hand starts clean.
  t.handle('game:game_ended', {}, snap3(970, 1050, 970));
  assert.strictEqual(t.db.history[0].desync.who, 'Ann');
  const next = replay(three, t.db);
  assert.ok(next.turns.every((y) => !y.error));
  // The recorded hands all match the table at every turn.
  for (const fx of [real, three, sd]) assert.ok(!replay(fx).t.hand.desync);
});

test('safety net: a missed fold is taken from the table, a missed board card stops advice', () => {
  // Bob's flop fold is lost; the table shows him folded at hero's turn.
  const fold = three.slice(0, -2);
  fold.push({ ev: 'game:player_turn_started', data: { playerID: 1 }, snap: snap3(970, 970, 970, { b: 'folded' }) });
  const x = replay(fold).turns[1];
  assert.ok(!x.error, x.error);
  assert.deepStrictEqual(x.input.opponents.map((o) => o.name), ['Ann']);
  // The flop's third card is lost: two cards on the flop is no board to advise on.
  const card = three.map((m) => (m.ev === 'game:cards_deal_to_stack' ? Object.assign({}, m, { data: m.data.slice(0, 2) }) : m));
  assert.strictEqual(replay(card).turns[1].error, 'Waiting for the board.');
  // The flop never starts (stage_began lost) but its cards come: last street's bets would stay.
  const stage = three.filter((m) => !(m.ev === 'game:stage_began' && m.data.stageType === 'flop'));
  assert.strictEqual(replay(stage).turns[1].error, 'Waiting for the board.');
});

// Hero opened to 3bb and faces a 3-bet to 12bb heads-up: hero's 4-bets to 26.5bb, 36.5bb and 51bb.
const fourBetSpot = (extra) => E.analyzeSync(Object.assign({
  hero: [48, 49], board: [], pot: 31, toCall: 18, stack: 294, bigBlind: 2, inPosition: true, tableStyle: 'typical',
  heroActions: { pre: 'raise' }, heroSizes: {}, heroPfAggressor: false, heroPosition: 'late', heroCommitted: 6, heroBet: 6,
  opponents: [{ name: 'V', tally: {}, actions: { pre: '3bet' }, sizes: {}, pfAggressor: true, position: 'blinds', committed: 24, stack: 276, bet: 24, heroIP: true }],
  iterations: 2000, mix: false, seed: 1,
}, extra)).scenarios.filter((s) => s.kind === 'raise').sort((a, b) => a.amount - b.amount).map((s) => s.opp[0]);

test('big preflop re-raises: friends fold to raises above 30bb (bigCliff), old size-blind floor without it', () => {
  // pfCommit off: the 3-bettor has 12bb in, a quarter of a 4-bet to 51bb, which lifts the cliff (tested below).
  const on = fourBetSpot({ pfRaisedRead: false, pfCommit: false }), off = fourBetSpot({ bigCliff: false, pfRaisedRead: false, pfCommit: false });
  assert.ok(on.length >= 3, 'three 4-bet sizes');
  near(on[0].cont, off[0].cont); // to 26.5bb: no change
  assert.ok(off[2].cont > 0.7 && Math.abs(off[2].cont - off[0].cont) < 1e-9, 'without the cliff a 51bb 4-bet is called like a 26.5bb one');
  assert.ok(on[1].cont < off[1].cont - 0.1 && on[2].cont < on[1].cont, `${on.map((o) => o.cont.toFixed(2))}`);
  assert.ok(on[2].cont >= 0.25 * off[2].cont - 1e-9, 'the fade stops at a quarter of the floor');
});

test('raisers facing a re-raise to 30bb or less answer with their foldTo3bet / fourBet reads (pfRaisedRead false: old rule)', () => {
  const on = fourBetSpot({ pfCommit: false }), off = fourBetSpot({ pfRaisedRead: false, pfCommit: false });
  assert.ok(on[0].cont > 0.8 && on[0].reraise > 0.4, `cont ${on[0].cont} reraise ${on[0].reraise}`); // home prior: fold 13%, re-raise 50%
  assert.ok(off[0].reraise < 0.2);
  near(on[1].cont, off[1].cont); near(on[2].cont, off[2].cont); // bigger re-raises keep the old rule
  // pfRaisedReadBB 45 (v1.8.17, off by default): from 30bb the read fades into the old rule by 45bb, so 36.5bb is in
  // between and 51bb keeps the old rule.
  const fade = fourBetSpot({ pfCommit: false, pfRaisedReadBB: 45 }), w = (45 - 36.5) / 15;
  near(fade[0].cont, on[0].cont);
  near(fade[1].cont, w * on[0].cont + (1 - w) * off[1].cont); near(fade[1].reraise, w * on[0].reraise + (1 - w) * off[1].reraise);
  near(fade[2].cont, off[2].cont);
});

test('pfRaisedReadBB 45: no step in the raiser\'s answer either side of a re-raise to 30bb (default 30: the step)', () => {
  // 1 Nov (#396 in the audit): AKo in the big blind against an open to 4bb and two callers. A re-raise to 29.5bb and one
  // to 30.5bb (pot one chip bigger) were answered 93% / 72% by the opener, and the biggest re-raise's EV fell 8bb.
  const spot = (pot, extra) => E.analyzeSync(Object.assign({
    hero: C('Kc As'), board: [], pot, toCall: 6, stack: 367, bigBlind: 2, inPosition: false, tableStyle: 'typical',
    heroActions: { pre: 'pending' }, heroSizes: {}, heroPosition: 'blinds', heroPfAggressor: false, heroCommitted: 2, heroBet: 2,
    opponents: [
      { name: 'R', tally: {}, actions: { pre: 'raise' }, sizes: { pre: 3, preTo: 4, preBehind: 180.5 }, pfAggressor: true, position: 'early', committed: 8, stack: 361, bet: 8, heroIP: false },
      { name: 'C1', tally: {}, actions: { pre: 'call' }, sizes: {}, position: 'late', committed: 8, stack: 280, bet: 8, heroIP: false },
      { name: 'C2', tally: {}, actions: { pre: 'call' }, sizes: {}, position: 'blinds', committed: 8, stack: 102, bet: 8, heroIP: true }],
    iterations: 1000, preflopIterations: 300, mix: false, seed: 1,
  }, extra)).scenarios.filter((s) => s.kind === 'raise').sort((a, b) => b.amount - a.amount)[0];
  const a = spot(26, { pfRaisedReadBB: 45 }), b = spot(27, { pfRaisedReadBB: 45 });
  assert.ok(a.amount + 2 <= 60 && b.amount + 2 > 60, `raise-to ${a.amount + 2} / ${b.amount + 2} chips`);
  assert.ok(Math.abs(a.opp[0].cont - b.opp[0].cont) < 0.02 && Math.abs(a.opp[0].reraise - b.opp[0].reraise) < 0.03, `${a.opp[0].cont} -> ${b.opp[0].cont}`);
  const s0 = spot(26), s1 = spot(27);
  assert.ok(s0.opp[0].cont - s1.opp[0].cont > 0.1 && s0.opp[0].reraise - s1.opp[0].reraise > 0.3, 'the old step');
});

test('shoveRange: all-in preflop re-raises read as 0.7 x VPIP, not the narrow re-raise range (false: off)', () => {
  // Hero opened to 2.5bb from late position; a loose player (VPIP about 0.6) shoves 40bb from the big blind.
  const loose = { pfFold: 40, pfCall: 40, pfRaise: 40, hands: 120 };
  const spot = (preBehind, extra, pre = '3bet', hero = 'Ah 8d') => E.analyzeSync(Object.assign({
    hero: C(hero), board: [], pot: 86, toCall: 75, stack: 75 + (preBehind ? 2 * preBehind : 0), bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'raise' }, heroSizes: { pre: 1.5, preTo: 2.5, preBehind: 37.5 }, heroPosition: 'late', heroPfAggressor: false, heroCommitted: 5, heroBet: 5,
    opponents: [{ name: 'V', tally: loose, actions: { pre }, sizes: { pre: 25, preTo: 40, preBehind }, pfAggressor: true, position: 'blinds', committed: 80, stack: 2 * preBehind, bet: 80, heroIP: false }],
    iterations: 3000, mix: false, seed: 1,
  }, extra));
  const on = spot(0), off = spot(0, { shoveRange: false });
  assert.ok(on.equity.share > off.equity.share + 0.04, `A8o vs a 40bb shove: on ${on.equity.share} off ${off.equity.share}`);
  assert.ok(spot(0, { shoveRange: 1 }).equity.share > on.equity.share + 0.01, 'a number sets the share of VPIP');
  // A near all-in (under a tenth of the raise-to behind) reads the same; a re-raise with chips behind keeps the narrow range.
  assert.ok(spot(3).equity.share > spot(3, { shoveRange: false }).equity.share + 0.03, '3bb behind a 40bb raise-to');
  near(spot(20).equity.share, spot(20, { shoveRange: false }).equity.share);
  // Opens (not re-raises) are unchanged.
  near(spot(0, {}, 'raise').equity.share, spot(0, { shoveRange: false }, 'raise').equity.share);
});

test('deepShove (on, per player): deep all-in re-raises read tighter from 40bb, fully from 100bb, depth capped by the cover', () => {
  // Hero opened to 2.5bb; a loose player (VPIP about 0.6) re-raises all-in to `to` bb. cover: the biggest stack still in
  // that could call it, in bb (sizes.preCover, from the tracker). prior 1: every player's deep shoves read tight.
  const loose = { pfFold: 40, pfCall: 40, pfRaise: 40, hands: 120 };
  const spot = (to, extra, cover, hero = 'Ah 8d', jamShows) => E.analyzeSync(Object.assign({
    hero: C(hero), board: [], pot: 2 * to + 6, toCall: 2 * to - 5, stack: 2 * to - 5, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'raise' }, heroSizes: { pre: 1.5, preTo: 2.5, preBehind: to - 2.5 }, heroPosition: 'late', heroPfAggressor: false, heroCommitted: 5, heroBet: 5,
    opponents: [{ name: 'V', tally: Object.assign({}, loose, jamShows ? { jamShows } : {}), actions: { pre: '3bet' }, sizes: Object.assign({ pre: 25, preTo: to, preBehind: 0 }, cover != null ? { preCover: cover } : {}), pfAggressor: true, position: 'blinds', committed: 2 * to, stack: 0, bet: 2 * to, heroIP: false }],
    iterations: 3000, mix: false, seed: 1,
  }, extra)).equity.share;
  const all = { deepShove: { prior: 1 } }, none = { deepShove: false };
  const off = spot(150, none), on = spot(150, all), def = spot(150);
  assert.ok(on < off - 0.08, `A8o vs a 150bb shove: on ${on} off ${off}`);
  // The default: a player with no shown deep shoves is the tight kind with chance 0.3.
  assert.ok(def < off - 0.01 && def > on + 0.03, `default ${def} between ${on} and ${off}`);
  near(spot(150, { deepShove: true }), def);
  assert.ok(spot(150, { deepShove: { prior: 1, width: 0.2 } }) > on + 0.02, 'an object replaces the numbers');
  // The ramp: nothing at 40bb, part of it at 70bb.
  near(spot(40, all), spot(40, none));
  near(spot(40), spot(40, none));
  const mid = spot(70, all), midOff = spot(70, none);
  assert.ok(mid < midOff - 0.02 && mid > spot(70, { deepShove: { prior: 1, from: 40, to: 41 } }) + 0.01, `70bb: ${midOff} -> ${mid}`);
  // A 150bb shove that only a 30bb stack can call is a 30bb shove.
  near(spot(150, all, 30), spot(150, none, 30));
});

test('deepShove learns per player: shown deep shoves of strong hands tighten the read, weak ones loosen it (prior 0.1)', () => {
  const loose = { pfFold: 40, pfCall: 40, pfRaise: 40, hands: 120 };
  const spot = (jamShows, extra) => E.analyzeSync(Object.assign({
    hero: C('Ah 8d'), board: [], pot: 306, toCall: 295, stack: 295, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'raise' }, heroSizes: { pre: 1.5, preTo: 2.5, preBehind: 147.5 }, heroPosition: 'late', heroPfAggressor: false, heroCommitted: 5, heroBet: 5,
    opponents: [{ name: 'V', tally: Object.assign({}, loose, { jamShows }), actions: { pre: '3bet' }, sizes: { pre: 25, preTo: 150, preBehind: 0 }, pfAggressor: true, position: 'blinds', committed: 300, stack: 0, bet: 300, heroIP: false }],
    iterations: 3000, mix: false, seed: 1, deepShove: { prior: 0.1 },
  }, extra));
  const trust = (r) => r.opponents[0].stats.deepShove.trust;
  near(trust(spot([], { deepShove: undefined })), 0.3);
  const strong = [{ cards: ['As', 'Ks'], pre: '3bet', to: 130, cover: 170 }, { cards: ['Jh', 'Js'], pre: '4bet', to: 500, cover: 250 }];
  const weak = [{ cards: ['2c', 'Qd'], pre: '3bet', to: 85, cover: 220 }];
  const none = spot([]), s1 = spot(strong.slice(0, 1)), s2 = spot(strong), w = spot(weak);
  assert.ok(Math.abs(trust(none) - 0.1) < 1e-9, `prior ${trust(none)}`);
  assert.ok(trust(s1) > 0.3 && trust(s2) > trust(s1) + 0.2 && trust(w) < 0.08, `${trust(s1)} ${trust(s2)} ${trust(w)}`);
  const off = spot([], { deepShove: false }).equity.share;
  assert.ok(s2.equity.share < none.equity.share - 0.04 && w.equity.share > s2.equity.share + 0.04 && Math.abs(w.equity.share - off) < 0.02,
    `${off} ${none.equity.share} ${s2.equity.share} ${w.equity.share}`);
  // Shallow shows (under `from`) say nothing.
  near(trust(spot([{ cards: ['As', 'Ks'], pre: '3bet', to: 30, cover: 200 }])), trust(none));
});

test('allinTie (on, 1bb): an all-in pick gives way to the best option that is not all-in within the margin (false: off)', () => {
  const spot = (extra, stack = 75, hero = 'Ac Kd') => E.analyzeSync(Object.assign({
    hero: C(hero), board: [], pot: 86, toCall: 75, stack, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'raise' }, heroSizes: { pre: 1.5, preTo: 2.5, preBehind: 37.5 }, heroPosition: 'late', heroPfAggressor: false, heroCommitted: 5, heroBet: 5,
    opponents: [{ name: 'V', tally: {}, actions: { pre: '3bet' }, sizes: { pre: 25, preTo: 40, preBehind: 0 }, pfAggressor: true, position: 'blinds', committed: 80, stack: 0, bet: 80, heroIP: false }],
    iterations: 3000, mix: false, seed: 1,
  }, extra));
  const base = spot({ allinTie: false });
  assert.strictEqual(base.best.kind, 'allin', 'AK calls the 40bb shove');
  assert.strictEqual(base.allinTie, null);
  // The call is far ahead of folding: the default 1bb margin keeps it.
  assert.strictEqual(spot({}).best.kind, 'allin');
  assert.strictEqual(spot({ allinTie: true }).best.kind, 'allin');
  // A margin bigger than the gap folds, and says what it gave up.
  const wide = spot({ allinTie: 1000 });
  assert.strictEqual(wide.best.kind, 'fold');
  assert.strictEqual(wide.allinTie.kind, 'allin');
  near(wide.allinTie.by, base.best.ev);
  // Hero covers the shover: the call is not hero's whole stack, but it ends the betting, so it counts as all-in too.
  const deep = spot({ allinTie: 1000 }, 400);
  assert.notStrictEqual(spot({ allinTie: false }, 400).best.kind, 'fold');
  assert.strictEqual(deep.best.kind, 'fold');
});

test('heroPotTilt: flop-passive opponents read stronger in hero\'s pots from 10bb, full tilt from 25bb (false: off)', () => {
  const spot = (pot, extra, flop) => E.analyzeSync(Object.assign({
    hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d', '4h', '2s'].map(E.parseCard), pot, toCall: 0, stack: 300, bigBlind: 2,
    inPosition: true, tableStyle: 'typical', heroActions: { pre: 'raise', flop: flop ? 'call' : 'bet', turn: 'check', river: '' }, heroSizes: {},
    heroPosition: 'late', heroPfAggressor: true, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: flop || 'call', turn: 'check', river: 'check' },
      sizes: {}, position: 'blinds', committed: pot / 2, stack: 300 - pot / 2, bet: 0, heroIP: true }],
    iterations: 4000, mix: false, seed: 1,
  }, extra)).equity.share;
  near(spot(16, { heroPotTilt: 0.3 }), spot(16, { heroPotTilt: false })); // 8bb: below the ramp
  const on = spot(60, { heroPotTilt: 0.3 }), off = spot(60, { heroPotTilt: false }), more = spot(60, { heroPotTilt: 0.5 });
  assert.ok(on < off - 0.05 && more < on - 0.02, `30bb pot: on ${on} off ${off} 0.5 ${more}`);
  near(spot(60, {}), off); // the default learns from a prior of 0: no shows from the tracker, no tilt
  // They bet the flop: no tilt (those lines are on target in the logs).
  near(spot(60, { heroPotTilt: 0.3 }, 'bet'), spot(60, { heroPotTilt: false }, 'bet'));
  // street 4: turn and river only (this river spot keeps its tilt; a flop spot loses it).
  near(spot(60, { heroPotTilt: { street: 4, tilt: 0.3, learn: false } }), on);
  const flop = (extra) => E.analyzeSync(Object.assign({ hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d'].map(E.parseCard),
    pot: 60, toCall: 0, stack: 300, bigBlind: 2, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: '' }, bet: 0 }],
    iterations: 500, mix: false, seed: 1 }, extra)).heroPot.ramp;
  assert.strictEqual(flop({}), 1);
  assert.strictEqual(flop({ heroPotTilt: { street: 4 } }), 0);
});

test('riverMadeCall: made hands call hero\'s river bets, so bluffs into a strong range lose their folds (false: off)', () => {
  // A player who check-called the flop and the turn: most of their range has a pair or better by the river.
  const spot = (hero, extra) => riverSpot(hero, Object.assign({ toCall: 0, pot: 200, seed: 5, heroPotTilt: false, inPosition: true,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'checkcall', river: 'check' }, sizes: {} }],
    heroActions: { pre: 'raise', flop: 'bet', turn: 'bet' }, riverIterations: 300 }, extra));
  const pot = (r) => r.ranked.find((s) => s.kind === 'bet' && s.amount === 200) || r.ranked.find((s) => s.kind === 'bet' || s.kind === 'allin');
  const on = E.analyzeSync(spot('Qs Js')), off = E.analyzeSync(spot('Qs Js', { riverMadeCall: false }));
  assert.ok(pot(off).foldP > pot(on).foldP + 0.1, `fold ${pot(off).foldP} -> ${pot(on).foldP}`);
  assert.ok(pot(on).ev < pot(off).ev - 0.05 * 200, `bluff EV ${pot(off).ev} -> ${pot(on).ev}`);
  // A bar no hand reaches (nothing counts as made) is the read as before.
  const strict = E.analyzeSync(spot('Qs Js', { riverMadeCall: 2 }));
  assert.ok(Math.abs(pot(strict).foldP - pot(off).foldP) < 1e-9 && Math.abs(pot(strict).ev - pot(off).ev) < 1e-9);
  // Value: the same made hands pay off, so a strong hand's bet is worth more.
  const vOn = E.analyzeSync(spot('Ah Ad')), vOff = E.analyzeSync(spot('Ah Ad', { riverMadeCall: false }));
  assert.ok(pot(vOn).ev > pot(vOff).ev, `value ${pot(vOff).ev} -> ${pot(vOn).ev}`);
  // Facing a bet (hero's raise is a raise, not a bet): the made-hand floor does not apply to the raised bettor.
  const facing = (extra) => E.analyzeSync(riverSpot('Qs Js', Object.assign({ seed: 5, heroPotTilt: false }, extra)));
  const rOn = facing().ranked.find((s) => s.kind === 'raise' || s.kind === 'allin'), rOff = facing({ riverMadeCall: false }).ranked.find((s) => s.kind === 'raise' || s.kind === 'allin');
  assert.ok(Math.abs(rOn.foldP - rOff.foldP) < 1e-9, `${rOn.foldP} ${rOff.foldP}`);
});

test('overbetTilt: river bets and raises of 3x pot or more read stronger, not other streets or sizes (false: off)', () => {
  // 4 Nov #382: sevens and fives on a paired board facing a 21x-pot river bet (the tracker caps sizes at 3).
  const spot = (size, extra, street = 5) => E.analyzeSync(Object.assign({
    hero: C('Qc 7h'), board: C(street === 5 ? 'Jh 5s 7s 3d 5h' : 'Jh 5s 7s 3d'), pot: 132, toCall: 126, stack: 420, bigBlind: 2, inPosition: false,
    tableStyle: 'typical', heroActions: { pre: 'check', flop: 'check', turn: 'check', river: street === 5 ? 'check' : '' }, heroSizes: {},
    heroPosition: 'blinds', heroPfAggressor: false, heroPotTilt: false,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'check', turn: street === 5 ? 'check' : 'bet', river: street === 5 ? 'bet' : '' },
      sizes: street === 5 ? { river: size } : { turn: size }, position: 'early', committed: 64, stack: 293, bet: 126 }],
    iterations: 4000, riverIterations: 200, mix: false, seed: 1,
  }, extra));
  const on = spot(3), off = spot(3, { overbetTilt: false });
  assert.ok(on.equity.share < off.equity.share - 0.05, `3x: on ${on.equity.share} off ${off.equity.share}`);
  assert.ok(spot(3, { overbetTilt: 0.5 }).equity.share < on.equity.share - 0.02);
  near(spot(2, {}).equity.share, spot(2, { overbetTilt: false }).equity.share); // 2x pot: no tilt
  near(spot(3, {}, 4).equity.share, spot(3, { overbetTilt: false }, 4).equity.share); // a turn overbet: no tilt
  // It doesn't stack on the hero-pot tilt: the larger of the two applies.
  near(spot(3, { heroPotTilt: 0.2 }).equity.share, on.equity.share);
  near(spot(3, { heroPotTilt: 0.5 }).equity.share, spot(3, { heroPotTilt: 0.5, overbetTilt: false }).equity.share);
});

test('riverRaiseTilt: river raises of any size read stronger, river bets do not; no stacking on the overbet tilt (false: off)', () => {
  // 31 Oct #126: AK on Tc Td 8s 2s Kd, hero bets 12 into 25 and MaPokerrk check-raises to 49 (he had KcTh).
  const spot = (riverAct, size, extra, heroRiver = 'bet') => E.analyzeSync(Object.assign({
    hero: C('Kh Ac'), board: C('Tc Td 8s 2s Kd'), pot: 74, toCall: 37, stack: 300, bigBlind: 2, inPosition: true,
    tableStyle: 'typical', heroActions: { pre: 'raise', flop: 'bet', turn: 'check', river: heroRiver }, heroSizes: {},
    heroPosition: 'late', heroPfAggressor: true, heroPotTilt: false,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'checkcall', turn: 'check', river: riverAct },
      sizes: { river: size }, position: 'blinds', committed: 61, stack: 250, bet: 49 }],
    iterations: 4000, riverIterations: 200, mix: false, seed: 1,
  }, extra));
  const on = spot('checkraise', 1.2), off = spot('checkraise', 1.2, { riverRaiseTilt: false });
  assert.ok(on.equity.share < off.equity.share - 0.03, `check-raise: on ${on.equity.share} off ${off.equity.share}`);
  assert.ok(spot('checkraise', 1.2, { riverRaiseTilt: 0.5 }).equity.share < on.equity.share - 0.01);
  near(spot('raise', 0.5).equity.share, spot('raise', 0.5, { overbetTilt: false }).equity.share); // a small raise: this tilt, not the overbet one
  assert.ok(spot('raise', 0.5).equity.share < spot('raise', 0.5, { riverRaiseTilt: false }).equity.share - 0.03);
  // A river bet (hero checked to them): no tilt.
  near(spot('bet', 1.2, {}, 'check').equity.share, spot('bet', 1.2, { riverRaiseTilt: false }, 'check').equity.share);
  // A 3x+ raise gets 0.3 from either tilt, once.
  near(spot('checkraise', 3).equity.share, spot('checkraise', 3, { riverRaiseTilt: false }).equity.share);
  near(spot('checkraise', 3).equity.share, spot('checkraise', 3, { overbetTilt: false }).equity.share);
});

test('bigRaiseRange: an open to 30bb+ that keeps chips behind reads as the top 12%, not shoves or re-raises (false: off)', () => {
  // 4 Nov #390: A9s in the big blind against a 131bb open with 124bb behind. A wide raiser (pfr ~33%).
  const wide = { pfFold: 40, pfCall: 40, pfRaise: 40, hands: 120 };
  const spot = (sizes, extra, pre = 'raise') => E.analyzeSync(Object.assign({
    hero: C('Ah 9h'), board: [], pot: 265, toCall: 260, stack: 493, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'pending' }, heroSizes: {}, heroPosition: 'blinds', heroPfAggressor: false, heroCommitted: 2, heroBet: 2,
    opponents: [{ name: 'V', tally: wide, actions: { pre }, sizes, pfAggressor: true, position: 'early', committed: 262, stack: 248, bet: 262, heroIP: true }],
    iterations: 3000, mix: false, seed: 1,
  }, extra));
  const big = { pre: 130, preTo: 131, preBehind: 124 };
  const on = spot(big), off = spot(big, { bigRaiseRange: false });
  assert.ok(on.equity.share < off.equity.share - 0.04, `on ${on.equity.share} off ${off.equity.share}`);
  assert.ok(spot(big, { bigRaiseRange: 0.05 }).equity.share < on.equity.share - 0.02, 'a number sets the width');
  // Under a quarter of the raise-to behind (a near shove), under 30bb, or no size from the tracker: the usual range.
  near(spot({ pre: 130, preTo: 131, preBehind: 20 }).equity.share, spot({ pre: 130, preTo: 131, preBehind: 20 }, { bigRaiseRange: false }).equity.share);
  near(spot({ pre: 24, preTo: 25, preBehind: 124 }).equity.share, spot({ pre: 24, preTo: 25, preBehind: 124 }, { bigRaiseRange: false }).equity.share);
  near(spot({ pre: 130 }).equity.share, off.equity.share);
  // Re-raises read narrow already: unchanged.
  near(spot(big, {}, '3bet').equity.share, spot(big, { bigRaiseRange: false }, '3bet').equity.share);
});

test('pfCommitCall: a preflop raiser or caller with a third of their stack in calls hero\'s shove (false: old rule)', () => {
  const spot = (committed, stack, extra) => E.analyzeSync(Object.assign({
    hero: C('Ah 9h'), board: [], pot: committed + 3, toCall: committed - 2, stack: 493, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'pending' }, heroSizes: {}, heroPosition: 'blinds', heroPfAggressor: false, heroCommitted: 2, heroBet: 2,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise' }, sizes: { pre: committed / 2 - 1 }, pfAggressor: true, position: 'early', committed, stack, bet: committed, heroIP: true }],
    iterations: 1000, mix: false, seed: 1, bigRaiseRange: false,
  }, extra)).scenarios.filter((s) => s.kind === 'allin' || s.kind === 'raise').sort((a, b) => b.amount - a.amount)[0].opp[0].cont;
  assert.ok(spot(262, 248) >= 0.95, 'half the stack in: calls');
  assert.ok(spot(262, 248, { pfCommitCall: false }) < 0.9, 'old rule folds some');
  assert.ok(spot(60, 450) < 0.9, 'an eighth of the stack in: the usual rule (its biggest raise)');
  // Callers too (v1.8.16): 1 Nov, Jagger called a 32bb open with 92bb.
  const caller = (committed, stack, extra) => E.analyzeSync(Object.assign({
    hero: C('As Jd'), board: [], pot: 131, toCall: 62, stack: 502, bigBlind: 2, inPosition: false, tableStyle: 'typical',
    heroActions: { pre: 'pending' }, heroSizes: {}, heroPosition: 'blinds', heroPfAggressor: false, heroCommitted: 2, heroBet: 2,
    opponents: [
      { name: 'R', tally: {}, actions: { pre: 'raise' }, sizes: { pre: 31 }, pfAggressor: true, position: 'late', committed: 64, stack: 998, bet: 64, heroIP: true },
      { name: 'K', tally: {}, actions: { pre: 'call' }, sizes: {}, position: 'late', committed, stack, bet: committed, heroIP: true }],
    iterations: 1000, mix: false, seed: 1, bigRaiseRange: false,
  }, extra)).scenarios.filter((s) => s.kind === 'allin' || s.kind === 'raise').sort((a, b) => b.amount - a.amount)[0].opp[1].cont;
  assert.ok(caller(64, 120) >= 0.95, 'a caller with a third of the stack in calls');
  assert.ok(caller(64, 120, { pfCommitCall: false }) < 0.9);
  assert.ok(caller(64, 900) < 0.9, 'a deep caller: the usual rule');
});

test('pfCommitRamp: between a fifth and a third of the stack in, the call rate ramps up to the committed one (false: the old step)', () => {
  const spot = (committed, stack, extra) => E.analyzeSync(Object.assign({
    hero: C('Ah 9h'), board: [], pot: committed + 3, toCall: committed - 2, stack: 493, bigBlind: 2, inPosition: true, tableStyle: 'typical',
    heroActions: { pre: 'pending' }, heroSizes: {}, heroPosition: 'blinds', heroPfAggressor: false, heroCommitted: 2, heroBet: 2,
    opponents: [{ name: 'V', tally: {}, actions: { pre: 'raise' }, sizes: { pre: committed / 2 - 1 }, pfAggressor: true, position: 'early', committed, stack, bet: committed, heroIP: true }],
    iterations: 1000, mix: false, seed: 1, bigRaiseRange: false,
  }, extra)).scenarios.filter((s) => s.kind === 'allin' || s.kind === 'raise').sort((a, b) => b.amount - a.amount)[0].opp[0].cont;
  // A quarter in: above the old rule, below a committed player's call.
  const q = spot(120, 360), qOld = spot(120, 360, { pfCommitRamp: false });
  assert.ok(q > qOld + 0.1 && q < 0.95, `quarter ${q} old ${qOld}`);
  // Just under a third: nearly the committed rate, where the old rule jumped from qOld-like to 0.97.
  const t = spot(120, 250), tOld = spot(120, 250, { pfCommitRamp: false });
  assert.ok(t > 0.9 && t < 0.97 && tOld < 0.9, `third ${t} old ${tOld}`);
  // Under a fifth, or a third and more: as before.
  near(spot(60, 450), spot(60, 450, { pfCommitRamp: false }));
  near(spot(262, 248), spot(262, 248, { pfCommitRamp: false }));
});

test('heroPotTilt: learned from the table\'s shows in hero\'s pots, on top of the tilt that fits the rest', () => {
  const run = (hps) => E.analyzeSync({
    hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d', '4h', '2s'].map(E.parseCard), pot: 60, toCall: 0, stack: 300, bigBlind: 2,
    inPosition: true, tableStyle: 'typical', heroActions: { pre: 'raise', flop: 'bet', turn: 'check', river: '' }, heroSizes: {},
    heroPosition: 'late', heroPfAggressor: true, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'call', turn: 'check', river: 'check' },
      sizes: {}, position: 'blinds', committed: 30, stack: 270, bet: 0, heroIP: true }],
    iterations: 2000, mix: false, seed: 1, heroPotShows: hps,
  });
  // n shows whose log-likelihood peaks at tilt `peak` (about the curvature of the logs' shows).
  const curve = (n, peak) => E.TILTS.map((t) => -2.5 * n * (t - peak) * (t - peak));
  const tilt = (hps) => run(hps).heroPot.tilt;
  assert.strictEqual(run(undefined).heroPot.tilt, 0); // no shows from the tracker: the prior (0)
  assert.strictEqual(tilt({ hi: null, hiN: 0, ho: curve(30, 0), hoN: 30 }), 0);
  const calibrated = tilt({ hi: curve(60, 0), hiN: 60, ho: curve(60, 0), hoN: 60 });
  assert.ok(calibrated < 0.06, `calibrated table ${calibrated}`); // the bots: learns about 0
  const trap = tilt({ hi: curve(60, 0.3), hiN: 60, ho: curve(60, 0), hoN: 60 });
  assert.ok(trap > 0.25 && trap <= 0.3, `trapping table ${trap}`); // learned from 0, held back a little by the prior
  // Ranges off everywhere by the same amount: not a hero-pot effect.
  const offAll = tilt({ hi: curve(60, -0.15), hiN: 60, ho: curve(60, -0.15), hoN: 60 });
  assert.ok(Math.abs(offAll) < 0.06, `off everywhere ${offAll}`);
  // Weaker in hero's pots than elsewhere: held at 0 by default (min), learned below 0 only with a lower min.
  const weaker = { hi: curve(60, -0.2), hiN: 60, ho: curve(60, 0), hoN: 60 };
  assert.strictEqual(tilt(weaker), 0);
  const below = E.analyzeSync({ hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d', '4h'].map(E.parseCard), pot: 60,
    toCall: 0, stack: 300, bigBlind: 2, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: 'call', turn: '' }, bet: 0 }], iterations: 500, mix: false,
    seed: 1, heroPotTilt: { min: -0.3 }, heroPotShows: weaker }).heroPot.tilt;
  assert.ok(below < -0.1, `below 0 with min -0.3: ${below}`);
  const few = tilt({ hi: curve(4, 0.3), hiN: 4, ho: curve(60, 0), hoN: 60 });
  assert.ok(few >= 0.06 && few < 0.2, `four shows ${few}`); // a few shows move it part of the way
  // The prior is an option: a prior of 0.3 with shows that fit no tilt in hero's pots moves only part of the way down.
  assert.ok(E.analyzeSync({ hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d'].map(E.parseCard), pot: 60, toCall: 0, stack: 300,
    bigBlind: 2, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: '' }, bet: 0 }], iterations: 500, mix: false, seed: 1,
    heroPotTilt: { tilt: 0.3 }, heroPotShows: { hi: curve(4, 0), hiN: 4, ho: curve(60, 0), hoN: 60 } }).heroPot.tilt >= 0.12);
  assert.strictEqual(E.analyzeSync(Object.assign({}, { hero: [E.parseCard('Ah'), E.parseCard('Jd')], board: ['Ks', 'Jc', '7d'].map(E.parseCard), pot: 60, toCall: 0,
    stack: 300, bigBlind: 2, inPosition: true, opponents: [{ name: 'V', tally: {}, actions: { pre: 'call', flop: '' }, bet: 0 }], iterations: 500, mix: false, seed: 1,
    heroPotTilt: 0.2, heroPotShows: { hi: curve(60, 0), hiN: 60, ho: curve(60, 0), hoN: 60 } })).heroPot.tilt, 0.2); // a number: fixed
});

// ---------------------------------------------------------------------------
// Linked reads: a friend on a new account id (Jagger, 2 Nov) or a new name
// ---------------------------------------------------------------------------
// The heads-up showdown hand with Vic's account id and name swapped.
const asPlayer = (msgs, id, name) => JSON.parse(JSON.stringify(msgs).replace(/"authUserId":"V"/g, `"authUserId":"${id}"`).replace(/"name":"Vic"/g, `"name":"${name}"`));
const feedAll = (t, msgs) => { for (const m of msgs) { if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); } };
const handsOf = (tally) => (tally.pfFold || 0) + (tally.pfCall || 0) + (tally.pfRaise || 0);
const sdHand = require(path.join(__dirname, 'fixtures/synth-showdown.json'));
const threeHand = require(path.join(__dirname, 'fixtures/three-hand-150bb.json'));

test('linked reads: same name on a new account id is suggested, and joined only when hero says so', () => {
  const t = new T({ players: {} });
  const asks = [];
  t.on((type, p) => { if (type === 'linkAsk') asks.push(JSON.parse(JSON.stringify(p))); });
  for (let i = 0; i < 3; i++) feedAll(t, asPlayer(sdHand, 'J1', 'Jagger'));
  assert.strictEqual(asks.length, 0);
  let input = null;
  t.on((type, p) => { if (type === 'turn' && p.isHero && !input) input = t.solverInput('typical').input; });
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.strictEqual(asks.length, 1, 'one question');
  assert.deepStrictEqual(Object.keys(asks[0]), ['J2']);
  assert.strictEqual(asks[0].J2.matches[0].id, 'J1');
  near(asks[0].J2.matches[0].hands, handsOf(t.db.players.J1.tally));
  // Nothing joined before the answer: the new id reads as a new player.
  assert.strictEqual(t.canon('J2'), 'J2');
  near(handsOf(input.opponents[0].tally), 0);
  near(handsOf(t.readTally('J2')), 1);
  // "Same player": the read is both ids added up; each id keeps its own counts.
  const old = handsOf(t.db.players.J1.tally);
  assert.ok(t.link('J2', 'J1').ok);
  assert.strictEqual(t.canon('J2'), 'J1');
  assert.deepStrictEqual(t.linkAsks, {});
  near(handsOf(t.db.players.J2.tally), 1);
  near(handsOf(t.readTally('J2')), old + 1);
  assert.strictEqual(t.readTally('J1').shows.length, 4);
  input = null;
  const before = t.db.players.J1.tally.bet;
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.strictEqual(asks.length, 1, 'not asked again once linked');
  near(handsOf(input.opponents[0].tally), (old + 1) * T.DECAY);
  // Both ids' counts decay while the player plays on (once each per hand).
  near(t.db.players.J1.tally.bet, before * T.DECAY);
  assert.strictEqual(t.db.history[t.db.history.length - 1].players.find((x) => !x.hero).accounts, 2);
});

test('linked reads: a player not linked reads exactly as before (the same tally object)', () => {
  const t = new T({ players: {} });
  feedAll(t, sdHand);
  assert.strictEqual(t.readTally('V'), t.db.players.V.tally);
  assert.deepStrictEqual(t.groupOf('V'), ['V']);
});

test('linked reads: "different players" is not asked again', () => {
  const t = new T({ players: {} });
  feedAll(t, asPlayer(sdHand, 'J1', 'Jagger'));
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.ok(t.linkAsks.J2);
  t.refuseLink('J2', 'J1');
  assert.ok(!t.linkAsks.J2);
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.ok(!t.linkAsks.J2, 'not suggested again');
  assert.strictEqual(t.canon('J2'), 'J2');
  // Linking by hand still works and overrides the answer.
  assert.ok(t.link('J2', 'J1').ok);
  assert.strictEqual(t.canon('J2'), 'J1');
});

test('linked reads: two ids that played the same hand never link or get suggested', () => {
  const t = new T({ players: {} });
  feedAll(t, threeHand); // Ann (A) and Bob (B) at one table
  const r = t.link('A', 'B');
  assert.ok(!r.ok && /same hand/.test(r.error), r.error);
  assert.strictEqual(t.canon('B'), 'B');
  // Two older reads called Bob who played together: a new Bob gets both offered, and only one can join.
  const t2 = new T({ players: {} });
  feedAll(t2, JSON.parse(JSON.stringify(threeHand).replace(/"name":"Ann"/g, '"name":"Bob"')));
  feedAll(t2, asPlayer(sdHand, 'B9', 'Bob'));
  assert.deepStrictEqual(t2.linkAsks.B9.matches.map((m) => m.id).sort(), ['A', 'B']);
  assert.ok(t2.link('B9', 'A').ok);
  assert.ok(!t2.link('B9', 'B').ok, 'B played with A');
  // A Bob sitting with an older Bob is not that Bob.
  const t3 = new T({ players: {} });
  feedAll(t3, asPlayer(sdHand, 'V1', 'Bob'));
  feedAll(t3, JSON.parse(JSON.stringify(threeHand).replace(/"authUserId":"A"/g, '"authUserId":"V1"').replace(/"name":"Ann"/g, '"name":"Bob"')));
  assert.ok(!(t3.linkAsks && t3.linkAsks.B), 'B sat with V1 (named Bob): no question');
});

test('linked reads: unlinking splits them back with their own counts', () => {
  const t = new T({ players: {} });
  feedAll(t, asPlayer(sdHand, 'J1', 'Jagger'));
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.ok(t.link('J2', 'J1').ok);
  assert.ok(t.unlink('J2'));
  assert.deepStrictEqual(t.groupOf('J2'), ['J2']);
  near(handsOf(t.readTally('J2')), 1);
  feedAll(t, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.ok(!(t.linkAsks && t.linkAsks.J2), 'not suggested again after unlinking');
  assert.ok(t.link('J2', 'J1').ok, 'by hand again');
  // A new name and a new id, linked by hand; unlinking the root keeps the rest together.
  feedAll(t, asPlayer(sdHand, 'J3', 'Jag'));
  assert.ok(!(t.linkAsks && t.linkAsks.J3), 'another name: no suggestion');
  assert.ok(t.link('J3', 'J2').ok);
  assert.deepStrictEqual(t.groupOf('J3').sort(), ['J1', 'J2', 'J3']);
  t.unlink('J1');
  assert.deepStrictEqual(t.groupOf('J3').sort(), ['J2', 'J3']);
  assert.deepStrictEqual(t.groupOf('J1'), ['J1']);
  assert.strictEqual(t.readGroups().length, 2);
});

test('linked reads: a name change keeps the read; old names count; generic names and hero never match', () => {
  const t = new T({ players: {} });
  feedAll(t, asPlayer(sdHand, 'P1', 'phuketdemon'));
  feedAll(t, asPlayer(sdHand, 'P1', 'Jagger')); // a name change on the same id: same read, no question
  assert.ok(!(t.linkAsks && t.linkAsks.P1));
  near(handsOf(t.readTally('P1')), 1 * T.DECAY + 1);
  assert.deepStrictEqual(t.namesOf('P1'), ['Jagger', 'phuketdemon']);
  feedAll(t, asPlayer(sdHand, 'P2', 'phuketdemon'));
  assert.strictEqual(t.linkAsks.P2.matches[0].id, 'P1', 'a new id under the old name');
  const g = new T({ players: {} });
  feedAll(g, asPlayer(sdHand, 'G1', 'Guest 12'));
  feedAll(g, asPlayer(sdHand, 'G2', 'guest 12'));
  assert.ok(!(g.linkAsks && g.linkAsks.G2));
  const h = new T({ players: {} });
  feedAll(h, asPlayer(sdHand, 'V1', 'Hero'));
  assert.ok(!(h.linkAsks && h.linkAsks.V1));
  assert.ok(!h.link('V1', 'H').ok);
  // linkReads false: no seat notes, no questions.
  const off = new T({ players: {} });
  off.linkReads = false;
  feedAll(off, asPlayer(sdHand, 'J1', 'Jagger'));
  feedAll(off, asPlayer(sdHand, 'J2', 'Jagger'));
  assert.ok(!off.linkAsks && !off.db.seen);
});

test('linked reads: seats learned from stored hands', () => {
  const t = new T({ players: {} });
  feedAll(t, threeHand);
  t.finishHand();
  const hist = JSON.parse(JSON.stringify(t.db.history));
  const fresh = new T({ players: JSON.parse(JSON.stringify(t.db.players)) });
  fresh.learnSeats(hist);
  assert.ok(fresh.db.seen.A.met.B && fresh.db.seen.B.met.A && !fresh.db.seen.H, JSON.stringify(fresh.db.seen));
  assert.ok(!fresh.link('A', 'B').ok);
});

test('linked reads: merged tallies add every count and keep the newest shows', () => {
  const a = T.blankTally(), b = T.blankTally();
  a.bet = 2; a.st.flop.bet = 1; a.vs.small.fs = 0.5; a.pred.n = 3; a.shows = [{ n: 1 }, { n: 2 }];
  b.bet = 1.5; b.st.flop.bet = 2; b.tt.call.n = 4; b.shows = Array.from({ length: 80 }, (_, i) => ({ n: 10 + i }));
  const m = T.mergeTallies([a, b]);
  near(m.bet, 3.5); near(m.st.flop.bet, 3); near(m.vs.small.fs, 0.5); near(m.pred.n, 3); near(m.tt.call.n, 4);
  assert.strictEqual(m.shows.length, 80);
  assert.strictEqual(m.shows[0].n, 10);
  assert.strictEqual(a.bet, 2, 'inputs unchanged');
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
