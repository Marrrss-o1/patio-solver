// Do players fold by absolute strength or by strength within their own range? Replays hand-log entries through the
// sim's hand engine with puppet seats that repeat the logged actions, and at every answer to a bet after the flop
// rebuilds the answerer's range with a reference bot's policy (the pooled friend bot of --ref) along the answerer's own
// line. Then fits fold on bet size, street, heads-up, re-raised, pot size and the range's mean made-hand percentile,
// and prints the fold share by range-strength tercile (bets of 25-110% pot). Absolute-strength players fold far more
// with weak ranges; range-relative ones about the same.
//
//   node test/sim/range-test.js <export.json> [--ref test/sim/profiles-v8.json] [--rows out.json]
//   node test/sim/range-test.js --bots test/sim/profiles-v8.json --hands 2500 [--ref ...]   (bots against each other,
//        4-handed with the hero bot, like validate.js)
'use strict';
const fs = require('fs');
const path = require('path');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');
const E = require('../../src/engine.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const refProf = JSON.parse(fs.readFileSync(opt('ref', path.join(__dirname, 'profiles-v8.json')), 'utf8'));
// The yardstick: the pooled friend bot with absolute strength (its range is what any reader would build from the line).
const ref = bots.homeBot(Object.assign({}, refProf.pool.params, { rel: 0, relBet: 0 }));

function botHands(profFile, N) {
  const profiles = JSON.parse(fs.readFileSync(profFile, 'utf8'));
  const ids = Object.keys(profiles).filter((id) => id !== 'hero');
  const hero = profiles.hero ? bots.homeBot(profiles.hero.params) : bots.baseline();
  const out = [];
  for (let blk = 0; blk < Math.ceil(N / 100); blk++) {
    const order = ids.map((id, i) => [keyed(blk, i, 4711), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 3);
    const seats = [hero].concat(order.map((id) => bots.homeBot(profiles[id].params)));
    for (let h = 0; h < 100 && out.length < N; h++) {
      const d = blk * 100 + h, deck = shuffled((d * 2654435761 + 12345) >>> 0);
      const hands = []; for (let i = 0; i < 4; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
      out.push(playHand({ n: 4, btn: d % 4, hands, boardAll: deck.slice(8, 13), stacks: [300, 300, 300, 300], sb: 1, bb: 2, seats, hero: 0, names: ['hero'].concat(order), seed: (d * 40503 + 7) >>> 0, log: true }).entry);
    }
  }
  return out;
}

const KIND = { fold: 'fold', check: 'check', call: 'call', bet: 'raise', raise: 'raise', '3bet': 'raise' };
const STN = { 0: 'pre', 3: 'flop', 4: 'turn', 5: 'river' };
function answers(H) {
  const rows = []; let ok = 0, bad = 0;
  for (const [hi, h] of H.entries()) {
    const log = (h.log || []).filter((e) => e.act);
    const sbE = log.find((e) => e.act === 'sb'), bbE = log.find((e) => e.act === 'bb');
    if (!sbE || !bbE) { bad++; continue; }
    // Seats in table order from the small blind (the order of the preflop log); the button sits before it.
    const order = [sbE.who, bbE.who];
    for (const e of log) if (e.st === 'pre' && !order.includes(e.who)) order.push(e.who);
    const n = order.length, btn = n === 2 ? 0 : n - 1;
    const P = order.map((nm) => h.players.find((p) => p.name === nm));
    if (n < 2 || P.some((p) => !p || !(p.stack > 0))) { bad++; continue; }
    // Unknown hole cards are dealt at random (the range rebuild never looks at them).
    const parse = (l) => (l && l.length === 2 ? l.map(E.parseCard) : null);
    const board = (h.board || []).map(E.parseCard), used = new Set(board);
    const known = P.map((p) => (p.hero ? parse(h.hero) : parse(p.shown)));
    for (const k of known) if (k) k.forEach((c) => used.add(c));
    const deck = shuffled(hi * 977 + 5).filter((c) => !used.has(c));
    const hands = known.map((k) => k || [deck.pop(), deck.pop()]);
    const boardAll = board.concat(deck.splice(0, 5 - board.length));
    const queue = P.map((p) => log.filter((e) => e.who === p.name && e.act !== 'sb' && e.act !== 'bb'));
    // Raises before the flop (0: limped or checked, 1: one raise, 2: re-raised).
    const pfRaises = log.filter((e) => e.st === 'pre' && KIND[e.act] === 'raise').length;
    // The last raiser before the flop (a bet by them after the flop is a continuation bet).
    const pfAgg = (log.filter((e) => e.st === 'pre' && KIND[e.act] === 'raise').pop() || {}).who || null;
    const mine = [];
    let fail = false;
    const seats = P.map((p, i) => ({ rangeAware: true, policy(v) {
      const e = queue[i].shift(), st = STN[v.street];
      if (!e || e.st !== st) { fail = true; return [{ t: v.toCall > 0 ? 'fold' : 'check', p: 1 }]; }
      if (v.street > 0 && v.toCall > 0 && !p.hero && KIND[e.act] !== 'check') {
        const W = ref.rangeBefore(v), tbl = bots.boardTable(v.board);
        let tot = 0, m = 0; for (const k of tbl.live) if (W[k] > 0) { tot += W[k]; m += W[k] * tbl.hp[k]; }
        // Who made the bet being answered (the last bet or raise before this answer on the street).
        const at = log.indexOf(e);
        let bettor = null; for (let j = at - 1; j >= 0 && log[j].st === st; j--) if (KIND[log[j].act] === 'raise') { bettor = log[j].who; break; }
        const bp = bettor && h.players.find((x) => x.name === bettor);
        mine.push({ st, fold: e.act === 'fold' ? 1 : 0, f: v.toCall / Math.max(1, v.pot - v.toCall), hu: v.nOpp === 1, raised: v.raises >= 2,
          own: (v.seq[st] || []).some((x) => x === 'bet' || x === 'raise'), rangeHp: m / tot, potBB: v.pot / v.bb,
          pf: pfRaises, vsHero: !!(bp && bp.hero), checked: (v.seq[st] || []).includes('check'), cb: !!bettor && bettor === pfAgg });
      }
      return [{ t: KIND[e.act], to: e.to, p: 1 }];
    } }));
    try { playHand({ n, btn, hands, boardAll, stacks: P.map((p) => p.stack), sb: sbE.amt, bb: h.bigBlind || bbE.amt, seats, hero: 0, seed: hi + 1 }); } catch (err) { fail = true; }
    if (fail || queue.some((q) => q.length)) { bad++; continue; }
    ok++; rows.push(...mine);
  }
  return { rows, ok, bad };
}

const sg = (x) => 1 / (1 + Math.exp(-x));
function logit(s, cols) {
  const k = cols.length; let b = new Array(k).fill(0);
  for (let it = 0; it < 60; it++) {
    const g = new Array(k).fill(0), Hm = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const x of s) { const X = cols.map((c) => c(x)); const q = sg(X.reduce((a, v, i) => a + v * b[i], 0)), w = q * (1 - q); for (let i = 0; i < k; i++) { g[i] += (x.fold - q) * X[i]; for (let j = 0; j < k; j++) Hm[i][j] += w * X[i] * X[j]; } }
    const M = Hm.map((r, i) => r.concat([g[i]], Hm.map((_, j) => (i === j ? 1 : 0))));
    for (let i = 0; i < k; i++) {
      let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      [M[i], M[p]] = [M[p], M[i]]; const t0 = M[i][i];
      for (let c = 0; c < M[i].length; c++) M[i][c] /= t0;
      for (let r = 0; r < k; r++) if (r !== i) { const t = M[r][i]; for (let c = 0; c < M[r].length; c++) M[r][c] -= t * M[i][c]; }
    }
    const d = M.map((r) => r[k]); b = b.map((v, i) => v + d[i]);
    if (d.reduce((a, v) => a + Math.abs(v), 0) < 1e-9) return b.map((v, i) => [v, Math.sqrt(M[i][k + 1 + i])]);
  }
  return b.map((v) => [v, NaN]);
}
const COLS = [['const', () => 1], ['ln size', (x) => Math.log(Math.min(1.5, Math.max(0.1, x.f)) / 0.5)], ['turn', (x) => (x.st === 'turn' ? 1 : 0)],
  ['river', (x) => (x.st === 'river' ? 1 : 0)], ['heads-up', (x) => (x.hu ? 1 : 0)], ['re-raised', (x) => (x.raised ? 1 : 0)],
  ['ln pot/10bb', (x) => Math.log(Math.max(2, x.potBB) / 10)], ['range hp x10', (x) => (x.rangeHp - 0.5) * 10]];

const H = opt('bots', null) ? botHands(opt('bots'), +opt('hands', 2500)) : require('../merge-logs.js').loadHands(files);
const { rows, ok, bad } = answers(H);
if (opt('rows', null)) fs.writeFileSync(opt('rows'), JSON.stringify(rows));
const R = rows.filter((r) => !r.own);
console.log(`${ok} hands replayed (${bad} dropped), ${R.length} answers to bets (not re-raised after betting)`);
const b = logit(R, COLS.map((c) => c[1]));
console.log('fold log-odds: ' + COLS.map((c, i) => `${c[0]} ${b[i][0].toFixed(2)} ± ${b[i][1].toFixed(2)}`).join(', '));
const S = R.filter((r) => r.f >= 0.25 && r.f <= 1.1), qs = S.map((r) => r.rangeHp).sort((x, y) => x - y);
const t1 = qs[Math.floor(qs.length / 3)], t2 = qs[Math.floor((2 * qs.length) / 3)];
const g = (s) => (s.length ? `${(s.reduce((a, r) => a + r.fold, 0) / s.length).toFixed(2)} (n ${s.length})` : '-');
console.log(`bets of 25-110% pot, fold by the range's strength (mean percentile under ${t1.toFixed(2)} / ${t2.toFixed(2)} / above): ${g(S.filter((r) => r.rangeHp < t1))}, ${g(S.filter((r) => r.rangeHp >= t1 && r.rangeHp < t2))}, ${g(S.filter((r) => r.rangeHp >= t2))}`);
console.log(`same bets by pot (under 10bb / 10-20bb / 20bb+): ${g(S.filter((r) => r.potBB < 10))}, ${g(S.filter((r) => r.potBB >= 10 && r.potBB < 20))}, ${g(S.filter((r) => r.potBB >= 20))}`);
// River answers by how the pot was played before the flop (first answers to a bet, not re-raised after betting).
if (args.includes('--river')) {
  const RV = R.filter((r) => r.st === 'river' && !r.raised);
  const pfName = ['limped', 'raised', 're-raised'];
  console.log(`river first answers: ${g(RV)}; heads-up ${g(RV.filter((r) => r.hu))}, multiway ${g(RV.filter((r) => !r.hu))}; facing hero ${g(RV.filter((r) => r.vsHero))}`);
  for (let k = 0; k < 3; k++) {
    const P = RV.filter((r) => Math.min(2, r.pf) === k);
    const by = [[0, 0.45], [0.45, 0.85], [0.85, 99]].map(([lo, hi]) => g(P.filter((r) => r.f >= lo && r.f < hi))).join(' / ');
    console.log(`  ${pfName[k].padEnd(10)} ${g(P)}  by size (<45% / 45-85% / 85%+ pot) ${by}  HU ${g(P.filter((r) => r.hu))}  after checking ${g(P.filter((r) => r.checked))}  facing hero ${g(P.filter((r) => r.vsHero))}`);
  }
}
