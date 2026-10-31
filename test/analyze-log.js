// Summarizes an exported hand log: hero's results by kind of spot, and advice followed vs not.
// Usage: node test/analyze-log.js patio-hand-log.json
const fs = require('fs');
const hands = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const groups = {};
const add = (k, h) => { const g = groups[k] || (groups[k] = { n: 0, bb: 0 }); g.n++; g.bb += h.heroNetBB || 0; };
let withNet = 0;
for (const h of hands) {
  if (h.heroNetBB == null) continue;
  withNet++;
  add('all hands', h);
  const mine = (h.log || []).filter((x) => x.hero);
  const big = (x) => x.potPct != null && x.potPct >= 100;
  if (mine.some((x) => x.allin)) add('went all-in', h);
  if (mine.some((x) => x.st === 'river' && x.act === 'call')) add('called on the river', h);
  if (mine.some((x) => x.st === 'river' && (x.act === 'bet' || x.act === 'raise'))) add('bet/raised the river', h);
  if (mine.some(big)) add('bet pot or more', h);
  if (mine.some((x) => x.st === 'pre' && (x.act === 'raise' || x.act === '3bet'))) add('raised preflop', h);
  const adv = (h.advice || []).filter((a) => a.followed != null);
  if (adv.length && adv.every((a) => a.followed)) add('followed all advice', h);
  if (adv.some((a) => a.followed === false)) add('went against advice', h);
}
console.log(`${hands.length} hands, ${withNet} with a result`);
for (const [k, g] of Object.entries(groups)) console.log(`${k.padEnd(22)} ${String(g.n).padStart(4)} hands  ${(g.bb / g.n).toFixed(1).padStart(7)} bb/hand  ${g.bb.toFixed(0).padStart(6)} bb total`);
