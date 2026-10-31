// How often the blueprint applies in real hands: replays the raw events of a hand-log export
// through the tracker and engine, and counts hero's decisions where the blueprint was used, by
// table size and street, with the reason when it was not.
//   node blueprint/coverage.js <hand-log.json> [blueprint files, default extension/blueprint-*.bin.gz]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const E = require('../src/engine.js');
const T = require('../src/tracker.js');
const BP = require('../src/blueprint.js');

const [logFile, ...bpArgs] = process.argv.slice(2);
if (!logFile) { console.error('usage: node blueprint/coverage.js <hand-log.json> [blueprint files]'); process.exit(1); }
const ext = path.join(__dirname, '..', 'extension');
const files = bpArgs.length ? bpArgs : fs.readdirSync(ext).filter((f) => /^blueprint-\dmax\.bin\.gz$/.test(f)).map((f) => path.join(ext, f));
const read = (f) => (f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)) : fs.readFileSync(f));
const bps = files.map((f) => BP.load(read(f)));
console.log('blueprints:', bps.map((b) => `${b.players}-handed (${b.head.iterations} iterations)`).join(', '));

const hands = JSON.parse(fs.readFileSync(logFile, 'utf8'));
const tracker = new T({ players: {} });
tracker.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const count = {};
const bump = (n, st, k) => { const key = `${n}-handed ${STREETS[st]}`; (count[key] = count[key] || {})[k] = (count[key][k] || 0) + 1; };
let snap = null, decisions = 0, used = 0;
tracker.on((type, p) => {
  if (type !== 'turn' || !p.isHero) return;
  const b = tracker.solverInput('typical');
  if (b.error) return;
  const x = b.input;
  const r = E.analyzeSync(Object.assign({}, x, { blueprintObj: bps, iterations: 600, riverIterations: 20, preflopIterations: 40, seed: 1 }));
  const st = x.board.length ? x.board.length - 2 : 0;
  decisions++;
  const why = !r.blueprint ? 'no blueprint for this size' : r.blueprint.used ? 'used' : r.blueprint.why;
  if (why === 'used') used++;
  bump(x.seats.length, st, why);
});
for (const h of hands) {
  if (!h.raw || !h.raw.length) continue;
  const heroName = (h.players.find((p) => p.hero) || {}).name;
  for (const e of h.raw) {
    if (e.s) snap = { tableType: 'private', heroAuthId: heroName, bigBlind: e.bb || (snap && snap.bigBlind) || h.bigBlind,
      players: e.s.map(([id, name, stack, posType, playState]) => ({ id, authUserId: name, name, stack, posType, playState })) };
    if (snap) tracker.handle(e.ev, e.d, snap);
  }
}
console.log(`hero decisions: ${decisions}, blueprint used in ${used} (${Math.round((100 * used) / Math.max(1, decisions))}%)`);
for (const k of Object.keys(count).sort()) console.log(k.padEnd(18), JSON.stringify(count[k]));
