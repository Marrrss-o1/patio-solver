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
  if ((h.log || []).filter((x) => x.st === 'pre' && (x.act === 'raise' || x.act === '3bet')).length >= 3) add('pot re-raised preflop', h);
  if ((h.log || []).some((x, i, l) => x.hero && x.act !== 'fold' && x.facing > 0 && x.st !== 'pre' && x.facing <= 0.3 * (x.pot - x.facing))) add('faced a tiny bet (<30%)', h);
  const adv = (h.advice || []).filter((a) => a.followed != null);
  if (adv.length && adv.every((a) => a.followed)) add('followed all advice', h);
  if (adv.some((a) => a.followed === false)) add('went against advice', h);
}
console.log(`${hands.length} hands, ${withNet} with a result`);
for (const [k, g] of Object.entries(groups)) console.log(`${k.padEnd(24)} ${String(g.n).padStart(4)} hands  ${(g.bb / g.n).toFixed(1).padStart(7)} bb/hand  ${g.bb.toFixed(0).padStart(6)} bb total`);
// Bets and raises made at a different size than advised (sizeRatio is in logs from v1.4.1).
const sized = hands.flatMap((h) => (h.advice || []).filter((a) => a.sizeRatio != null));
if (sized.length) {
  const off = sized.filter((a) => a.sizeRatio < 0.7 || a.sizeRatio > 1.4);
  console.log(`bets/raises at the advised size: ${sized.length - off.length} of ${sized.length}` + (off.length ? `; much smaller: ${off.filter((a) => a.sizeRatio < 0.7).length}, much bigger: ${off.filter((a) => a.sizeRatio > 1.4).length}` : ''));
}
// The last hand of a session has no result yet (it comes from the next hand's stacks).
for (const h of hands) if (h.heroNetBB == null && h.log) {
  const put = h.log.filter((x) => x.hero).reduce((a, x) => a + (x.amt || 0), 0);
  console.log(`no result yet: ${h.hero.join(' ')} on ${h.board.join(' ') || 'no board'}, hero put in ${Math.round(put / h.bigBlind)} bb`);
}
// Biggest losses, to start the hand-by-hand review (node test/replay-log.js <log> <hand numbers>).
const worst = hands.map((h, i) => ({ h, i })).filter((x) => x.h.heroNetBB < 0).sort((a, b) => a.h.heroNetBB - b.h.heroNetBB).slice(0, 5);
if (worst.length) console.log('biggest losses: ' + worst.map(({ h, i }) => `#${i} ${h.hero.join('')} ${h.heroNetBB}bb`).join(', '));
