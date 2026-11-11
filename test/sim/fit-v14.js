// Fits the v14 bots' hero-facing shifts (bots.js cutShift, riverAbsShift, pfContShift, heroRR) offline, from the bots' own
// (bots.js BOT_DUMP lines from simulated hands) and the real hand logs, so that the bots answer bets and preflop raises
// the way the friends do in the table check (test/sim/table-check.js rows A and C):
//   cutShift.hero.{hu,mw}[size]    answers to hero's first flop and turn bets (fold share), by heads-up / multiway at the
//                                  bet and size (under 45%, 45-85%, 85%+ of the pot)
//   cutShift.others.{hu,mw}[size]  answers to anyone else's first bet, flop to river
//   riverAbsShift[size]            answers to hero's river bets (the heroRiverAbs rule decides those)
//   pfContShift.{open,limp}[b]     answers to hero's first raise before the flop (fold share), an open or a raise over
//                                  limpers, by raise-to (b: up to 2.5bb, 3.5, 5, 8, more)
//   heroRR[b]                      re-raises of hero's first raise before the flop (share of answers), by raise-to
// Each shift moves the bots' continue cut (or re-raise share) until the bots' fold (re-raise) share over the dumped
// decisions equals the friends' share; dumps of several table sizes are weighted to the logs' mix.
// Usage: node test/sim/fit-v14.js --real <logs...> --dump <n>:<dump.jsonl>:<entries.json> ... [--base <profiles.json>]
//        node test/sim/fit-v14.js --by-size --real <logs...> --dump <n>:<dump.jsonl> ... [--base profiles-v14r.json]
//          (v15: pfContShiftN, answers to hero's first preflop raise by table size; see fitBySize)
//   (n = the table size of that dump; entries = that run's fold-cal --entries file, for its measured hand count)
// Prints the fitted shifts, the real and simulated shares before and after, and with --out writes a profiles file
// (the base profiles with the shifts set on every bot but `hero`). Dumps hold measured hands only (game.js marks the
// played decisions of non-warm-up hands), so the bots answer the solver there, as in the runs the bots are for.
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { loadHands } = require(path.join(ROOT, 'test/merge-logs.js'));

const args = process.argv.slice(2);
const list = (name) => { const i = args.indexOf('--' + name); if (i < 0) return []; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); return out; };
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const BK = (f) => (f < 0.45 ? 0 : f < 0.85 ? 1 : 2);
const isRaise = (a) => a === 'raise' || a === '3bet' || a === '4bet' || a === '5bet';
const PB = (toBB) => (toBB <= 2.5 ? 0 : toBB <= 3.5 ? 1 : toBB <= 5 ? 2 : toBB <= 8 ? 3 : 4); // bots.js pfBucket

// ---------- real targets ----------
function realTargets(hands, sizes) {
  const T = {}; // key -> { n, k }
  const add = (key, yes) => { const t = T[key] || (T[key] = { n: 0, k: 0 }); t.n++; if (yes) t.k++; };
  for (const h of hands) {
    if (!h.log || !h.players || !h.players.some((p) => p.hero)) continue;
    const n = h.players.length;
    if (!sizes.includes(n)) continue;
    const log = h.log.filter((x) => x.act);
    const bb = h.bigBlind || 2;
    const folded = new Set();
    let raisedPre = false, limpers = 0;
    for (let i = 0; i < log.length; i++) {
      const x = log[i];
      if (x.act === 'sb' || x.act === 'bb') continue;
      const live = h.players.filter((p) => !folded.has(p.name)).length;
      if (x.st === 'pre' && !raisedPre && isRaise(x.act)) {
        raisedPre = true;
        if (x.hero) {
          const pb = PB((x.to != null ? x.to : x.amt) / bb), kind = limpers ? 'limp' : 'open';
          for (let j = i + 1; j < log.length && log[j].st === 'pre'; j++) {
            const y = log[j];
            if (y.who === x.who) break;
            if (!['fold', 'call'].includes(y.act) && !isRaise(y.act)) continue;
            add(`pf.${kind}.${pb}`, y.act === 'fold');
            add(`pf.${kind}.${pb}.n${Math.min(5, n)}`, y.act === 'fold'); // by table size (--by-size)
            add(`rr.${pb}`, isRaise(y.act));
            if (isRaise(y.act)) break;
          }
        }
      } else if (x.st === 'pre' && !raisedPre && x.act === 'call') limpers++;
      if (['flop', 'turn', 'river'].includes(x.st) && x.act === 'bet' && x.potPct != null) {
        const hu = live === 2 ? 'hu' : 'mw', b = BK(x.potPct / 100);
        const key = x.hero ? (x.st === 'river' ? `abs.${b}` : `hero.${hu}.${b}`) : `others.${hu}.${b}`;
        for (let j = i + 1; j < log.length && log[j].st === x.st; j++) {
          const y = log[j];
          if (y.who === x.who) break;
          if (y.hero) continue;
          if (!['fold', 'call'].includes(y.act) && !isRaise(y.act)) continue;
          add(key, y.act === 'fold');
          if (isRaise(y.act)) break;
        }
      }
      if (x.act === 'fold') folded.add(x.who);
    }
  }
  return T;
}

// ---------- dumped bot decisions ----------
function foldWith(d, shift) {
  let pc = sig((d.hpC - d.tc - shift) / d.wc);
  pc = Math.max(pc, d.floor || 0);
  if (d.commit) { const fo = clamp(1 - pc, 1e-4, 1 - 1e-4), m = Math.exp(d.commit); pc = 1 - (fo * m) / (fo * m + 1 - fo); }
  if (d.abs) pc = d.absFloor ? Math.max(pc, sig((d.hp - d.absT) / d.absW)) : sig((d.hp - d.absT) / d.absW);
  return (1 - pc) * (1 - (d.pRb || 0));
}
function foldAbs(d, shift) {
  let pc = sig((d.hpC - d.tc) / d.wc);
  pc = Math.max(pc, d.floor || 0);
  if (d.commit) { const fo = clamp(1 - pc, 1e-4, 1 - 1e-4), m = Math.exp(d.commit); pc = 1 - (fo * m) / (fo * m + 1 - fo); }
  const a = sig((d.hp - d.absT - shift) / d.absW);
  pc = d.absFloor ? Math.max(pc, a) : a;
  return (1 - pc) * (1 - (d.pRb || 0));
}
// preflop: cs = the continuing share's shift, m = the re-raise multiplier (bots.js facing a raise)
function pfCont(d, cs) { const cont = cs ? clamp(d.cont + cs, 0.02, 0.97) : d.cont; return { cont, pCont: sig((cont - d.pct) / d.w) }; }
function pfFold(d, cs) { return 1 - pfCont(d, cs).pCont; }
function rrWith(d, m, cs) {
  const { cont, pCont } = pfCont(d, cs || 0);
  const tb = clamp(d.tb0 * m, 0.003, cont);
  const tbN = d.J > 0 ? Math.max(0.003, tb - d.J) : tb;
  return Math.min(pCont, sig((tbN - d.pct) / (d.w * 0.7)));
}
const pbOf = (d) => (d.pb != null ? d.pb : PB(d.toBB));
function cellOf(d) {
  if (d.pf) return d.hero ? `pf.${d.limpers > 0 ? 'limp' : 'open'}.${pbOf(d)}` : null;
  const hu = d.hu ? 'hu' : 'mw';
  if (d.hero) return d.abs ? `abs.${d.b}` : d.st === 5 ? null : `hero.${hu}.${d.b}`;
  return `others.${hu}.${d.b}`;
}

function solve(fn, target, lo, hi) {
  // fn increasing in x
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (fn(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// --by-size (v15): pfContShiftN, a shift per table size on top of the base profiles' pfContShift, fitted on dumps of bots
// that already play with it (each dump is one table size). A size's target is its own friends' fold share shrunk toward
// the share at every size by --k (20) answers, so a thin cell ends at the pooled share v14 was fitted to.
function fitBySize(dumps, T, K, minN) {
  const fit = {}, rows = [];
  const cells = {};
  for (const D of dumps) {
    const ns = Math.min(5, D.n);
    for (const ln of fs.readFileSync(D.dump, 'utf8').trim().split('\n')) {
      const d = JSON.parse(ln);
      if (!d.pf || !d.hero) continue;
      const key = `pf.${d.limpers > 0 ? 'limp' : 'open'}.${pbOf(d)}`;
      (cells[key + '.n' + ns] || (cells[key + '.n' + ns] = [])).push(d);
    }
  }
  for (const key of Object.keys(cells).sort()) {
    const arr = cells[key];
    const [, kind, b, nn] = key.split('.');
    const ns = nn.slice(1);
    const all = T[`pf.${kind}.${b}`], t = T[key] || { n: 0, k: 0 };
    if (!all) { rows.push(`${key.padEnd(16)} no real answers at any size, left at 0`); continue; }
    // a size the friends hardly met (or the bots hardly played) keeps v14's pooled shift: the pooled share there is
    // mostly other table sizes' answers
    if (t.n < minN || arr.length < 30) { rows.push(`${key.padEnd(16)} real ${t.k}/${t.n}, ${arr.length} bot decisions: too few, left at 0`); continue; }
    const pAll = all.k / all.n;
    const target = (t.k + K * pAll) / (t.n + K);
    const mean = (f) => arr.reduce((a, d) => a + f(d), 0) / arr.length;
    const before = mean((d) => pfFold(d, 0));
    const x = solve((c) => -mean((d) => pfFold(d, c)), -target, -0.5, 0.5);
    const xr = Math.round(x * 1000) / 1000;
    const S = fit[ns] || (fit[ns] = { open: [0, 0, 0, 0, 0], limp: [0, 0, 0, 0, 0] });
    S[kind][+b] = xr;
    rows.push(`${key.padEnd(16)} real ${t.n ? (t.k / t.n).toFixed(3) : '  -  '} (${t.n}), all sizes ${pAll.toFixed(3)} (${all.n}), target ${target.toFixed(3)}  bots ${before.toFixed(3)} (${arr.length}) -> ${mean((d) => pfFold(d, xr)).toFixed(3)}  shift ${xr >= 0 ? '+' : ''}${xr}`);
  }
  return { fit, rows };
}

if (require.main === module && args.includes('--by-size')) {
  const dumps = list('dump').map((s) => { const [n, d] = s.split(':'); return { n: +n, dump: d }; });
  const real = loadHands(list('real'), { quiet: true });
  const T = realTargets(real, [2, 3, 4, 5]);
  const prev = opt('prev', null); // add onto an earlier pfContShiftN (a second pass on dumps of bots playing with it)
  const { fit, rows } = fitBySize(dumps, T, +opt('k', 20), +opt('min', 10));
  console.log(rows.join('\n'));
  const base = JSON.parse(fs.readFileSync(opt('base', path.join(ROOT, 'test/sim/profiles-v14r.json')), 'utf8'));
  const anyP = Object.values(base).map((p) => p.params || p).find((P) => P.pfContShiftN);
  const was = prev ? JSON.parse(prev) : anyP ? anyP.pfContShiftN : null;
  if (was) for (const ns of Object.keys(fit)) for (const kind of ['open', 'limp']) for (let b = 0; b < 5; b++) {
    fit[ns][kind][b] = Math.round(((was[ns] && was[ns][kind][b]) || 0) * 1000 + fit[ns][kind][b] * 1000) / 1000;
  }
  console.log(JSON.stringify(fit));
  const out = opt('out', null);
  if (out) {
    for (const id of Object.keys(base)) { if (id === 'hero') continue; const P = base[id].params || base[id]; P.pfContShiftN = JSON.parse(JSON.stringify(fit)); }
    fs.writeFileSync(out, JSON.stringify(base, null, 1));
    console.log('wrote ' + out);
  }
} else if (require.main === module) {
  const dumps = list('dump').map((s) => { const [n, d, e] = s.split(':'); return { n: +n, dump: d, entries: e }; });
  const sizes = dumps.map((d) => d.n);
  const real = loadHands(list('real'), { quiet: true });
  const rc = {};
  for (const h of real) if (h.players && h.players.some((p) => p.hero)) rc[h.players.length] = (rc[h.players.length] || 0) + 1;
  const T = realTargets(real, sizes);
  const cells = {};
  for (const D of dumps) {
    const measured = JSON.parse(fs.readFileSync(D.entries, 'utf8')).length;
    const lines = fs.readFileSync(D.dump, 'utf8').trim().split('\n');
    const w = (rc[D.n] || 0) / measured;
    for (const ln of lines) {
      const d = JSON.parse(ln);
      const c = cellOf(d);
      if (!c) continue;
      d.wt = w;
      (cells[c] || (cells[c] = [])).push(d);
    }
  }
  const mean = (arr, f) => { let s = 0, ws = 0; for (const d of arr) { s += d.wt * f(d); ws += d.wt; } return s / ws; };
  const fit = { cutShift: { hero: { hu: [0, 0, 0], mw: [0, 0, 0] }, others: { hu: [0, 0, 0], mw: [0, 0, 0] } }, riverAbsShift: [0, 0, 0],
    pfContShift: { open: [0, 0, 0, 0, 0], limp: [0, 0, 0, 0, 0] }, heroRR: [1, 1, 1, 1, 1] };
  const rows = [];
  const minN = +opt('min', 20);
  for (const key of Object.keys(cells).sort()) {
    const t = T[key];
    const arr = cells[key];
    if (!t || t.n < minN) { rows.push(`${key.padEnd(14)} real ${t ? t.k + '/' + t.n : '-'}: too few, left at 0`); continue; }
    // shrink the target toward the bots' own share by a 10-answer prior, so thin cells move less
    const p = t.k / t.n;
    if (key.startsWith('pf.')) {
      // fold share by the continuing share's shift (fold falls as the shift grows)
      const [, kind, b] = key.split('.');
      const before = mean(arr, (d) => pfFold(d, 0));
      const target = (t.k + 10 * before) / (t.n + 10);
      const x = solve((c) => -mean(arr, (d) => pfFold(d, c)), -target, -0.5, 0.5);
      const xr = Math.round(x * 1000) / 1000;
      fit.pfContShift[kind][+b] = xr;
      rows.push(`${key.padEnd(14)} real ${p.toFixed(3)} (${t.n})  bots ${before.toFixed(3)} (${arr.length} decisions) -> ${mean(arr, (d) => pfFold(d, xr)).toFixed(3)}  shift ${xr >= 0 ? '+' : ''}${xr}`);
      continue;
    }
    const isAbs = key.startsWith('abs.');
    const f0 = (x) => mean(arr, (d) => (isAbs ? foldAbs(d, x) : foldWith(d, x)));
    const before = f0(0);
    const target = (t.k + 10 * before) / (t.n + 10);
    const x = solve(f0, target, -0.6, 0.6);
    const xr = Math.round(x * 1000) / 1000;
    if (isAbs) fit.riverAbsShift[+key.split('.')[1]] = xr;
    else { const [who, hu, b] = key.split('.'); fit.cutShift[who][hu][+b] = xr; }
    rows.push(`${key.padEnd(14)} real ${p.toFixed(3)} (${t.n})  bots ${before.toFixed(3)} (${arr.length} decisions) -> ${f0(x).toFixed(3)}  shift ${xr >= 0 ? '+' : ''}${xr}`);
  }
  // re-raises of hero's first raise by raise-to, on top of the fitted continuing shares
  for (let b = 0; b < 5; b++) {
    const key = `rr.${b}`, t = T[key];
    const arr = [].concat(cells[`pf.open.${b}`] || [], cells[`pf.limp.${b}`] || []);
    const cs = (d) => fit.pfContShift[d.limpers > 0 ? 'limp' : 'open'][b];
    if (!arr.length) continue;
    if (!t || t.n < minN) { rows.push(`${key.padEnd(14)} real ${t ? t.k + '/' + t.n : '-'}: too few, left at 1`); continue; }
    const p = t.k / t.n;
    const before = mean(arr, (d) => rrWith(d, 1, cs(d)));
    // re-raises are rare: a cell where the bots would re-raise under 5 times in the real number of answers can't tell
    if (before * t.n < 5) { rows.push(`${key.padEnd(14)} real ${t.k}/${t.n}, bots ${before.toFixed(3)}: too few expected, left at 1`); continue; }
    const target = (t.k + 10 * before) / (t.n + 10);
    const m = solve((x) => mean(arr, (d) => rrWith(d, x, cs(d))), target, 0.02, 3);
    fit.heroRR[b] = Math.round(m * 1000) / 1000;
    rows.push(`${key.padEnd(14)} real ${p.toFixed(3)} (${t.n})  bots ${mean(arr, (d) => rrWith(d, 1, 0)).toFixed(3)} -> ${mean(arr, (d) => rrWith(d, m, cs(d))).toFixed(3)}  heroRR ${fit.heroRR[b]}`);
  }
  console.log('real hands by table size: ' + JSON.stringify(rc) + '; dumps: ' + sizes.join(', '));
  console.log(rows.join('\n'));
  console.log(JSON.stringify(fit));
  const out = opt('out', null);
  if (out) {
    const base = JSON.parse(fs.readFileSync(opt('base', path.join(ROOT, 'test/sim/profiles-v12r.json')), 'utf8'));
    for (const id of Object.keys(base)) {
      if (id === 'hero') continue; // the hero profile is never seated (run.js lineup, --bot-params skip it too)
      const prof = base[id];
      const P = prof.params || prof;
      Object.assign(P, JSON.parse(JSON.stringify(fit)));
    }
    fs.writeFileSync(out, JSON.stringify(base, null, 1));
    console.log('wrote ' + out);
  }
}

module.exports = { realTargets, foldWith, foldAbs, rrWith, pfFold };
