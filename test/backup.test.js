// The reads' copy in the site's storage (extension/backup.js) on a fake store: written without raw
// events, read back on a fresh install, never written over when it couldn't be read or when a far
// smaller set of reads would replace it (unless the reads were reset), and writes spaced out.
// Run: npm test
const assert = require('assert');
const B = require('../extension/backup.js');

function fakeArea() {
  const m = new Map();
  let failGet = false, failSet = false;
  return {
    m,
    failGets: (x) => { failGet = x; },
    failSets: (x) => { failSet = x; },
    get: async (k) => (failGet ? null : m.has(k) ? JSON.parse(m.get(k)) : undefined),
    set: async (k, v) => { if (failSet) return { ok: false, error: 'full' }; m.set(k, JSON.stringify(v)); return { ok: true }; },
  };
}
const player = (hands) => ({ name: 'p', tally: { pfFold: hands / 2, pfCall: hands / 4, pfRaise: hands / 4 } });
const db = (hands, nHist = 3) => ({
  players: { a: player(hands), b: player(hands) },
  fitVersion: 2,
  history: Array.from({ length: nHist }, (_, i) => ({ t: 1000 + i, raw: [{ ev: 'x' }], log: [] })),
});

(async () => {
  let clock = 0;
  const now = () => clock;

  // A fresh site: nothing to load; the first save writes reads and history without raw events.
  {
    const area = fakeArea();
    const bk = B.create(area, { minGapMs: 0, now });
    assert.strictEqual(await bk.load(), null);
    const r = await bk.save(db(40, 200));
    assert.ok(r.ok);
    const v = JSON.parse(area.m.get(B.KEY));
    assert.deepStrictEqual(Object.keys(v.reads).sort(), ['fitVersion', 'players']);
    assert.strictEqual(v.history.length, B.HISTORY, 'only the newest hands');
    assert.ok(v.history.every((e) => !e.raw), 'no raw events in the copy');
    // A reinstall reads it back.
    const again = B.create(area, { minGapMs: 0, now });
    const got = await again.load();
    assert.strictEqual(got.hands, 80);
    assert.strictEqual(Object.keys(got.reads.players).length, 2);
    assert.strictEqual(got.history[0].t, 1000 + 200 - B.HISTORY);
  }

  // A copy that couldn't be read is never written over.
  {
    const area = fakeArea();
    await B.create(area, { minGapMs: 0, now }).load().then(() => null);
    const first = B.create(area, { minGapMs: 0, now });
    await first.load();
    await first.save(db(400));
    area.failGets(true);
    const bk = B.create(area, { minGapMs: 0, now });
    assert.strictEqual(await bk.load(), null);
    const r = await bk.save(db(2));
    assert.ok(!r.ok && r.skipped);
    area.failGets(false);
    assert.strictEqual((await B.create(area, { minGapMs: 0, now }).load()).hands, 800);
  }

  // Far smaller reads (a fresh install whose restore didn't happen) don't replace a big copy; reset does.
  {
    const area = fakeArea();
    const bk = B.create(area, { minGapMs: 0, now });
    await bk.load();
    await bk.save(db(400));
    const fresh = B.create(area, { minGapMs: 0, now });
    await fresh.load();
    assert.ok((await fresh.save(db(10))).skipped, 'tiny reads skip');
    assert.ok((await fresh.save(db(300))).ok, 'reads that grew on the copy are written');
    fresh.reset();
    assert.ok((await fresh.save({ players: {}, history: [] })).ok, 'reset reads replace the copy');
    const after = await B.create(area, { minGapMs: 0, now }).load();
    assert.strictEqual(Object.keys(after.reads.players).length, 0, 'empty reads leave nothing to restore');
  }

  // Writes are spaced out: a save inside the gap waits, and the newest reads win.
  {
    const area = fakeArea();
    const bk = B.create(area, { minGapMs: 50, now: () => Date.now() });
    await bk.load();
    await bk.save(db(10));
    const p1 = bk.save(db(20));
    const p2 = bk.save(db(30));
    assert.strictEqual((await p2).queued, true);
    await p1;
    assert.strictEqual(B.handsOf(JSON.parse(area.m.get(B.KEY)).reads.players), 60);
  }

  console.log('backup tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
