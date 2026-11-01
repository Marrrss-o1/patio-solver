// Solver settings the tuning sweep can change without touching src/: each knob is an exact text edit to a copy of
// src/engine.js, written to test/out/tune/<hash>/src. An edit that no longer matches the engine throws, so a knob
// can't silently test nothing after the engine changes.
//   run.js --b-patch '{"robust":0.5}'        tune.js --arms '{"r50":{"patch":{"robust":0.5}}}'
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const num = (v) => { if (!isFinite(+v)) throw new Error('not a number: ' + v); return String(+v); };
const list = (v) => { if (!Array.isArray(v) || !v.length || v.some((x) => !isFinite(+x))) throw new Error('not a list of numbers: ' + JSON.stringify(v)); return '[' + v.map(num).join(', ') + ']'; };

const KNOBS = {
  // Exploit strength: the read's weight against balanced play (computeStats' p, also exploitWeight), times v.
  exploit: { def: 1, edits: [['const p = clamp((0.5 + (0.4 * n) / 120) * trust, 0.3, 0.95);', (v) => `const p = clamp((0.5 + (0.4 * n) / 120) * trust * ${num(v)}, 0.3, 0.95);`]] },
  // Safety margin: how much of the worst opponent variant is blended into each option's EV (0.35 x (1 - trust)).
  robust: { def: 0.35, edits: [['const robustWeight = lookahead ? 0.35 *', (v) => `const robustWeight = lookahead ? ${num(v)} *`]] },
  // Hero's bet sizes on the flop and turn (and the river when the river solver doesn't run), x pot.
  betSizes: { def: [0.33, 0.5, 0.75, 1, 1.5], edits: [['const fracs = street === 0 ? [0.75, 1, 1.5] : [0.33, 0.5, 0.75, 1, 1.5];', (v) => `const fracs = street === 0 ? [0.75, 1, 1.5] : ${list(v)};`]] },
  // Hero's raise sizes after the flop, x (pot + call), added to the call.
  raiseSizes: { def: [0.6, 1], edits: [[' : [0.6, 1];', (v) => ` : ${list(v)};`]] },
  // Hero's preflop raise sizes facing a bet (limps, opens, 3-bets), same units.
  preRaiseSizes: { def: [0.6, 1, 1.6], edits: [['const fracs = street === 0 ? [0.6, 1, 1.6] :', (v) => `const fracs = street === 0 ? ${list(v)} :`]] },
  // River solver: hero's bet sizes x pot (at most 3: a node has at most 4 actions).
  riverSizes: { def: [0.33, 0.66, 1], edits: [['const fracs = player === 0 ? [0.33, 0.66, 1] : [oppBetFrac];', (v) => { if (v.length > 3) throw new Error('riverSizes: at most 3'); return `const fracs = player === 0 ? ${list(v)} : [oppBetFrac];`; }]] },
  // Shove threshold preflop: all-in is an option at [stack <= v[0] big blinds] or [stack <= v[1] x (pot + call)].
  shovePre: { def: [25, 3], edits: [['? stack <= 25 * bigBlind || stack <= 3 * (pot + toCall)', (v) => `? stack <= ${num(v[0])} * bigBlind || stack <= ${num(v[1])} * (pot + toCall)`]] },
  // Shove threshold after the flop: all-in is an option at stack <= v x (pot + call).
  shovePost: { def: 2.5, edits: [[': stack <= 2.5 * (pot + toCall));', (v) => `: stack <= ${num(v)} * (pot + toCall));`]] },
  // Hero's story: the fold-rate shift from a strong-looking line, times v (0 = off).
  cred: { def: 1, edits: [['const shift = clamp(0.4 * credibility, -0.08, 0.08);', (v) => `const shift = clamp(${num(0.4 * v)} * credibility, ${num(-0.08 * v)}, ${num(0.08 * v)});`]] },
  // Lookahead: hero raises a bet with at least this equity against the betting range (both playOut and playOutMulti).
  raiseEq: { def: 0.8, count: 2, edits: [['eq >= 0.8 && left > B', (v) => `eq >= ${num(v)} && left > B`]] },
};

function applyKnobs(code, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const knob = KNOBS[k];
    if (!knob) throw new Error(`unknown knob ${k} (have ${Object.keys(KNOBS).join(', ')})`);
    for (const [find, make] of knob.edits) {
      const n = code.split(find).length - 1;
      if (n !== (knob.count || 1)) throw new Error(`knob ${k}: expected ${knob.count || 1} match(es) of ${JSON.stringify(find)} in engine.js, found ${n}`);
      code = code.split(find).join(make(v));
    }
  }
  return code;
}

// A copy of srcDir with the knobs applied to engine.js; the same patch on the same source reuses one directory.
function patchedSrc(srcDir, patch, outRoot) {
  if (!patch || !Object.keys(patch).length) return srcDir;
  const code = fs.readFileSync(path.join(srcDir, 'engine.js'), 'utf8');
  const out = applyKnobs(code, patch);
  // The copy is keyed by every file it copies, so a changed tracker.js or blueprint.js makes a new one.
  const hash = crypto.createHash('sha1');
  for (const f of fs.readdirSync(srcDir).sort()) {
    const p = path.join(srcDir, f);
    if (fs.statSync(p).isFile()) hash.update(f + '\0').update(fs.readFileSync(p));
  }
  const h = hash.update(JSON.stringify(patch)).digest('hex').slice(0, 12);
  const dir = path.join(outRoot, h, 'src');
  if (!fs.existsSync(path.join(dir, 'engine.js'))) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      const p = path.join(srcDir, f);
      if (f !== 'engine.js' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f));
    }
    // engine.js last, so a copy cut off halfway is redone.
    fs.writeFileSync(path.join(dir, 'engine.js.tmp'), out);
    fs.renameSync(path.join(dir, 'engine.js.tmp'), path.join(dir, 'engine.js'));
  }
  return dir;
}

module.exports = { KNOBS, applyKnobs, patchedSrc };
