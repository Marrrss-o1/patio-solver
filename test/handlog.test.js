// The computer's hand-log storage (extension/handlog.js) on a fake chrome.storage.local: each hand
// in its own key, old single-key saves moved over, the newest 1,000 kept with their raw events,
// and failed saves reported. Run: npm test
const assert = require('assert');
const HL = require('../extension/handlog.js');
const PatioTracker = require('../src/tracker.js');

const DB = 'patioSolverDb';
// chrome.storage.local: values are copied when they are written, as Chrome does.
function fakeArea(opts = {}) {
  const m = new Map();
  const log = { sets: [], removes: [] };
  let fail = null;
  return {
    m, log,
    failWith: (e) => { fail = e; },
    get: async (keys) => {
      log.gets = (log.gets || []).concat([keys == null ? 'all' : [].concat(keys).length]);
      const out = {};
      const want = keys == null ? [...m.keys()] : [].concat(keys);
      for (const k of want) if (m.has(k)) out[k] = JSON.parse(m.get(k));
      return out;
    },
    set: async (items) => {
      if (fail) return { ok: false, error: fail };
      log.sets.push(Object.keys(items));
      for (const k of Object.keys(items)) m.set(k, JSON.stringify(items[k]));
      return { ok: true };
    },
    remove: async (keys) => {
      log.removes.push([].concat(keys));
      for (const k of [].concat(keys)) m.delete(k);
      return { ok: true };
    },
    keys: opts.noKeys ? null : async () => { log.keys = (log.keys || 0) + 1; return [...m.keys()]; },
    hands: () => [...m.keys()].filter((k) => k.startsWith(HL.PREFIX)),
  };
}
// What the tracker's logHand does to the history: push, keep 150, raw events on the newest 100.
const MEM = PatioTracker.MAX_HISTORY, RAW = PatioTracker.RAW_KEEP;
let clock = 1790000000000;
function logHand(db) {
  const e = { t: clock += 30000, board: ['As', 'Kd', '2c'], raw: [{ t: 0, ev: 'game:stage_began', d: { pad: 'x'.repeat(200) } }], players: [] };
  const list = db.history || (db.history = []);
  list.push(e);
  if (list.length > MEM) list.splice(0, list.length - MEM);
  for (let i = 0; i < list.length - RAW; i++) delete list[i].raw;
  return e;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('tracker caps are exported for the overlay', () => {
  assert.strictEqual(MEM, 150);
  assert.strictEqual(RAW, 100);
});

test('reads saved by older versions: the log moves to one key per hand, raw events kept', async () => {
  const area = fakeArea();
  const old = { players: { u1: { name: 'A' } }, history: [] };
  for (let i = 0; i < 150; i++) logHand(old);
  await area.set({ [DB]: old });
  const hl = HL.create(area, DB);
  const { db, error } = await hl.load(MEM, RAW);
  assert.strictEqual(error, null);
  assert.strictEqual(area.hands().length, 150);
  assert.strictEqual(db.history.length, 150);
  assert.strictEqual(db.history.filter((e) => e.raw).length, 100);
  assert.deepStrictEqual(db.players, old.players);
  assert.strictEqual((await hl.save(db)).ok, true);
  const reads = (await area.get(DB))[DB];
  assert.ok(!('history' in reads), 'the reads key no longer holds the log');
  assert.deepStrictEqual(reads.players, old.players);
  // Loading again finds the hands under their own keys, nothing duplicated.
  const again = await HL.create(area, DB).load(MEM, RAW);
  assert.strictEqual(again.db.history.length, 150);
  assert.deepStrictEqual(again.db.history.map((e) => e.t), old.history.map((e) => e.t));
  assert.strictEqual(again.hands, 150);
});

test('a save writes the reads and the newest hands, not the whole log', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB);
  const { db } = await hl.load(MEM, RAW);
  for (let i = 0; i < 200; i++) { logHand(db); await hl.save(db); }
  for (const keys of area.log.sets.slice(10)) assert.ok(keys.length <= 1 + HL.REWRITE, keys.join(','));
  assert.strictEqual(area.hands().length, 200, 'storage keeps more than the page does');
  assert.strictEqual(db.history.length, 150);
  // The hand before the newest gets its result when the next hand starts: saved.
  db.history[db.history.length - 2].heroNet = 42;
  await hl.save(db);
  const k = area.hands().sort().slice(-2)[0];
  assert.strictEqual(JSON.parse(area.m.get(k)).heroNet, 42);
});

test('storage keeps the newest hands with raw events; the export has all of them', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB, { keep: 300 });
  const { db } = await hl.load(MEM, RAW);
  for (let i = 0; i < 400; i++) { logHand(db); await hl.save(db); }
  assert.strictEqual(area.hands().length, 300);
  const newest = db.history[db.history.length - 1];
  newest.heroNet = -7; // not saved yet
  const out = await hl.exportAll(db);
  assert.strictEqual(out.length, 300);
  assert.ok(out.every((e) => e.raw), 'raw events stay in storage after the page drops them');
  assert.ok(out.every((e, i) => !i || e.t > out[i - 1].t), 'oldest first');
  assert.strictEqual(out[out.length - 1].heroNet, -7, 'hands in memory come from memory');
  // A new page reads only the reads and the newest 150 hands (raw events on the newest 100).
  area.log.gets = [];
  const fresh = await HL.create(area, DB, { keep: 300 }).load(MEM, RAW);
  assert.deepStrictEqual(area.log.gets, [151]);
  assert.strictEqual(fresh.db.history.length, 150);
  assert.strictEqual(fresh.db.history.filter((e) => e.raw).length, 100);
  assert.strictEqual(fresh.db.history[149].t, newest.t);
  assert.strictEqual(fresh.hands, 300);
  // Without getKeys (Chrome before 130) it reads everything once to find the keys.
  const old = fakeArea({ noKeys: true });
  for (const [k, v] of area.m) old.m.set(k, v);
  const viaGet = await HL.create(old, DB, { keep: 300 }).load(MEM, RAW);
  assert.deepStrictEqual(viaGet.db.history.map((e) => e.t), fresh.db.history.map((e) => e.t));
  assert.strictEqual(viaGet.hands, 300);
});

test('hands saved by another tab are kept, exported and pruned with the rest', async () => {
  const area = fakeArea();
  const a = HL.create(area, DB, { keep: 50 }), b = HL.create(area, DB, { keep: 50 });
  const dbA = (await a.load(MEM, RAW)).db, dbB = (await b.load(MEM, RAW)).db;
  for (let i = 0; i < 10; i++) { logHand(dbA); await a.save(dbA); logHand(dbB); await b.save(dbB); }
  assert.strictEqual(area.hands().length, 20);
  assert.strictEqual((await a.exportAll(dbA)).length, 20);
  const c = HL.create(area, DB, { keep: 50 });
  const dbC = (await c.load(MEM, RAW)).db;
  assert.strictEqual(dbC.history.length, 20);
  for (let i = 0; i < 40; i++) { logHand(dbC); await c.save(dbC); }
  assert.strictEqual(area.hands().length, 50);
});

test('the default keeps 1,000 hands', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB);
  const { db } = await hl.load(MEM, RAW);
  for (let i = 0; i < 1100; i++) { logHand(db); await hl.save(db); }
  assert.strictEqual(HL.KEEP, 1000);
  assert.strictEqual(area.hands().length, 1000);
  assert.strictEqual(hl.count(), 1000);
});

test('a failed save is reported, and the next one that works writes what was missed', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB);
  const { db } = await hl.load(MEM, RAW);
  logHand(db);
  assert.strictEqual((await hl.save(db)).ok, true);
  area.failWith('QUOTA_BYTES quota exceeded');
  for (let i = 0; i < 5; i++) logHand(db);
  const r = await hl.save(db);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'QUOTA_BYTES quota exceeded');
  area.failWith(null);
  logHand(db);
  assert.strictEqual((await hl.save(db)).ok, true);
  // Hands logged while saves failed are written by the next save that works.
  assert.strictEqual(area.hands().length, 7);
  const out = await hl.exportAll(db);
  assert.deepStrictEqual(out.map((e) => e.t), db.history.map((e) => e.t));
});

test('if moving an old save fails, the first save that works moves it', async () => {
  const area = fakeArea();
  const old = { players: {}, history: [] };
  for (let i = 0; i < 30; i++) logHand(old);
  await area.set({ [DB]: old });
  area.failWith('QUOTA_BYTES quota exceeded');
  const hl = HL.create(area, DB);
  const { db, error } = await hl.load(MEM, RAW);
  assert.strictEqual(error, 'QUOTA_BYTES quota exceeded');
  assert.strictEqual(db.history.length, 30);
  assert.strictEqual(area.hands().length, 0);
  area.failWith(null);
  assert.strictEqual((await hl.save(db)).ok, true);
  assert.strictEqual(area.hands().length, 30);
  assert.ok(!('history' in (await area.get(DB))[DB]));
});

test('if the saved reads cannot be read at start, nothing is saved over them', async () => {
  const area = fakeArea();
  await area.set({ [DB]: { players: { u1: { name: 'A' } } }, [HL.PREFIX + '1']: { t: 1 } });
  const realGet = area.get;
  area.get = async () => null; // a failed read
  const hl = HL.create(area, DB);
  const { db, error } = await hl.load(MEM, RAW);
  assert.ok(/couldn't be read/.test(error), error);
  logHand(db);
  const r = await hl.save(db);
  assert.strictEqual(r.ok, false);
  area.get = realGet;
  assert.deepStrictEqual((await area.get(DB))[DB].players, { u1: { name: 'A' } }, 'the reads are still there');
  assert.strictEqual(area.hands().length, 1);
});

test('reset reads keeps the hand log', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB);
  let { db } = await hl.load(MEM, RAW);
  db.players = { u1: { name: 'A' } };
  for (let i = 0; i < 20; i++) logHand(db);
  await hl.save(db);
  db = { players: {}, history: db.history }; // what the Reset reads button does
  await hl.save(db);
  assert.deepStrictEqual((await area.get(DB))[DB].players, {});
  assert.strictEqual(area.hands().length, 20);
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
  }
  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nAll hand-log storage tests passed');
})();
