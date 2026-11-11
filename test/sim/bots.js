// Simulated opponents. Every bot is a `policy(view)` that returns its action probabilities, so the
// AIVAT correction in game.js knows exactly what it could have done.
//
//  - legacy bots (station, typical, maniac): the old simulators' rule bots, unchanged in distribution.
//  - home bots: amateur model calibrated to Marwin's friends (profiles.json, see calibrate.js).
//    Loose preflop, limps, min-raise wars, small and min bets, sticky calls with any pair or draw.
// Plus `baseline`, the old "simple solid regular" agent used as the comparison hero.
'use strict';
const E = require('../../src/engine.js');
const { keyed, normalizeWith } = require('./game.js');
// Big preflop raises (to more than 30bb) get the logs' cliff (see the facing-a-raise rule below); BOTCLIFF=0 turns it off.
const BOT_CLIFF = process.env.BOTCLIFF !== '0';

const RANKS = '23456789TJQKA';
const ORDER = {}; E.PREFLOP_ORDER.forEach((nm, i) => { ORDER[nm] = i; });
const className = (h) => {
  const a = Math.max(h[0] >> 2, h[1] >> 2), b = Math.min(h[0] >> 2, h[1] >> 2);
  return a === b ? RANKS[a] + RANKS[b] : RANKS[a] + RANKS[b] + ((h[0] & 3) === (h[1] & 3) ? 's' : 'o');
};
// Old simulators' preflop strength: 1 = AA, by class order.
const pfStrength = (h) => 1 - ORDER[className(h)] / 168;
// Share of all combos that rank above this hand (0 = AA), the way ranges are counted.
const pfPct = (h) => E.describeHero(h, []).topPercent / 100;
const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Postflop strength, cached per hand and board: made-hand percentile and draws.
const postCache = new Map();
function post(h, board) {
  const key = h[0] * 52 + h[1] + ':' + board.join(',');
  let r = postCache.get(key);
  if (r) return r;
  const hp = E.handPercentile(h, board);
  let outs = 0;
  if (board.length < 5) for (const d of E.describeHero(h, board).draws || []) outs += d.outs;
  r = { hp, outs, drawy: board.length < 5 && (E.describeHero(h, board).draws || []).some((x) => x.outs >= 7) };
  if (postCache.size > 50000) postCache.clear();
  postCache.set(key, r);
  return r;
}

// ---------- v8: strength within the bot's own range ----------
// The v7 bots continue, bet and raise by absolute strength (made-hand percentile against all hands), so where their
// range is weak (hero's big bets after they checked, raises of their bluffy bets) they fold far more than their usual
// rate, and where it is strong they hardly fold. The friends don't (audit 4 Nov: big heads-up bets folded 49% by the
// friends, 81% by the bots, read 50-57%). With `rel` (calling and raising) and `relBet` (betting when checked to) a
// v8 bot rebuilds its own range from its line this hand (its own policy replayed over every combo, game.js `hist`),
// finds its hand's quantile q in that range, and plays as if it held the hand at quantile q of its usual range in
// that spot (`REF`, measured on the bots' own ranges): hp + rel x (REF(q) - hp). rel 0 is the v7 bot exactly.
const NC = 1326, CA = new Uint8Array(NC), CB = new Uint8Array(NC);
{ let k = 0; for (let a = 1; a < 52; a++) for (let b = 0; b < a; b++) { CA[k] = a; CB[k] = b; k++; } }
const cidx = (x, y) => (x > y ? (x * (x - 1)) / 2 + y : (y * (y - 1)) / 2 + x);
let PCT = null;
const pctOf = (k) => { if (!PCT) { PCT = new Float64Array(NC); for (let j = 0; j < NC; j++) PCT[j] = pfPct([CA[j], CB[j]]); } return PCT[k]; };
// Every combo's made-hand percentile (exactly handPercentile) and draw outs (as describeHero / post) on a board.
const tblCache = new Map();
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function boardTable(board) {
  const key = board.join(',');
  let t = tblCache.get(key);
  if (t) return t;
  const n = board.length, dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const hp = new Float64Array(NC).fill(-1), outs = new Uint8Array(NC), score = new Int32Array(NC);
  const buf = new Int32Array(8);
  for (let i = 0; i < n; i++) buf[i] = board[i];
  const live = [];
  const byCard = Array.from({ length: 52 }, () => []);
  for (let k = 0; k < NC; k++) {
    if (dead[CA[k]] || dead[CB[k]]) continue;
    buf[n] = CA[k]; buf[n + 1] = CB[k];
    score[k] = E.evaluate(buf, n + 2);
    live.push(k); byCard[CA[k]].push(k); byCard[CB[k]].push(k);
  }
  const sorted = Int32Array.from(live.map((k) => score[k])).sort();
  for (const k of live) {
    const sc = score[k];
    const lo = lowerBound(sorted, sc), hi = lowerBound(sorted, sc + 1);
    let below = lo, ties = hi - lo, total = live.length;
    for (const j of byCard[CA[k]]) { total--; if (score[j] < sc) below--; else if (score[j] === sc) ties--; }
    for (const j of byCard[CB[k]]) { if (j === k) continue; total--; if (score[j] < sc) below--; else if (score[j] === sc) ties--; }
    hp[k] = total ? (below + ties / 2) / total : 0.5;
  }
  if (n < 5) {
    const bo = new Int8Array(52);
    for (let x = 0; x < 52; x++) { if (dead[x]) continue; buf[n] = x; bo[x] = E.evaluate(buf, n + 1) >> 20; }
    for (const k of live) {
      const cat = score[k] >> 20;
      if (cat >= 5) continue;
      buf[n] = CA[k]; buf[n + 1] = CB[k];
      let fl = 0, sr = 0;
      for (let x = 0; x < 52; x++) {
        if (dead[x] || x === CA[k] || x === CB[k]) continue;
        buf[n + 2] = x;
        const c2 = E.evaluate(buf, n + 3) >> 20;
        if ((c2 === 5 || c2 === 8) && bo[x] < 5) fl++;
        else if (c2 === 4 && cat < 4 && bo[x] < 4) sr++;
      }
      outs[k] = (fl >= 7 ? fl : 0) + (sr >= 3 ? sr : 0);
    }
  }
  t = { hp, outs, live };
  if (tblCache.size > 400) tblCache.clear();
  tblCache.set(key, t);
  return t;
}
// Usual ranges: hp at quantiles 0, 0.05, ..., 1 of a bot's range, by street (flop, turn, river) and spot:
// open (checked to), face (facing a bet before betting or raising on the street), raised (re-raised after betting).
// Measured on the bots' own ranges by test/sim/v8-ref.js (test/sim/v8-ref.json; V8REF=<file> reads another).
const REF = (() => {
  try { return JSON.parse(require('fs').readFileSync(process.env.V8REF || require('path').join(__dirname, 'v8-ref.json'), 'utf8')); } catch (e) { return null; }
})();
const SPOTS = ['open', 'face', 'raised', 'openA', 'openC', 'openX'];
function refAt(st, spot, q) {
  const r = REF && REF[st] && REF[st][spot];
  if (!r) return q;
  const x = Math.max(0, Math.min(1, q)) * (r.length - 1), i = Math.min(r.length - 2, Math.floor(x)), f = x - i;
  return r[i] + f * (r[i + 1] - r[i]);
}
const spotOf = (v) => (v.toCall <= 0 ? 'open' : (v.seq[STREET_OF[v.street]] || []).some((x) => x === 'bet' || x === 'raise') ? 'raised' : 'face');
// Checked to, by the bot's own line on the street before (flop: preflop): A bet or raised, C only called, X neither.
const PREV_OF = { 3: 'pre', 4: 'flop', 5: 'turn' };
function openLine(v) {
  const pl = v.seq[PREV_OF[v.street]] || [];
  if (pl.some((x) => x === 'bet' || x === 'raise' || x === '3bet')) return 'openA';
  return pl.includes('call') ? 'openC' : 'openX';
}
// The REF entry a decision maps through: betting spots by line when the table has them (v8b), else 'open'.
const refSpot = (v) => { const s = spotOf(v); if (s !== 'open') return s; const l = openLine(v); return REF && REF[v.street - 3] && REF[v.street - 3][l] ? l : 'open'; };
// Each combo's quantile in range W by made-hand percentile on this board (ties split), live combos only.
function rangeQuantiles(W, tbl) {
  const L = tbl.live.filter((k) => W[k] > 0);
  L.sort((a, b) => tbl.hp[a] - tbl.hp[b]);
  const q = new Float64Array(NC).fill(0.5);
  let tot = 0; for (const k of L) tot += W[k];
  if (!(tot > 0)) return q;
  let cum = 0;
  for (let i = 0; i < L.length;) {
    let j = i, w = 0; const h = tbl.hp[L[i]];
    while (j < L.length && tbl.hp[L[j]] === h) { w += W[L[j]]; j++; }
    const qq = (cum + w / 2) / tot;
    for (let m = i; m < j; m++) q[L[m]] = qq;
    // Combos not in the range (weight 0) at this strength get the same quantile, so any hand has one.
    cum += w; i = j;
  }
  // Hands outside the range: the quantile their strength would have.
  const hs = L.map((k) => tbl.hp[k]), cw = []; { let c = 0; for (const k of L) { c += W[k]; cw.push(c); } }
  for (const k of tbl.live) {
    if (W[k] > 0) continue;
    const i = lowerBound(hs, tbl.hp[k]);
    q[k] = i ? cw[i - 1] / tot : 0;
  }
  return q;
}
// ---------- legacy bots ----------
const LEGACY = {
  station: { vpip: 0.35, pfRaise: 0.9, threebet: 0.95, callRaise: 0.4, betHp: 0.8, bluff: 0.06, raiseHp: 0.96, callBase: 0.3, callSlope: 0.1, drawCall: true },
  typical: { vpip: 0.5, pfRaise: 0.85, threebet: 0.94, callRaise: 0.55, betHp: 0.75, bluff: 0.15, raiseHp: 0.94, callBase: 0.45, callSlope: 0.25, drawCall: true },
  maniac: { vpip: 0.3, pfRaise: 0.6, threebet: 0.85, callRaise: 0.45, betHp: 0.6, bluff: 0.35, raiseHp: 0.85, callBase: 0.4, callSlope: 0.15, drawCall: true },
};
function legacyBot(cfg) {
  return {
    policy(v) {
      const h = v.hand, toCall = v.toCall, pot = v.pot, bb = v.bb;
      if (v.street === 0) {
        const s = pfStrength(h);
        if (v.raises === 0) {
          const passive = s > cfg.vpip ? (toCall ? 'call' : 'check') : (toCall ? 'fold' : 'check');
          if (s > cfg.pfRaise) return [{ t: 'raise', to: 3 * bb + bb * v.limpers, p: 0.7 }, { t: passive, p: 0.3 }];
          return [{ t: passive, p: 1 }];
        }
        const passive = s > cfg.callRaise || (toCall <= 3 * bb && s > cfg.callRaise - 0.15) ? 'call' : 'fold';
        if (s > cfg.threebet && v.raises < 3) return [{ t: 'raise', to: v.cur * 3, p: 0.6 }, { t: passive, p: 0.4 }];
        return [{ t: passive, p: 1 }];
      }
      const { hp, drawy } = post(h, v.board);
      const tight = 0.03 * Math.max(0, v.nOpp - 1);
      if (toCall === 0) {
        const pv = hp > cfg.betHp + tight ? 0.7 : 0, pb = cfg.bluff / Math.max(1, v.nOpp);
        const pBet = 1 - (1 - pv) * (1 - pb);
        // Old bots bet (0.5 + 0.3 * uniform) x pot: four equal slices of that range.
        const out = [0.5375, 0.6125, 0.6875, 0.7625].map((f) => ({ t: 'raise', to: Math.round(f * pot), p: pBet / 4 }));
        out.push({ t: 'check', p: 1 - pBet });
        return out;
      }
      const f = toCall / Math.max(1, pot - toCall);
      const passive = hp > cfg.callBase + tight + cfg.callSlope * Math.min(f, 2) || (cfg.drawCall && drawy && f < 1.2) ? 'call' : 'fold';
      if (hp > cfg.raiseHp && v.raises < 3) return [{ t: 'raise', to: v.cur * 3, p: 0.5 }, { t: passive, p: 0.5 }];
      return [{ t: passive, p: 1 }];
    },
  };
}

// ---------- baseline: a simple solid regular (the old simulators' comparison agent) ----------
function baseline() {
  return {
    act(v) {
      const h = v.hand, toCall = v.toCall, pot = v.pot, bb = v.bb;
      const r = () => keyed(v.rk, v.seat, 991, v.nAct);
      if (v.n === 2) {
        if (v.street === 0) {
          const s = pfStrength(h);
          if (v.raises === 0) {
            if (v.isBtn) return s > 0.45 ? { t: 'raise', to: 2.5 * bb } : { t: 'fold' };
            return s > 0.75 ? { t: 'raise', to: 3.5 * bb } : { t: 'check' };
          }
          if (s > 0.92 && v.raises < 3) return { t: 'raise', to: v.cur * 3 };
          if (s > 0.55 || (toCall <= 2 * bb && s > 0.4)) return { t: 'call' };
          return { t: 'fold' };
        }
        const { hp, drawy } = post(h, v.board);
        if (toCall === 0) {
          if (hp > 0.78 || (drawy && r() < 0.5) || (v.pfAgg === v.seat && v.street === 3 && r() < 0.6)) return { t: 'raise', to: Math.round(0.66 * pot) };
          return { t: 'check' };
        }
        const f = toCall / Math.max(1, pot - toCall);
        if (hp > 0.94 && v.raises < 3) return { t: 'raise', to: v.cur * 3 };
        if (hp > 0.5 + 0.12 * Math.min(f, 2) || (drawy && f < 0.9)) return { t: 'call' };
        return { t: 'fold' };
      }
      const late = v.pos === 'late';
      if (v.street === 0) {
        const s = pfStrength(h);
        if (v.raises === 0) {
          if (s > (late ? 0.55 : 0.7)) return { t: 'raise', to: 3 * bb + bb * v.limpers };
          if (toCall === 0) return { t: 'check' };
          return s > 0.5 && v.limpers > 0 ? { t: 'call' } : { t: 'fold' };
        }
        if (s > 0.92 && v.raises < 3) return { t: 'raise', to: v.cur * 3 };
        if (s > 0.62 || (toCall <= 2 * bb && s > 0.45)) return { t: 'call' };
        return { t: 'fold' };
      }
      const { hp, drawy } = post(h, v.board);
      const tight = 0.04 * Math.max(0, v.nOpp - 1);
      if (toCall === 0) {
        if (hp > 0.8 + tight || (drawy && r() < 0.4) || (v.pfAgg === v.seat && v.street === 3 && v.nOpp === 1 && r() < 0.6)) return { t: 'raise', to: Math.round(0.66 * pot) };
        return { t: 'check' };
      }
      const f = toCall / Math.max(1, pot - toCall);
      if (hp > 0.95 && v.raises < 3) return { t: 'raise', to: v.cur * 3 };
      if (hp > 0.55 + tight + 0.12 * Math.min(f, 2) || (drawy && f < 0.8)) return { t: 'call' };
      return { t: 'fold' };
    },
  };
}

// ---------- home bots ----------
// Parameters (fractions of hands unless noted). Calibrated per friend by calibrate.js.
const HOME_DEFAULT = {
  // Preflop
  vpip: 0.62,        // plays (limps or raises) this share of hands first in
  pfr: 0.15,         // open-raises this share first in
  cont: 0.6,         // continues vs one raise of ~3bb with this share of hands
  contElast: 0.45,   // ... shrinking as (3bb / raise)^contElast
  limpCont: 0.85,    // after limping, continues vs a ~3bb raise with hands up to limpCont x VPIP (fitted to limpers' folds)
  threeBet: 0.1,     // re-raises one raise with this share of hands
  cont3b: 0,         // after open-raising, continues vs a re-raise with hands up to PFR + this (opens are soft-edged)
  rrDecay: 0.55,     // each further raise multiplies the re-raise share by this
  callBig: 0.4,      // continues vs a raise of 8bb or more (or a shove) with this share
  openBB: 4.4,       // open size in big blinds (plus one per limper)
  openShove: 0,      // share of their open-raises that are all-in instead
  rrMin: 0.5,        // share of re-raises that are min-raises (min-raise wars); the rest ~2.2x
  rrShove: 0,        // share of re-raises that are all-in (before rrMin splits the rest)
  // Postflop, per street [flop, turn, river]; thresholds are made-hand percentiles vs all hands
  val: [0.78, 0.8, 0.8],      // value-bet threshold when checked to
  bluff: [0.12, 0.1, 0.12],   // bets with nothing (heads-up; divided by opponents)
  semi: 0.45,                 // bets a strong draw (8+ outs) when checked to
  slow: 0.25,                 // checks a monster (98th percentile+) instead of betting
  call: [0.5, 0.55, 0.6],     // continue threshold facing a half-pot bet
  callSlope: 0.12,            // threshold rise per 1x pot of bet size, up to sizeCap (fitted, pooled, to folds by size)
  sizeCap: 0.65,              // bets above this share of the pot fold no more often (real friends: flat from ~2/3 pot)
  drawCall: 0.85,             // continues a strong draw facing up to a pot-size bet
  raise: [0.9, 0.92, 0.93],   // raise threshold facing a bet
  raiseProb: 0.55,            // raises this often above the threshold
  bluffRaise: 0.04,           // raises with a draw or nothing
  callMw: null,               // facing a bet multiway: threshold shift [first to answer, last after folds, after a call] (fitted, pooled)
  callHu: 0,                  // facing a bet heads-up: threshold shift (fitted, pooled; profiles without it keep 0)
  reRaise: 1,                 // after betting or raising on the street and being raised: re-raise share x this (fitted, pooled)
  lineBet: null,              // checked to on the turn / river: log-odds shift of betting by their own line on the street before,
                              // [called turn, bet turn, called river, bet river] (fitted, pooled; friends who called rarely lead)
  betSize: 0.5,               // typical bet, fraction of the pot
  sizeTell: 0.6,              // bigger bets with stronger hands (log-size per strength)
  minBet: 0.15,               // share of bets that are one big blind
  raiseX: 2.2,                // postflop raise to this multiple of the bet
  raiseMin: 0,                // share of postflop raises that are min-raises
  raiseShove: 0,              // share of postflop raises that are all-in
  sizeSd: 0.3,                // spread of bet sizes (log scale) around their usual size
  potSlope: 0,                // log bet size per log pot size (friends: about -0.5, pot-size bets in small pots, small ones in big)
  cbet: 1.8,                  // bluff multiplier on the flop as the preflop raiser
  mw: 0.035,                  // thresholds rise this much per extra opponent
  w: 0.05,                    // softness of the betting thresholds
  wc: 0.05,                   // softness of calling: larger = calls with weaker hands and folds some better ones
  commit: 0,                  // facing a bet after the flop: fold odds x exp(commit x share of their stack already in)
  commitCut: 0,               // the same habit on the share that folds: the continue cut moves so that the fold share's odds
                              // scale by exp(commitCut x share in). `commit` scales each hand's odds, which moves the fold
                              // share only for hands near the cut (about a third of the read's change at the fitted width).
  pfCommit: 0,                // 1: preflop, chips in of a quarter of a big raise-to or more lift the cliff (see above)
  // Hero's big pots after a passive flop (v7 bots; all off by default). In the logs a friend who checked or called the
  // flop against hero and then put 15bb+ in shows a hand at 0.74 of the read's range (n 23), against 0.51 in pots
  // without hero and about 0.61 for the v6 bots. When hero is still in the hand, the bot did not bet or raise the flop
  // and its chips in would reach hpPut big blinds: facing a bet the continue cut moves up by hpCall, its softness wc is
  // multiplied by hpWc and the draw floor by hpDraw; checked to, bluffs and semi-bluffs are multiplied by hpBluff.
  // hpFlop: 1 applies it on the flop too (facing hero's flop bet; there "passive" means not yet aggressive).
  hpCall: 0, hpWc: 1, hpDraw: 1, hpBluff: 1, hpPut: 15, hpFlop: 0,
  // Big pots (v7): facing a bet with the pot at bigPot big blinds or more, the continue cut moves up by bigCall. The v6
  // bots fold to bets in 15bb+ pots 8-10 points less than main's read (twin logs, n 400-1,200 per run) where the friends
  // fold as the read says (0.434 vs 0.438 against each other, n 371; 0.495 vs 0.474 against hero, n 109).
  bigCall: 0, bigPot: 15,
  // v8 (see boardTable / REF above): strength within their own range for calls and raises (rel) and bets (relBet),
  // 0 = absolute strength as in v7; raisedCut moves the continue cut of a player re-raised after betting or raising on
  // the street (fitted, pooled: friends fold 19% there, v7 bots 33%).
  rel: 0, relBet: 0, raisedCut: 0,
  // v8: heads-up from the start of the street, the continue cut also moves by callHuLog x ln(size / 0.5) (sizes 0.1 to
  // 1.5 pot; fitted, pooled): friends answer a third-pot bet heads-up about like a 2/3-pot one (fold 33-44% from 0.28
  // to 0.9 pot), the v7 bots folded 22% to third-pot and 52% to 0.7-0.9 pot bets.
  callHuLog: 0,
  // v8: the continue cut also moves by potCall x ln(pot / 10bb) (fitted, pooled). At the same fraction of the pot friends
  // fold a little more in big pots (25-110% pot bets: 44% in pots under 10bb, 50% at 20bb+); range-relative bots don't.
  potCall: 0,
  heroRiverAbs: 0, heroRiverW: 0.02, heroRiverHU: 0,   // v9: answers to hero's river bets by absolute strength (0: off)
  heroRiverFloor: 0,   // v13: 1 = heroRiverAbs is a floor only (made hands call; the rest answer as read)
  jam: 0, jamK: 1.52, jamTop: 0.7, jamMax: 0.3,        // v10: wide all-in re-raises over one raise, by stack depth (0: off)
  heroHuCut: 0,                                       // v11: heads-up flop and turn answers to hero's bets fold more (0: off)
  leadHu: null,                                       // v12: [flop, turn] scale on heads-up leads into the aggressor (null: off)
  // v14 (table check, 11 Nov; null / 1: off). cutShift: answers to a first bet after the flop move the continue cut by
  // { hero | others: { hu | mw: [under 45%, 45-85%, 85%+ of the pot] } }, by who bet, heads-up or multiway at the bet and
  // the bet's size. riverAbsShift: the same by size for the heroRiverAbs threshold (hero's river bets). heroRR: preflop
  // re-raise share x this facing a raise by the hero seat (a number, or one per raise-to bucket: up to 2.5bb, 3.5, 5, 8,
  // more). pfContShift: { open | limp: [same buckets] } added to the continuing share facing hero's first raise.
  // Friends re-raise Marwin's raises about half as often as each other's, less the bigger he raises, fold to his
  // min-raises as often as to his big ones, and answer his bets by size in a shape the v12r bots don't have
  // (test/sim/table-check.js; fitted by test/sim/fit-v14.js).
  cutShift: null, riverAbsShift: null, heroRR: 1, pfContShift: null,
  // v15 (11 Nov): pfContShiftN { '2' | '3' | '4' | '5': { open | limp: [5 buckets] } } on top of pfContShift, by the
  // players dealt in (5 = 5 or more). The friends defend Marwin's opens wider heads-up than 4-handed (folds to his
  // 3.5-5bb opens, all logs to 10 Nov: heads-up 0.38, 3-handed 0.57, 4-handed 0.79), which the bots' position rule
  // doesn't give and v14's one set for every table size averaged out (test/sim/fit-v14.js --by-size).
  pfContShiftN: null,
};
// BOT_DUMP=<file>: one JSON line per bot answer to a first bet after the flop and per answer to a preflop raise, with
// what decided it, so the v14 shifts can be fitted offline (test/sim/fit-v14.js).
const BOT_DUMP = process.env.BOT_DUMP || null;
const dump = (o) => { if (BOT_DUMP) require('fs').appendFileSync(BOT_DUMP, JSON.stringify(o) + '\n'); };
const sizeBucket = (f) => (f < 0.45 ? 0 : f < 0.85 ? 1 : 2);
const pfBucket = (toBB) => (toBB <= 2.5 ? 0 : toBB <= 3.5 ? 1 : toBB <= 5 ? 2 : toBB <= 8 ? 3 : 4);
const SIZES = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5];
// With a wide spread (sizeSd above 0.45, as the real friends bet) the grid reaches tiny bets and 2x overbets too.
const SIZES_WIDE = [0.08, 0.12, 0.18, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

const STREET_OF = { 3: 'flop', 4: 'turn', 5: 'river' };
function homeBot(params) {
  const P = Object.assign({}, HOME_DEFAULT, params || {});
  const posMul = { early: 0.85, late: 1.15, blinds: 1.0 };
  const relOn = (P.rel || 0) > 0 || (P.relBet || 0) > 0;
  // The decision for a hand described by info: { pct } preflop, { hp, outs, hpC, hpB } after the flop (hpC / hpB: the
  // strength calls, raises and bets are judged by; hp itself in v7).
  function act(v, info) {
      const bb = v.bb, toCall = v.toCall;
      const allinTo = v.myBet + v.stack;
      if (v.street === 0) {
        const pct = info.pct;
        const pm = posMul[v.pos] || 1;
        const w = 0.04;
        if (v.raises === 0) {
          // First in or over limpers: raise, limp/check, or fold.
          const pR = sig((P.pfr * pm - pct) / w);
          const pPlay = Math.max(pR, sig((Math.min(0.97, P.vpip * pm) - pct) / w));
          const out = [];
          const open = Math.max(2, P.openBB) * bb + bb * v.limpers;
          // Open sizes spread around their usual size.
          const sh = P.openShove || 0;
          for (const [m, q] of [[0.6, 0.2], [1, 0.55], [1.5, 0.25]]) out.push({ t: 'raise', to: Math.max(2 * bb, Math.round(open * m / bb) * bb), p: pR * q * (1 - sh) });
          if (sh > 0) out.push({ t: 'raise', to: allinTo, p: pR * sh });
          out.push({ t: toCall > 0 ? 'call' : 'check', p: pPlay - pR });
          out.push({ t: toCall > 0 ? 'fold' : 'check', p: 1 - pPlay });
          return out;
        }
        // Facing a raise (or several).
        const raiseBB = v.cur / bb;
        // Facing 8bb or more to call (big raises, shoves): their own, fairly size-blind rate up to a raise to 30bb, then
        // a cliff (logs, first time facing a raise to 8bb+: 67-72% continue up to 35bb, 9% at 35-60bb, 4% above; the
        // bots called a raise to 100bb about half as often as one to 8bb).
        const big = toCall >= 8 * bb;
        const cliff = BOT_CLIFF && v.cur > 30 * bb ? Math.pow(30 * bb / v.cur, 2.5) : 1;
        let cont = big ? P.callBig * Math.pow(8 * bb / toCall, 0.25) * cliff : P.cont * Math.pow(3 / Math.max(2, raiseBB), P.contElast);
        // Chips already in (pfCommit, opt-in): with a quarter of the raise-to or more in, no cliff and at least 75% of
        // their range continues (logs: chips in under 0.1 of a 30bb+ raise-to 4 of 53 continued, 0.1-0.25 2 of 3, 0.25+ 4 of 5).
        if (P.pfCommit && big && v.put > 0) {
          const wC = clamp((v.put / v.cur - 0.1) / 0.15, 0, 1);
          if (wC > 0) {
            const width = v.seq.pre.some((k) => k === 'raise' || k === '3bet') ? P.pfr : P.vpip;
            cont = Math.max(cont / cliff * (cliff + (1 - cliff) * wC), 0.75 * width * pm * wC);
          }
        }
        if (v.raises >= 2 && !big) cont *= 0.8;
        // Already in the pot: an opener facing a re-raise and a limper facing a raise have their own fitted rates
        // (real limpers fold about half the time, openers about a fifth); a caller sticks with most of its range.
        const opened = v.seq.pre.some((k) => k === 'raise' || k === '3bet');
        if (!big && opened) cont = Math.min(0.97, P.pfr * pm) + P.cont3b;
        else if (!big && v.limped) cont = P.limpCont * Math.min(0.97, P.vpip * pm) * Math.pow(3 / Math.max(2, raiseBB), P.contElast);
        else if (!big && v.put > (v.pos === 'blinds' ? bb : 0) && v.seq.pre.length) cont = Math.max(cont, 0.85 * P.vpip * pm);
        cont = clamp(cont, 0.02, 0.97);
        // v14: hero's first raise (an open, or a raise over limpers) by its raise-to (pfBucket): the continuing share
        // moves by pfContShift.{open|limp}[bucket], the re-raise share x heroRR (a number, or one per bucket).
        const vsHero = v.lastAgg === v.heroSeat;
        const pb = pfBucket(raiseBB);
        if (P.pfContShift && vsHero && v.raises === 1) {
          const row = P.pfContShift[v.limpers > 0 ? 'limp' : 'open'];
          if (row && row[pb]) cont = clamp(cont + row[pb], 0.02, 0.97);
        }
        if (P.pfContShiftN && vsHero && v.raises === 1) {
          const bySize = P.pfContShiftN[String(Math.min(5, v.n))];
          const row = bySize && bySize[v.limpers > 0 ? 'limp' : 'open'];
          if (row && row[pb]) cont = clamp(cont + row[pb], 0.02, 0.97);
        }
        const hrr = !vsHero ? 1 : Array.isArray(P.heroRR) ? (P.heroRR[pb] != null ? P.heroRR[pb] : 1) : P.heroRR;
        const tb = clamp(P.threeBet * Math.pow(P.rrDecay, v.raises - 1) * hrr, 0.003, cont);
        // v10 jams (jam > 0): facing one raise, all-in with a share J of the spots, from the hands between their re-raise
        // range and jamTop x VPIP; the usual re-raises shrink by J, so they re-raise about as often in all (logs: 8 of 649
        // first raises faced were jammed, mostly from short stacks, shown hands at class rank 0.24-0.64, while the other
        // re-raises show at a median 0.06; J = jam x (40bb / their chips)^jamK, at most jamMax, fitted by allin-test.js).
        const J = P.jam > 0 && v.raises === 1 && allinTo > v.cur ? Math.min(P.jamMax, P.jam * Math.pow(40 / Math.max(5, (v.stack + v.put) / bb), P.jamK)) : 0;
        const tbN = J > 0 ? Math.max(0.003, tb - J) : tb;
        const pCont = sig((cont - pct) / w), pRR = Math.min(pCont, sig((tbN - pct) / (w * 0.7)));
        if (BOT_DUMP && v.real && v.raises === 1) dump({ pf: 1, hero: vsHero ? 1 : 0, toBB: raiseBB, pb, limpers: v.limpers, pct, w, pCont, tb0: P.threeBet * hrr, cont, J, n: v.n });
        const out = [];
        if (v.raises < 8) {
          const minTo = v.cur + v.lastRaise;
          const big = Math.round(v.cur * 2.3);
          const shove = minTo >= 0.4 * allinTo || big >= 0.45 * allinTo;
          if (shove) out.push({ t: 'raise', to: allinTo, p: pRR });
          else {
            const sh = P.rrShove || 0;
            if (sh > 0) out.push({ t: 'raise', to: allinTo, p: pRR * sh });
            out.push({ t: 'raise', to: minTo, p: pRR * (1 - sh) * P.rrMin }); out.push({ t: 'raise', to: big, p: pRR * (1 - sh) * (1 - P.rrMin) });
          }
        }
        out.push({ t: 'call', p: pCont - (v.raises < 8 ? pRR : 0) });
        out.push({ t: 'fold', p: 1 - pCont });
        if (J > 0) {
          const top = clamp(P.jamTop * P.vpip * pm, tb + 0.05, 0.97);
          const pj = Math.min(1, J / (top - tb) * sig((top - pct) / w) * sig((pct - tb) / w));
          if (pj > 0) { for (const o of out) o.p *= 1 - pj; out.push({ t: 'raise', to: allinTo, p: pj }); }
        }
        return out;
      }
      const si = v.street === 3 ? 0 : v.street === 4 ? 1 : 2;
      const { hp, outs } = info, hpC = info.hpC == null ? hp : info.hpC, hpB = info.hpB == null ? hp : info.hpB;
      const strongDraw = v.street < 5 && outs >= 8, weakDraw = v.street < 5 && outs >= 4 && !strongDraw;
      const k = Math.max(0, v.nOpp - 1);
      const air = hp < 0.5 && !strongDraw && !weakDraw;
      const pot = v.pot;
      // Hero's pot after a passive flop (hp* above): flopPas when hero is in and this bot has not bet or raised the flop.
      const hpOn = (P.hpCall || P.hpWc !== 1 || P.hpDraw !== 1 || P.hpBluff !== 1) && v.heroIn && v.seat !== v.heroSeat &&
        (v.street >= 4 || (P.hpFlop && v.street === 3)) && !(v.seq.flop || []).some((x) => x === 'bet' || x === 'raise');
      if (toCall === 0) {
        const pv = sig((hpB - (P.val[si] + P.mw * k)) / P.w) * (hp > 0.98 ? 1 - P.slow : 1);
        let pb = 0;
        if (strongDraw) pb = P.semi / (1 + 0.5 * k);
        else if (weakDraw) pb = P.semi / 3 / (1 + k);
        else if (air) pb = P.bluff[si] * (si === 0 && v.pfAgg === v.seat ? P.cbet : 1) / (1 + k);
        if (hpOn && P.hpBluff !== 1 && v.put + P.betSize * pot >= P.hpPut * bb) pb *= P.hpBluff;
        let pBet = clamp(pv + (1 - pv) * pb, 0, 1);
        if (P.lineBet && si >= 1) {
          const pl = v.seq[STREET_OF[v.street - 1]] || [];
          const j = pl.some((x) => x === 'bet' || x === 'raise') ? 1 : pl.includes('call') ? 0 : -1;
          const sh = j < 0 ? 0 : P.lineBet[2 * (si - 1) + j];
          if (sh) { const q = clamp(pBet, 1e-4, 1 - 1e-4); pBet = sig(Math.log(q / (1 - q)) + sh); }
        }
        // v12: heads-up on the flop or turn, first to act before the street's aggressor (the preflop raiser, the flop's
        // last bettor): bet leadHu [flop, turn] times as often, every hand alike. Friends lead there 11% / 13% (all logs to
        // 5 Nov), v11 bots 31% / 26%.
        if (P.leadHu && si <= 1 && v.nOpp === 1 && v.prevAgg >= 0 && v.prevAgg !== v.seat && !v.prevAggActed) pBet *= P.leadHu[si];
        // Bet size: a min-bet sometimes, otherwise around their usual size, bigger when stronger.
        const target = Math.log(P.betSize) + P.sizeTell * (hp - 0.7) + (P.potSlope ? P.potSlope * (Math.log(Math.max(1, pot / bb)) - Math.log(12)) : 0);
        const sd = P.sizeSd, grid = sd > 0.45 || P.potSlope ? SIZES_WIDE : SIZES;
        let ws = grid.map((s) => Math.exp(-Math.pow(Math.log(s) - target, 2) / (2 * sd * sd)));
        const tw = ws.reduce((a, b) => a + b, 0); ws = ws.map((x) => x / tw);
        const out = [{ t: 'raise', to: bb, p: pBet * P.minBet }];
        grid.forEach((s, i) => out.push({ t: 'raise', to: Math.max(bb, Math.round(s * pot)), p: pBet * (1 - P.minBet) * ws[i] }));
        out.push({ t: 'check', p: 1 - pBet });
        return out;
      }
      const f = toCall / Math.max(1, pot - toCall);
      // Multiway: the old bots raise the threshold by mw per extra opponent. Fitted bots (callMw set) answer by the
      // spot instead, like the friends: first to answer with others behind, last after everyone else folded, or
      // after someone has already called (overcall); heads-up from the start of the street has its own shift (callHu:
      // friends fold 52% to a first heads-up bet of 25-110% pot, n 61, where bots fitted without it folded 63%).
      const mwShift = !P.callMw ? P.mw * k : v.callsNow > 0 ? P.callMw[2] : v.toAnswer > 0 ? P.callMw[0] : v.foldsNow > 0 ? P.callMw[1] : (P.callHu || 0) + (P.callHuLog ? P.callHuLog * Math.log(clamp(f, 0.1, 1.5) / 0.5) : 0);
      let tc = P.call[si] + P.callSlope * (Math.min(f, P.sizeCap) - 0.5) + mwShift + (v.raises >= 2 ? 0.06 : 0);
      if (P.commitCut && v.put > 0) {
        const c = v.put / Math.max(1e-9, v.put + v.stack), t = clamp(tc, 1e-3, 1 - 1e-3);
        tc = 1 / (1 + Math.exp(-(Math.log(t / (1 - t)) + P.commitCut * c)));
      }
      const hpNow = hpOn && v.put + toCall >= P.hpPut * bb;
      if (hpNow) tc += P.hpCall;
      if (P.bigCall && pot >= P.bigPot * bb) tc += P.bigCall;
      if (P.raisedCut && (v.seq[STREET_OF[v.street]] || []).some((x) => x === 'bet' || x === 'raise')) tc += P.raisedCut;
      if (P.potCall) tc += P.potCall * Math.log(Math.max(2, pot / bb) / 10);
      // v11: the first heads-up answer to hero's flop or turn bet folds more (heroHuCut on the cut). Friends fold to
      // Marwin's heads-up flop and turn bets 46% (n 110), about as the read says, and to each other's 41% (n 187); v10
      // bots facing the solver's folded 33% (n 1,191) where its read said 43%; with 0.12, 43% against 46%.
      if (P.heroHuCut && (v.street === 3 || v.street === 4) && v.nOpp === 1 && v.raises === 1 && v.lastAgg === v.heroSeat) tc += P.heroHuCut;
      // v14: by who bet, heads-up or multiway when the bet was made, and its size (a first bet only)
      const first = v.raises === 1 && v.potAtStreet > 0;
      const huAtBet = v.nLive + (v.foldsNow || 0) === 2;
      const bkt = first ? sizeBucket(v.cur / v.potAtStreet) : -1;
      const byHero = v.lastAgg === v.heroSeat;
      if (P.cutShift && first) {
        const cs = P.cutShift[byHero ? 'hero' : 'others'];
        const row = cs && cs[huAtBet ? 'hu' : 'mw'];
        if (row) tc += row[bkt] || 0;
      }
      const wcEff = P.wc * (hpNow ? P.hpWc : 1);
      let pCont = sig((hpC - tc) / wcEff);
      const dc = P.drawCall * (hpNow ? P.hpDraw : 1);
      let floor = 0;
      if (strongDraw) floor = f <= 1 ? dc : dc / 2;
      else if (weakDraw) floor = f <= 0.5 ? dc / 2 : 0.1 * (hpNow ? P.hpDraw : 1);
      pCont = Math.max(pCont, floor);
      // Part of their stack already in: fold odds x exp(commit x share in) (friends: about -1.8, see READ_PRIORS.home.commitFold).
      if (P.commit && v.put > 0) {
        const c = v.put / Math.max(1e-9, v.put + v.stack), fo = clamp(1 - pCont, 1e-4, 1 - 1e-4), m = Math.exp(P.commit * c);
        pCont = 1 - (fo * m) / (fo * m + 1 - fo);
      }
      // Facing hero's river bet (v9): the friends answer hero's river bets by absolute strength whatever the size or the
      // read (river-bluff thread, 5 Nov: heads-up they continued iff the hand beat about 55% of all hands, n 30; against
      // each other's bets they fold as read). Continue iff hp clears heroRiverAbs (soft edge heroRiverW); heroRiverHU 1
      // limits it to heads-up answers.
      // v13 (heroRiverFloor 1): a floor only. With the pure rule the bots fold 51% to hero's heads-up river bets where the
      // friends fold 36% (n 72, all logs to 5 Nov; the made-call read says 36%): weak hands at the top of a weak range
      // fold although the friends call with them as read.
      let abs = null;
      if (P.heroRiverAbs && v.street === 5 && v.lastAgg === v.heroSeat && (!P.heroRiverHU || v.nOpp === 1)) {
        const shift = P.riverAbsShift && bkt >= 0 ? P.riverAbsShift[bkt] || 0 : 0;
        abs = sig((hp - P.heroRiverAbs - shift) / (P.heroRiverW || 0.02));
        pCont = P.heroRiverFloor ? Math.max(pCont, abs) : abs;
      }
      const reR = P.reRaise !== 1 && (v.seq[STREET_OF[v.street]] || []).some((x) => x === 'bet' || x === 'raise') ? P.reRaise : 1;
      const pRv = v.raises < 4 ? Math.min(pCont, reR * P.raiseProb * sig((hpC - (P.raise[si] + P.mw * k)) / (P.w * 0.6))) : 0;
      const pRb = v.raises < 3 ? reR * P.bluffRaise * (strongDraw ? 2 : air ? 1 : 0.5) : 0;
      const pRaise = pRv + (1 - pCont) * pRb;
      if (BOT_DUMP && v.real && first) dump({ st: v.street, hero: byHero ? 1 : 0, hu: huAtBet ? 1 : 0, b: bkt, hpC, hp, tc, wc: wcEff, floor, commit: P.commit && v.put > 0 ? P.commit * v.put / Math.max(1e-9, v.put + v.stack) : 0,
        abs: abs != null ? 1 : 0, absT: abs != null ? P.heroRiverAbs + (P.riverAbsShift && bkt >= 0 ? P.riverAbsShift[bkt] || 0 : 0) : null, absW: P.heroRiverW || 0.02, absFloor: P.heroRiverFloor ? 1 : 0,
        pRb, pRv, pCont });
      const to = Math.round(v.cur * P.raiseX);
      const out = [{ t: 'call', p: pCont - pRv }, { t: 'fold', p: (1 - pCont) * (1 - pRb) }];
      // Raise sizes: min-raises, all-ins and bigger raises in the friends' mix (the old bots: always raiseX).
      const mn = P.raiseMin || 0, sh = P.raiseShove || 0, minTo = v.cur + v.lastRaise;
      if (mn > 0) out.push({ t: 'raise', to: minTo >= 0.6 * allinTo ? allinTo : minTo, p: pRaise * mn });
      if (sh > 0) out.push({ t: 'raise', to: allinTo, p: pRaise * sh });
      out.unshift({ t: 'raise', to: to >= 0.6 * allinTo ? allinTo : to, p: pRaise * (1 - mn - sh) });
      return out;
  }
  // v8: the range before decision v (combo weights, max 1), from the bot's earlier decisions this hand. Each step's
  // result is kept on its history entry, so a hand's range is built once, one decision at a time.
  function rangeBefore(v) {
    const hist = v.hist || [];
    let j = hist.length - 1;
    while (j >= 0 && !hist[j].W) j--;
    let W = j >= 0 ? hist[j].W : new Float64Array(NC).fill(1);
    for (let i = j + 1; i < hist.length; i++) { W = stepRange(W, hist[i]); hist[i].W = W; }
    return W;
  }
  // Strengths of combo k at a postflop decision: hp, outs and the range-relative hpC / hpB.
  function infoAt(v, tbl, q, k) {
    const hp = tbl.hp[k];
    if (!q) return { hp, outs: tbl.outs[k] };
    const r = refAt(v.street - 3, refSpot(v), q[k]) - hp;
    return { hp, outs: tbl.outs[k], hpC: hp + (P.rel || 0) * r, hpB: hp + (P.relBet || 0) * r };
  }
  function postCtx(v, W) {
    const tbl = boardTable(v.board);
    const lam = v.toCall > 0 ? P.rel || 0 : P.relBet || 0;
    return { tbl, q: lam > 0 ? rangeQuantiles(W, tbl) : null };
  }
  function stepRange(W, e) {
    const v = e.v, out = new Float64Array(NC);
    let mask = null, tot = 0, mx = 0;
    const probOf = (dist) => {
      if (!mask || mask.length !== dist.length) mask = dist.map((d) => { const x = normalizeWith(e.ns, d); return x.t === e.did.t && x.add === e.did.add; });
      let a = 0, b = 0;
      for (let i = 0; i < dist.length; i++) { const p = dist[i].p > 0 ? dist[i].p : 0; b += p; if (mask[i]) a += p; }
      return b > 0 ? a / b : 0;
    };
    if (v.street === 0) {
      const memo = new Map();
      for (let k = 0; k < NC; k++) {
        if (!(W[k] > 1e-6)) continue;
        const pc = pctOf(k);
        let p = memo.get(pc);
        if (p === undefined) { p = probOf(act(v, { pct: pc })); memo.set(pc, p); }
        out[k] = W[k] * p; tot += out[k]; if (out[k] > mx) mx = out[k];
      }
    } else {
      const { tbl, q } = postCtx(v, W);
      // Combos below a millionth of the most likely one are dropped from the range (no effect on any quantile to speak of).
      for (const k of tbl.live) {
        if (!(W[k] > 1e-6)) continue;
        out[k] = W[k] * probOf(act(v, infoAt(v, tbl, q, k))); tot += out[k]; if (out[k] > mx) mx = out[k];
      }
    }
    if (!(tot > 0)) return W;
    for (let k = 0; k < NC; k++) out[k] /= mx;
    return out;
  }
  return {
    params: P,
    rangeAware: relOn,
    rangeBefore,
    policy(v) {
      if (v.street === 0) return act(v, { pct: pfPct(v.hand) });
      if (!relOn) return act(v, post(v.hand, v.board));
      const { tbl, q } = postCtx(v, rangeBefore(v));
      return act(v, infoAt(v, tbl, q, cidx(v.hand[0], v.hand[1])));
    },
  };
}

// Builds a seat from a spec: 'station' | 'typical' | 'maniac' | 'baseline' | 'home' | 'home:<profile id>' | params object.
function makeBot(spec, profiles) {
  if (spec && typeof spec === 'object') return homeBot(spec);
  if (LEGACY[spec]) return legacyBot(LEGACY[spec]);
  if (spec === 'baseline') return baseline();
  if (spec === 'home') return homeBot({});
  const m = /^home:(.+)$/.exec(spec || '');
  if (m) {
    const p = profiles && profiles[m[1]];
    if (!p) throw new Error('unknown profile ' + m[1]);
    return homeBot(p.params || p);
  }
  throw new Error('unknown bot ' + spec);
}

module.exports = { LEGACY, HOME_DEFAULT, legacyBot, baseline, homeBot, makeBot, pfStrength, pfPct, post, boardTable, rangeQuantiles, cidx, NC, CA, CB, spotOf, openLine, SPOTS };
