// The computer's solver plumbing (extension/offscreen.js and background.js) with fake workers,
// timers and chrome APIs: a newer decision replaces one still being solved, a crashed or hung
// worker is replaced, and a crashed offscreen page is made again. Run: npm test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// offscreen.js in a sandbox. Workers are created in this order: CORES pool workers, the final
// worker, the quick worker (and replacements after them).
function loadOffscreen(cores) {
  const workers = [], timers = [];
  class FakeWorker {
    constructor(url) { this.url = url; this.inbox = []; this.dead = false; workers.push(this); }
    postMessage(m) { if (!this.dead) this.inbox.push(m); }
    terminate() { this.dead = true; }
  }
  let listener = null;
  const ctx = vm.createContext({
    navigator: { hardwareConcurrency: cores },
    Worker: FakeWorker,
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    PokerEngine: { solvableSpot: (input) => input.spot || null },
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.on = false; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/offscreen.js'), 'utf8'), ctx);
  const CORES = Math.max(2, Math.min(10, cores - 2));
  const send = (msg) => {
    const out = { done: false, value: null };
    out.p = new Promise((res) => listener(Object.assign({ target: 'offscreen', type: 'analyze' }, msg), {}, (r) => { out.done = true; out.value = r; res(r); }));
    return out;
  };
  // Answer every job a live worker holds (not the blueprint warm-up, id 0).
  const answer = (w) => {
    const jobs = w.inbox.filter((m) => m.id > 0 && !m.answered);
    for (const m of jobs) {
      m.answered = true;
      const data = m.mode === 'partial' ? { id: m.id, ok: true, partial: { seed: m.input.seed }, kernels: true } : { id: m.id, ok: true, result: { best: { kind: 'check' }, merged: (m.input.merge || []).length }, kernels: true };
      w.onmessage({ data });
    }
    return jobs.length;
  };
  const live = () => workers.filter((w) => !w.dead);
  return { workers, timers, send, answer, live, CORES, pool: () => live().slice(0, 0) };
}

test('pool: the final and quick workers load the blueprints when they start, the others do not', async () => {
  const o = loadOffscreen(6);
  assert.strictEqual(o.workers.length, o.CORES + 2);
  o.workers.forEach((w, i) => assert.deepStrictEqual(w.inbox.map((m) => m.mode), i >= o.CORES ? ['warm'] : []));
});

test('pool: a full solve uses every pool worker, then the final worker', async () => {
  const o = loadOffscreen(6);
  const a = o.send({ input: { seed: 1 }, tab: 1 });
  await settle();
  for (let i = 0; i < o.CORES; i++) assert.strictEqual(o.workers[i].inbox.filter((m) => m.mode === 'partial').length, 1);
  for (let i = 0; i < o.CORES; i++) o.answer(o.workers[i]);
  await settle();
  const fin = o.workers[o.CORES];
  assert.strictEqual(fin.inbox.filter((m) => m.mode === 'final').length, 1);
  o.answer(fin);
  await settle();
  assert.ok(a.done && a.value.ok, JSON.stringify(a.value));
  assert.strictEqual(a.value.workers, o.CORES);
  assert.strictEqual(a.value.result.merged, o.CORES);
});

test('pool: a newer decision at the same table replaces the one still solving', async () => {
  const o = loadOffscreen(6);
  const a = o.send({ input: { seed: 1, spot: 'turn' }, tab: 1 });
  await settle();
  const old = o.workers.slice(0, o.CORES);
  const b = o.send({ input: { seed: 2 }, tab: 1 });
  await settle();
  // The old request is answered at once, and its workers are replaced instead of finishing it.
  assert.ok(a.done && a.value.superseded && !a.value.ok, JSON.stringify(a.value));
  assert.ok(old.every((w) => w.dead));
  assert.ok(!o.workers[o.CORES].dead && !o.workers[o.CORES + 1].dead, 'final and quick workers are kept');
  const fresh = o.workers.slice(o.CORES + 2);
  assert.strictEqual(fresh.length, o.CORES);
  assert.ok(fresh.every((w) => w.inbox.length === 1 && w.inbox[0].mode === 'partial' && w.inbox[0].input.seed !== undefined));
  fresh.forEach(o.answer);
  await settle();
  o.answer(o.workers[o.CORES]);
  await settle();
  assert.ok(b.done && b.value.ok, JSON.stringify(b.value));
});

test('pool: a decision at another table does not replace it', async () => {
  const o = loadOffscreen(6);
  const a = o.send({ input: { seed: 1 }, tab: 1 });
  await settle();
  const b = o.send({ input: { seed: 2 }, tab: 2 });
  await settle();
  assert.ok(!a.done && !b.done);
  assert.ok(o.workers.every((w) => !w.dead));
  for (let i = 0; i < o.CORES; i++) o.answer(o.workers[i]);
  await settle();
  o.answer(o.workers[o.CORES]);
  await settle();
  assert.ok(a.value.ok && b.value.ok);
});

test('pool: a newer decision during the final pass lets the final worker finish', async () => {
  const o = loadOffscreen(6);
  const a = o.send({ input: { seed: 1 }, tab: 1 });
  await settle();
  for (let i = 0; i < o.CORES; i++) o.answer(o.workers[i]);
  await settle();
  const b = o.send({ input: { seed: 2 }, tab: 1 });
  await settle();
  assert.ok(o.workers.every((w) => !w.dead), 'nothing is replaced: the pool is idle, the final pass is short');
  for (let i = 0; i < o.CORES; i++) o.answer(o.workers[i]);
  await settle();
  o.answer(o.workers[o.CORES]);
  await settle();
  o.answer(o.workers[o.CORES]);
  await settle();
  assert.ok(a.done && a.value.superseded, JSON.stringify(a.value));
  assert.ok(b.done && b.value.ok, JSON.stringify(b.value));
});

test('pool: a crashed worker fails its job at once and is replaced', async () => {
  const o = loadOffscreen(4);
  const a = o.send({ input: { seed: 1 }, tab: 1 });
  await settle();
  let prevented = false;
  o.workers[0].onerror({ preventDefault: () => { prevented = true; } });
  o.answer(o.workers[1]);
  await settle();
  assert.ok(prevented);
  assert.ok(a.done && !a.value.ok && /crashed/.test(a.value.error), JSON.stringify(a.value));
  assert.ok(o.workers[0].dead);
  const b = o.send({ input: { seed: 2 }, tab: 1 });
  await settle();
  o.live().slice(0).forEach((w) => { if (w.inbox.some((m) => m.mode === 'partial' && !m.answered)) o.answer(w); });
  await settle();
  o.answer(o.workers[o.CORES]);
  await settle();
  assert.ok(b.done && b.value.ok, JSON.stringify(b.value));
});

test('pool: a hung worker is replaced after 30 s and the next decision gets advice', async () => {
  const o = loadOffscreen(4);
  const q = o.send({ input: { seed: 1 }, quick: true });
  await settle();
  const limit = o.timers.filter((t) => t.on && t.ms === 30000);
  assert.strictEqual(limit.length, 1);
  limit[0].fn();
  await settle();
  assert.ok(q.done && !q.value.ok && /too long/.test(q.value.error), JSON.stringify(q.value));
  assert.ok(o.workers[o.CORES + 1].dead);
  const quick = o.workers[o.workers.length - 1];
  assert.deepStrictEqual(quick.inbox.map((m) => m.mode), ['warm'], 'the new quick worker loads the blueprints');
  const q2 = o.send({ input: { seed: 2 }, quick: true });
  await settle();
  o.answer(quick);
  await settle();
  assert.ok(q2.done && q2.value.ok, JSON.stringify(q2.value));
  assert.ok(o.timers.filter((t) => t.on).length === 0, 'answered jobs clear their timers');
});

// background.js in a sandbox: a fake engine that counts solves done in the service worker.
function loadBackground(offscreenAnswer) {
  let created = 0, contexts = 0, here = 0;
  const sent = [];
  let listener = null;
  const ctx = vm.createContext({
    importScripts: () => {},
    PokerEngine: { analyzeSync: () => { here++; return {}; } },
    slim: (r) => r,
    chrome: {
      offscreen: { createDocument: async () => { created++; } },
      runtime: {
        getContexts: async () => (contexts ? [{}] : []),
        sendMessage: async (m) => { sent.push(m); return offscreenAnswer(m, sent.length); },
        onMessage: { addListener: (fn) => { listener = fn; } },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
  const ask = (msg, tabId) => new Promise((res) => listener(Object.assign({ type: 'analyze', input: {} }, msg), { tab: { id: tabId } }, res));
  return { ask, sent, counts: () => ({ created, here }) };
}

test('background: after the offscreen page crashes, the next decision makes a new one', async () => {
  const b = loadBackground((m, n) => { if (n === 1) throw new Error('Could not establish connection. Receiving end does not exist.'); return { ok: true, result: {}, workers: 4 }; });
  const r1 = await b.ask({}, 7);
  assert.ok(r1.ok && r1.workers === 1, 'solved in the service worker this time');
  const r2 = await b.ask({}, 7);
  assert.ok(r2.ok && r2.workers === 4, 'back on the offscreen pool');
  assert.deepStrictEqual(b.counts(), { created: 2, here: 1 });
  assert.strictEqual(b.sent[1].tab, 7, 'the tab goes along so the pool knows which table asked');
});

test('background: a decision replaced by a newer one is not solved again here', async () => {
  const b = loadBackground(() => ({ ok: false, superseded: true, error: 'replaced' }));
  const r = await b.ask({}, 3);
  assert.ok(r.superseded && !r.ok);
  assert.strictEqual(b.counts().here, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
  }
  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nAll pool tests passed');
})();
