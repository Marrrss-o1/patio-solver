// Blueprint lookup tests: the JS side must rebuild the trainer's trees and buckets exactly, follow
// real hands down the tree (seats, bet-size translation), and feed the engine.
// Run: node test/blueprint.test.js (part of npm test)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');
const BP = require('../src/blueprint.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
}

// The configs in blueprint/run.sh, with the tree hashes `blueprint/train --tree` prints.
const CONFIGS = {
  3: { players: 3, stack: 1500, sb: 5, bb: 10, allinFrac: 0.6, nb: [169, 128, 96, 64], sizes: '0.75,1.25/1/0.6/|0.33,0.75/0.8/|0.6/0.8/|0.5,1/0.8/', nodes: 120738, hash: 0x1df87857 },
  4: { players: 4, stack: 1500, sb: 5, bb: 10, allinFrac: 0.6, nb: [169, 64, 64, 48], sizes: '1/1/0.6/|0.5/0.8/|0.5/0.8/|0.5/0.8/', nodes: 387064, hash: 0x974c6b86 },
  5: { players: 5, stack: 1500, sb: 5, bb: 10, allinFrac: 0.6, nb: [169, 48, 32, 32], sizes: '1/1/0.6/|0.5/|0.5/|0.5/', nodes: 1491356, hash: 0x8b9f7d4d },
  2: { players: 2, stack: 1000, sb: 5, bb: 10, allinFrac: 0.6, nb: [169, 192, 192, 160], sizes: '0.5,0.75,1.25/0.8,1.3/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/', nodes: 35148, hash: 0xf96cbf70 },
};

for (const n of [2, 3, 4, 5]) {
  test(`tree: ${n} players, same betting tree as the trainer`, () => {
    const t = BP.buildTree(CONFIGS[n]);
    assert.strictEqual(t.nodes.length, CONFIGS[n].nodes);
    assert.strictEqual(t.hash, CONFIGS[n].hash);
  });
}

test('tree: a cut tree (exported streets only) keeps the same strategy offsets', () => {
  const cfg = Object.assign({}, CONFIGS[4], { exportStreets: 2 });
  const full = BP.buildTree(cfg), cut = BP.buildTree(cfg, { cut: true });
  assert.ok(cut.cut && cut.nodes.length < full.nodes.length / 3);
  assert.strictEqual(cut.xtotal, full.xtotal);
  const sig = (t) => t.nodes.filter((n) => n.off >= 0).map((n) => [n.player, n.street, n.nacts, n.off, n.add.join(',')].join(':'));
  assert.deepStrictEqual(sig(cut), sig(full));
});

test('tree: 3-handed root is the button with fold, limp, two opens and all-in', () => {
  const root = BP.buildTree(CONFIGS[3]).nodes[0];
  assert.strictEqual(root.player, 0);
  assert.deepStrictEqual(root.kind, ['f', 'c', 'r', 'r', 'a']);
  assert.deepStrictEqual(root.add, [0, 10, 29, 41, 1500]);
});

const read = (f) => { const b = fs.readFileSync(f); return /\.gz$/.test(f) ? zlib.gunzipSync(b) : b; };
const file3 = path.join(__dirname, '../extension/blueprint-3max.bin.gz');
const bp = fs.existsSync(file3) ? BP.load(read(file3)) : null;
if (!bp) console.log('skip blueprint file tests: extension/blueprint-3max.bin.gz not found');

const fixture = path.join(__dirname, 'fixtures/blueprint-buckets.txt');
if (bp) {
  test('buckets: JS matches the trainer on every street (200 random hands)', () => {
    const lines = fs.readFileSync(fixture, 'utf8').trim().split('\n');
    let bad = 0;
    for (const L of lines) {
      const v = L.split(' ').map(Number);
      const k = BP.COMBO_INDEX[v[0] * 52 + v[1]], board = v.slice(2, 7);
      for (let s = 0; s < 4; s++) if (bp.bucket(s, board, k) !== v[7 + s]) bad++;
    }
    assert.strictEqual(bad, 0);
  });
}

// Synthetic 3-handed hand (as in replay.test.js): s1 Hero, s3 Ann (button), s7 Bob.
// Button s3 -> SB s7 -> BB s1 (Hero). Ann opens to 3bb, Bob calls, hero in the BB.
function snap3(h, a, b) {
  return { tableType: 'private', heroAuthId: 'H', bigBlind: 10, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: h, posType: 's1', playState: 'playing' },
    { id: 3, authUserId: 'A', name: 'Ann', stack: a, posType: 's3', playState: 'playing' },
    { id: 7, authUserId: 'B', name: 'Bob', stack: b, posType: 's7', playState: 'playing' }] };
}
function threeHanded(stack) {
  const m = [], push = (ev, data, snap) => m.push({ ev, data, snap });
  const S = stack || 1500;
  let s = snap3(S, S, S);
  push('game:stage_began', { stageType: 'set_blinds' }, s);
  push('game:dealer_updated', { dealerSeatPos: 's3' }, s);
  push('game:small_blind_paid', { amount: 5, playerId: 7 }, s);
  push('game:big_blind_paid', { amount: 10, playerId: 1 }, s);
  push('game:cards_dealt_to_player', [{ playerPos: 's1', cardData: { uniqueID: 11 } }, { playerPos: 's1', cardData: { uniqueID: 12 } }], s);
  push('game:update_card_data', { cardData: { uniqueID: 11, suite: 'spades', value: 'A' } }, s);
  push('game:update_card_data', { cardData: { uniqueID: 12, suite: 'hearts', value: 'K' } }, s);
  push('game:stage_began', { stageType: 'pre_flop' }, s);
  push('player:game:action_taken', { playerID: 3, actionType: 'raise', makeBetValue: 30 }, s);
  push('player:game:action_taken', { playerID: 7, actionType: 'call', makeBetValue: 25 }, snap3(S - 10, S, S - 5));
  push('game:player_turn_started', { playerID: 1 }, snap3(S - 10, S - 30, S - 30));
  return m;
}
function replay(msgs) {
  const t = new T({ players: {} });
  const turns = [];
  t.on((type, p) => { if (type === 'turn' && p.isHero) turns.push(t.solverInput('typical')); });
  for (const m of msgs) t.handle(m.ev, m.data, m.snap);
  return turns;
}

test('tracker: solver input carries the history, seats, hero name and starting stack', () => {
  const x = replay(threeHanded())[0].input;
  assert.deepStrictEqual(x.history.map((e) => e.act), ['sb', 'bb', 'raise', 'call']);
  assert.deepStrictEqual(x.seats, ['Bob', 'Hero', 'Ann']);
  assert.strictEqual(x.heroName, 'Hero');
  assert.strictEqual(x.startStack, 1500);
});

if (bp) {
  test('advise: 3-handed big blind facing an open and a call', () => {
    const x = replay(threeHanded())[0].input;
    const adv = bp.advise(x);
    assert.ok(!adv.error, adv.error);
    assert.strictEqual(adv.heroSeat, 2);
    const tot = adv.actions.reduce((a, q) => a + q.p, 0);
    assert.ok(Math.abs(tot - 1) < 1e-9, String(tot));
    assert.deepStrictEqual(adv.actions.map((a) => a.kind).slice(0, 2), ['fold', 'call']);
    assert.strictEqual(adv.actions[1].add, 20);
  });

  test('locate: an off-size open maps to the nearer size (pseudo-harmonic)', () => {
    const seats = ['Bob', 'Hero', 'Ann'];
    const h = [
      { st: 'pre', who: 'Bob', act: 'sb', amt: 5 }, { st: 'pre', who: 'Hero', hero: true, act: 'bb', amt: 10 },
      { st: 'pre', who: 'Ann', act: 'raise', amt: 45 }, // 4.5bb: between the 2.9bb and 4.1bb opens -> 4.1bb
    ];
    const loc = bp.locate(h, seats, 'Bob');
    assert.ok(!loc.error, loc.error);
    assert.strictEqual(bp.tree.nodes[0].add[loc.path[0].action], 41);
    assert.strictEqual(loc.node.player, 1); // the small blind acts next
  });

  test('locate: a big raise that is not all-in stays a raise', () => {
    const seats = ['Bob', 'Hero', 'Ann'];
    const h = [
      { st: 'pre', who: 'Bob', act: 'sb', amt: 5 }, { st: 'pre', who: 'Hero', hero: true, act: 'bb', amt: 10 },
      { st: 'pre', who: 'Ann', act: 'raise', amt: 300 },
    ];
    const loc = bp.locate(h, seats, 'Bob');
    assert.ok(!loc.error, loc.error);
    assert.strictEqual(bp.tree.nodes[0].kind[loc.path[0].action], 'r');
  });

  test('engine: by default the blueprint is reported and the advice is unchanged', () => {
    const x = replay(threeHanded())[0].input;
    const r = E.analyzeSync(Object.assign({}, x, { blueprintObj: bp, iterations: 3000, seed: 7 }));
    const plain = E.analyzeSync(Object.assign({}, x, { iterations: 3000, seed: 7 }));
    assert.ok(r.blueprint && !r.blueprint.used && r.blueprint.actions.length >= 2, JSON.stringify(r.blueprint));
    assert.deepStrictEqual(r.ranked.map((q) => [q.kind, q.amount, q.ev]), plain.ranked.map((q) => [q.kind, q.amount, q.ev]));
    assert.strictEqual(r.best.kind, plain.best.kind);
  });

  test('engine: blueprint: true blends the advice toward the blueprint', () => {
    const x = replay(threeHanded())[0].input;
    const r = E.analyzeSync(Object.assign({}, x, { blueprintObj: bp, blueprint: true, iterations: 3000, seed: 7 }));
    assert.ok(r.blueprint && r.blueprint.used, r.blueprint && r.blueprint.why);
    const tot = r.ranked.reduce((a, q) => a + (q.freq || 0), 0);
    assert.ok(Math.abs(tot - 1) < 1e-6, String(tot));
    assert.ok(r.ranked.includes(r.best));
    const off = E.analyzeSync(Object.assign({}, x, { blueprintObj: bp, blueprint: false, iterations: 3000, seed: 7 }));
    assert.ok(!off.blueprint);
  });

  test('tracker: the hand log keeps the blueprint frequencies with the advice', () => {
    const t = new T({ players: {} });
    let x = null;
    t.on((type, p) => { if (type === 'turn' && p.isHero) x = t.solverInput('typical').input; });
    for (const m of threeHanded()) t.handle(m.ev, m.data, m.snap);
    const r = E.analyzeSync(Object.assign({}, x, { blueprintObj: bp, iterations: 2000, seed: 7 }));
    t.noteAdvice('Call', r.best.ev, r);
    const a = t.hand.advice[t.hand.advice.length - 1];
    assert.ok(a.bp && Array.isArray(a.bp.acts) && a.bp.acts.length > 0, JSON.stringify(a.bp));
  });

  test('engine: no blend for other table sizes or stacks far from 150bb', () => {
    const x = replay(threeHanded(200))[0].input;
    const r = E.analyzeSync(Object.assign({}, x, { blueprintObj: bp, blueprint: true, iterations: 2000, seed: 7 }));
    assert.ok(r.blueprint && !r.blueprint.used && r.blueprint.why === 'stack depth');
    const four = E.analyzeSync(Object.assign({}, replay(threeHanded())[0].input, { seats: ['a', 'b', 'c', 'd'], blueprintObj: bp, iterations: 2000, seed: 7 }));
    assert.ok(!four.blueprint);
  });

  test('range: an open-raise from the button keeps aces and drops most junk', () => {
    const seats = ['Bob', 'Hero', 'Ann'];
    const h = [
      { st: 'pre', who: 'Bob', act: 'sb', amt: 5 }, { st: 'pre', who: 'Hero', hero: true, act: 'bb', amt: 10 },
      { st: 'pre', who: 'Ann', act: 'raise', amt: 41 },
    ];
    const W = bp.rangeOf({ history: h, seats, heroName: 'Bob', board: [] }, 0);
    const k = (a, b) => BP.COMBO_INDEX[E.parseCard(a) * 52 + E.parseCard(b)];
    const share = W.reduce((a, q) => a + q, 0) / 1326;
    assert.ok(share > 0.02 && share < 0.98, String(share));
    assert.ok(W[k('As', 'Ah')] + W[k('Ks', 'Kh')] > W[k('7c', '2d')] + W[k('8c', '3d')]);
  });
}

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
