// One line per finished run: node test/sim/report.js test/out/sim-*.json
'use strict';
const fs = require('fs');
const label = (v) => (v.agent === 'solver' ? (Object.keys(v.solver || {}).length ? JSON.stringify(v.solver) : 'solver') : v.agent) + (v.ref && v.ref !== 'working tree' ? '@' + v.ref : '');
for (const f of process.argv.slice(2)) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  const s = j.sum || j;
  if (!s.variants) continue;
  const A = s.variants.A, B = s.variants.B;
  const head = `${f.replace(/^.*sim-|\.json$/g, '')}: ${s.players}p ${s.bots} ${s.stackBB}bb, ${s.deals} deals`;
  if (!B) { console.log(`${head} | ${label(A)} ${A.aivatBB100} ± ${A.aivatSE100} bb/100 (raw ${A.bb100} ± ${A.se100})`); continue; }
  console.log(`${head} | A ${label(A)} ${A.aivatBB100} ± ${A.aivatSE100} | B ${label(B)} ${B.aivatBB100} ± ${B.aivatSE100} | B-A ${s.diff.aivatBB100} ± ${s.diff.aivatSE100} (raw ${s.diff['B-A bb100']} ± ${s.diff.se100})`);
}
