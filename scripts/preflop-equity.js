#!/usr/bin/env node
// Builds the preflop equity table used by the preflop solver: the all-in equity of every
// starting-hand class against every other (169 x 169), averaged over the combo pairs that
// don't share a card and over random boards. Writes it into src/engine.js on the line that
// starts with `const PF_EQ_B64 =` (upper triangle with the diagonal, Uint16, base64).
//
//   node scripts/preflop-equity.js [samples per pair, default 40000]
//
// Takes about half a minute on 4 cores. Only needs re-running if the format changes.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ENGINE = path.join(__dirname, '..', 'src', 'engine.js');

if (isMainThread) {
  const samples = +process.argv[2] || 40000;
  const E = require(ENGINE);
  const n = 169, pairs = [];
  for (let a = 0; a < n; a++) for (let b = a; b < n; b++) pairs.push([a, b]);
  const cores = Math.max(1, os.cpus().length);
  const out = new Uint16Array(pairs.length);
  let done = 0, finished = 0;
  const t0 = Date.now();
  for (let w = 0; w < cores; w++) {
    const mine = pairs.map((p, i) => i).filter((i) => i % cores === w);
    const worker = new Worker(__filename, { workerData: { idx: mine, pairs: mine.map((i) => pairs[i]), samples, seed: 1234 + w } });
    worker.on('message', (m) => {
      for (let j = 0; j < m.idx.length; j++) out[m.idx[j]] = Math.round(m.eq[j] * 65535);
      done += m.idx.length;
      if (m.final) {
        finished++;
        if (finished === cores) {
          const b64 = Buffer.from(out.buffer).toString('base64');
          const src = fs.readFileSync(ENGINE, 'utf8');
          const line = `  const PF_EQ_B64 = '${b64}';`;
          if (!/^  const PF_EQ_B64 = .*$/m.test(src)) throw new Error('PF_EQ_B64 line not found in src/engine.js');
          fs.writeFileSync(ENGINE, src.replace(/^  const PF_EQ_B64 = .*$/m, line));
          // Spot checks against well-known values.
          const name = (s) => E.CLASS_NAMES.indexOf(s);
          const get = (a, b) => {
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const k = lo * n - (lo * (lo - 1)) / 2 + (hi - lo);
            const v = out[k] / 65535;
            return a <= b ? v : 1 - v;
          };
          for (const [x, y] of [['AA', 'KK'], ['AKs', 'QQ'], ['AKo', '22'], ['72o', 'AA'], ['JTs', 'AKo']]) {
            console.log(`${x} vs ${y}: ${(get(name(x), name(y)) * 100).toFixed(1)}%`);
          }
          console.log(`Wrote ${pairs.length} pairs (${b64.length} base64 chars) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      } else if (done % 2000 < m.idx.length) process.stdout.write(`\r${done}/${pairs.length}`);
    });
    worker.on('error', (e) => { console.error(e); process.exit(1); });
  }
} else {
  const E = require(ENGINE);
  const { idx, pairs, samples } = workerData;
  let s = workerData.seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Combos of each class as card pairs.
  const combos = Array.from({ length: 169 }, () => []);
  for (let a = 1; a < 52; a++) for (let b = 0; b < a; b++) {
    const ra = a >> 2, rb = b >> 2;
    let row, col;
    if (ra === rb) { row = col = 12 - ra; }
    else if ((a & 3) === (b & 3)) { row = 12 - ra; col = 12 - rb; }
    else { row = 12 - rb; col = 12 - ra; }
    combos[row * 13 + col].push([a, b]);
  }
  const cards = new Int32Array(7), used = new Uint8Array(52);
  const BATCH = 200;
  let bIdx = [], bEq = [];
  for (let p = 0; p < pairs.length; p++) {
    const [a, b] = pairs[p];
    const compat = [];
    for (const x of combos[a]) for (const y of combos[b]) {
      if (x[0] !== y[0] && x[0] !== y[1] && x[1] !== y[0] && x[1] !== y[1]) compat.push([x, y]);
    }
    let win = 0;
    for (let it = 0; it < samples; it++) {
      const [x, y] = compat[(rnd() * compat.length) | 0];
      used.fill(0);
      used[x[0]] = used[x[1]] = used[y[0]] = used[y[1]] = 1;
      for (let i = 2; i < 7; i++) {
        let c;
        do { c = (rnd() * 52) | 0; } while (used[c]);
        used[c] = 1;
        cards[i] = c;
      }
      cards[0] = x[0]; cards[1] = x[1];
      const sx = E.evaluate(cards, 7);
      cards[0] = y[0]; cards[1] = y[1];
      const sy = E.evaluate(cards, 7);
      win += sx > sy ? 1 : sx === sy ? 0.5 : 0;
    }
    bIdx.push(idx[p]); bEq.push(win / samples);
    if (bIdx.length >= BATCH) { parentPort.postMessage({ idx: bIdx, eq: bEq }); bIdx = []; bEq = []; }
  }
  parentPort.postMessage({ idx: bIdx, eq: bEq, final: true });
}
