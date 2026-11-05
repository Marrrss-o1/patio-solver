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

test('import: hands from an export are stored once, older ones too, and the newest 1,000 kept', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB, { keep: 30 });
  let { db } = await hl.load(MEM, RAW);
  for (let i = 0; i < 20; i++) logHand(db);
  await hl.save(db);
  const mine = await hl.exportAll(db);
  // An export from an older install: 15 older hands, and 5 that are already here.
  const old = [];
  for (let i = 0; i < 15; i++) old.push({ t: 1780000000000 + i * 30000, board: [], raw: [{ t: 0, ev: 'x' }], players: [] });
  const r = await hl.addHands(old.concat(mine.slice(0, 5).map((e) => JSON.parse(JSON.stringify(e)))));
  assert.ok(r.ok, JSON.stringify(r));
  // 20 + 15 = 35 > 30: the 5 oldest imported hands are dropped again.
  assert.strictEqual(area.hands().length, 30);
  assert.strictEqual(r.added, 10);
  assert.strictEqual(hl.count(), 30);
  const all = await hl.exportAll(db);
  assert.strictEqual(all.length, 30);
  assert.ok(all.every((e, i) => i === 0 || e.t >= all[i - 1].t), 'oldest first');
  // Importing the same file again adds nothing, and later saves keep working.
  assert.strictEqual((await hl.addHands(old)).added, 0);
  logHand(db);
  assert.ok((await hl.save(db)).ok);
  assert.strictEqual(area.hands().length, 30);
});

test('import: a failed write adds nothing', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB);
  const { db } = await hl.load(MEM, RAW);
  area.failWith('QUOTA_BYTES quota exceeded');
  const r = await hl.addHands([{ t: 1780000000000, raw: [], players: [] }]);
  assert.ok(!r.ok && r.added === 0 && /quota/.test(r.error));
  assert.strictEqual(hl.count(), 0);
  void db;
});

const E = require('../src/engine.js');
const T = PatioTracker;
const sd = require('./fixtures/synth-showdown.json');
test('import: reads rebuilt from the hand log match the reads built at the table', async () => {
  const live = new T({ players: {} });
  const setup = (t) => { t.scorer = (show, tally) => E.scoreShow(show, tally, 'typical'); };
  setup(live);
  // A table clock that moves 700 ms per event, so think times are not 0 and do not depend on how fast the test runs.
  let clock = Date.UTC(2026, 10, 1, 14);
  live.clock = () => clock;
  const feed = (t, list) => { for (const m of list) { clock += 700; if (m.ev === 'hook:attached') { t.snap = m.snap; continue; } t.handle(m.ev, m.data, m.snap); } };
  feed(live, sd);
  feed(live, sd.filter((m) => m.ev !== 'hook:attached')); // the hand again: decay and a second hand
  live.finishHand();
  const tts = Object.values(live.db.players).flatMap((p) => Object.values(p.tally.tt || {}).map((x) => x.sum || 0));
  assert.ok(tts.some((x) => x > 0), 'think times recorded');
  const hands = JSON.parse(JSON.stringify(live.db.history));
  assert.ok(hands.length === 2 && hands.every((e) => e.raw && e.raw.length && e.raw.find((r) => r.s).s[0].length === 6), 'raw snapshots carry the account id');
  const same = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const r = await T.rebuildReads(hands, { setup });
  assert.strictEqual(r.replayed, 2);
  same(Object.keys(r.db.players), Object.keys(live.db.players));
  for (const id of Object.keys(live.db.players)) same(r.db.players[id].tally, live.db.players[id].tally);
  // Logs from before v1.8.1 have names only: the reads the page has map names to account ids.
  const old = JSON.parse(JSON.stringify(hands));
  for (const e of old) for (const x of e.raw) if (x.s) x.s = x.s.map((s) => s.slice(0, 5));
  const r2 = await T.rebuildReads(old, { setup, known: { Vic: 'V' }, heroAuth: 'H' });
  same(r2.db.players.V.tally, live.db.players.V.tally);
  // Without that, a name from the chat lines of the same day, else "name:<name>".
  const chat = JSON.parse(JSON.stringify(old));
  chat[0].raw.push({ t: 1, ev: 'chat_message', d: { username: 'Vic', userId: 'V2' } });
  const r3 = await T.rebuildReads(chat.concat([{ t: 1, players: [] }]), { setup });
  assert.ok(r3.db.players.V2 && !r3.db.players.V && r3.skipped === 1, Object.keys(r3.db.players).join(','));
  const r4 = await T.rebuildReads(old, { setup });
  assert.ok(r4.db.players['name:Vic']);
});

test('import: linked reads and "different players" answers survive a rebuild', async () => {
  const swap = (id, name) => JSON.parse(JSON.stringify(sd).replace(/"authUserId":"V"/g, `"authUserId":"${id}"`).replace(/"name":"Vic"/g, `"name":"${name}"`));
  const live = new T({ players: {} });
  const feed = (list) => { for (const m of list) { if (m.ev === 'hook:attached') { live.snap = m.snap; continue; } live.handle(m.ev, m.data, m.snap); } };
  feed(swap('J1', 'Jagger'));
  feed(swap('J3', 'Jag'));
  feed(swap('J4', 'Jagger'));
  assert.ok(live.link('J3', 'J1').ok);
  live.refuseLink('J4', 'J1');
  const r = await T.rebuildReads(JSON.parse(JSON.stringify(live.db.history)), { same: live.db.same, notSame: live.db.notSame });
  assert.strictEqual(r.db.same.J3, 'J1');
  assert.ok(r.db.seen.J1 && r.db.seen.J3 && r.db.seen.J4);
  assert.ok(Object.keys(r.db.notSame).some((k) => k.includes('J4')));
  // The rebuilt reads, linked: J1 and J3 added up.
  const t2 = new T(r.db);
  const hands = (x) => x.pfFold + x.pfCall + x.pfRaise;
  assert.ok(Math.abs(hands(t2.readTally('J3')) - hands(r.db.players.J1.tally) - hands(r.db.players.J3.tally)) < 1e-9);
});

// ---------- exports of new hands (v1.8.21) ----------
test('export of a range: only those hands, reading only their keys, memory copies first', async () => {
  const area = fakeArea();
  const hl = HL.create(area, DB, { keep: 300 });
  const { db } = await hl.load(MEM, RAW);
  for (let i = 0; i < 250; i++) { logHand(db); await hl.save(db); }
  const times = await hl.times(db);
  assert.strictEqual(times.length, 250);
  assert.ok(times.every((t, i) => !i || t > times[i - 1]), 'oldest first');
  const newest = db.history[db.history.length - 1];
  newest.heroNet = 5; // not saved yet
  area.log.gets = [];
  const out = await hl.exportRange(db, times[199], Infinity);
  assert.deepStrictEqual(out.map((e) => e.t), times.slice(200));
  assert.deepStrictEqual(area.log.gets, [50], 'only the 50 hands in range are read');
  assert.ok(out.every((e) => e.raw), 'raw events come from storage where the page dropped them');
  assert.strictEqual(out[out.length - 1].heroNet, 5, 'hands in memory come from memory');
  // Old hands that the page no longer holds come from storage.
  const early = await hl.exportRange(db, times[9], times[19]);
  assert.deepStrictEqual(early.map((e) => e.t), times.slice(10, 20));
  // A hand that couldn't be saved yet is in times and in the export.
  area.failWith('full');
  const unsaved = logHand(db);
  await hl.save(db);
  const t2 = await hl.times(db);
  assert.strictEqual(t2[t2.length - 1], unsaved.t);
  assert.strictEqual((await hl.exportRange(db, newest.t, Infinity)).length, 1);
  // Everything: the same hands as exportAll.
  const all = await hl.exportRange(db, -Infinity, Infinity);
  assert.deepStrictEqual(all.map((e) => e.t), (await hl.exportAll(db)).map((e) => e.t));
  // Without getKeys it reads everything once to find the keys, and still exports the range.
  const old = fakeArea({ noKeys: true });
  for (const [k, v] of area.m) old.m.set(k, v);
  const viaGet = await HL.create(old, DB, { keep: 300 }).exportRange({ history: [] }, times[239], Infinity);
  assert.deepStrictEqual(viaGet.map((e) => e.t), times.slice(240));
});

test('export mark: moves over the hands an export covers, never over a gap or a hand still changing', () => {
  const now = 1e12;
  const ts = [100, 200, 300, 400, 500].map((x) => now - 1e6 + x);
  const hand = (t, net = true) => ({ t, net: net ? { A: 1 } : undefined });
  const all = ts.map((t) => hand(t));
  // First export with this version (no mark): everything, up to the newest hand with its result.
  assert.strictEqual(HL.nextMark(null, ts, all, now, -Infinity), ts[4]);
  // The newest hand without its result yet stays new; so does one that ended under a minute ago.
  assert.strictEqual(HL.nextMark(null, ts, all.slice(0, 4).concat([hand(ts[4], false)]), now, -Infinity), ts[3]);
  assert.strictEqual(HL.nextMark(null, ts, all, ts[4] + HL.SETTLE_MS - 1, -Infinity), ts[3]);
  // An older hand that never got a result (the page was reloaded) doesn't hold the mark back.
  assert.strictEqual(HL.nextMark(null, ts, [hand(ts[0]), hand(ts[1], false)].concat(all.slice(2)), now, -Infinity), ts[4]);
  // New hands after a mark.
  assert.strictEqual(HL.nextMark(ts[1], ts, all.slice(2), now, ts[1]), ts[4]);
  // An export that skips hands after the mark (an older or a later session) leaves the mark where it is.
  assert.strictEqual(HL.nextMark(ts[0], ts, all.slice(3), now, ts[2]), ts[0]);
  assert.strictEqual(HL.nextMark(ts[3], ts, all.slice(0, 2), now, ts[0] - 1), ts[3], 'never moves back');
  // With no mark yet, a session export counts the hands before it as exported (every older export
  // had every hand), so "New hands" starts after that session.
  assert.strictEqual(HL.nextMark(null, ts, all.slice(2, 4), now, ts[2] - 1), ts[3]);
  // An import with no mark: the imported hands, as far as they cover the stored ones.
  assert.strictEqual(HL.nextMark(null, ts, all.slice(0, 3), now), ts[2]);
  assert.strictEqual(HL.nextMark(null, ts, all.slice(1, 3), now), null, 'the oldest stored hand was not imported');
  assert.strictEqual(HL.nextMark(null, [], [], now), null);
});

test('sessions: hands split at a 45-minute break', () => {
  const m = 60000;
  const ts = [0, 1, 2, 26.4, 28, 28 + 45, 28 + 45 + 1, 200].map((x) => 1e12 + x * m);
  assert.deepStrictEqual(HL.sessions(ts).map((s) => [s.n, (s.from - 1e12) / m, (s.to - 1e12) / m]), [[5, 0, 28], [2, 73, 74], [1, 200, 200]]);
  assert.deepStrictEqual(HL.sessions([]), []);
});

test('export file: one hand per line, reads back as the same hands, named by its time range', () => {
  const db = { history: [] };
  for (let i = 0; i < 3; i++) logHand(db);
  const text = HL.toFile(db.history);
  assert.deepStrictEqual(JSON.parse(text), db.history);
  assert.strictEqual(text.split('\n').length, db.history.length + 3);
  assert.ok(text.length < JSON.stringify(db.history, null, 1).length);
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  assert.strictEqual(HL.fileName([{ t: at(2026, 11, 5, 10, 54) }, { t: at(2026, 11, 5, 11, 31) }]), 'patio-hand-log-2026-11-05-1054-to-1131.json');
  assert.strictEqual(HL.fileName([{ t: at(2026, 11, 4, 23, 5) }, { t: at(2026, 11, 5, 1, 2) }]), 'patio-hand-log-2026-11-04-2305-to-2026-11-05-0102.json');
  assert.strictEqual(HL.fileName([]), 'patio-hand-log.json');
});

test('merge-logs: files and folders, each hand once, the fuller copy kept', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const M = require('./merge-logs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patio-merge-'));
  const h = (t, extra) => Object.assign({ t, hero: ['As', 'Kd'], board: [] }, extra);
  // An old cumulative export, then two exports of new hands that overlap by one hand (exported
  // before its result came in), and a file in the folder that isn't a hand log.
  fs.writeFileSync(path.join(dir, 'a-old.json'), JSON.stringify([h(1, { net: {} }), h(2, { net: {} }), h(3)], null, 1));
  fs.writeFileSync(path.join(dir, 'b-new.json'), HL.toFile([h(3, { net: { A: 4 }, raw: [] }), h(4), h(5, { net: {}, raw: [1, 2, 3] })]));
  fs.writeFileSync(path.join(dir, 'c-new.json'), HL.toFile([h(4, { net: { A: -1 } }), h(5, { net: {}, raw: [1, 2] })]));
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ hello: 1 }));
  const info = {};
  const got = M.loadHands([dir], { info, quiet: true });
  assert.deepStrictEqual(got.map((x) => x.t), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(got[2].net, { A: 4 }, 'the copy with the result wins');
  assert.deepStrictEqual(got[3].net, { A: -1 });
  assert.strictEqual(got[4].raw.length, 3, 'then the copy with more raw events');
  assert.deepStrictEqual(info, { files: 3, read: 8, dupes: 3 });
  // The same hand time with other hero cards is another hand (two tables).
  fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ history: [h(5, { hero: ['2c', '2d'] })] }));
  assert.strictEqual(M.loadHands([dir], { quiet: true }).length, 6);
  // Files named on their own must be hand logs.
  assert.throws(() => M.loadHands([path.join(dir, 'notes.json')]), /not a hand-log export/);
  assert.strictEqual(M.loadHands([path.join(dir, 'b-new.json'), path.join(dir, 'a-old.json')]).length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
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
