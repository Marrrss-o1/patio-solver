// Simulated opponents. Every bot is a `policy(view)` that returns its action probabilities, so the
// AIVAT correction in game.js knows exactly what it could have done.
//
//  - legacy bots (station, typical, maniac): the old simulators' rule bots, unchanged in distribution.
//  - home bots: amateur model calibrated to Marwin's friends (profiles.json, see calibrate.js).
//    Loose preflop, limps, min-raise wars, small and min bets, sticky calls with any pair or draw.
// Plus `baseline`, the old "simple solid regular" agent used as the comparison hero.
'use strict';
const E = require('../../src/engine.js');
const { keyed } = require('./game.js');

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
};
const SIZES = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5];
// With a wide spread (sizeSd above 0.45, as the real friends bet) the grid reaches tiny bets and 2x overbets too.
const SIZES_WIDE = [0.08, 0.12, 0.18, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

const STREET_OF = { 3: 'flop', 4: 'turn', 5: 'river' };
function homeBot(params) {
  const P = Object.assign({}, HOME_DEFAULT, params || {});
  const posMul = { early: 0.85, late: 1.15, blinds: 1.0 };
  return {
    params: P,
    policy(v) {
      const h = v.hand, bb = v.bb, toCall = v.toCall;
      const allinTo = v.myBet + v.stack;
      if (v.street === 0) {
        const pct = pfPct(h);
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
        // Facing 8bb or more to call (big raises, shoves): their own, fairly size-blind rate.
        const big = toCall >= 8 * bb;
        let cont = big ? P.callBig * Math.pow(8 * bb / toCall, 0.25) : P.cont * Math.pow(3 / Math.max(2, raiseBB), P.contElast);
        if (v.raises >= 2 && !big) cont *= 0.8;
        // Already in the pot: an opener facing a re-raise and a limper facing a raise have their own fitted rates
        // (real limpers fold about half the time, openers about a fifth); a caller sticks with most of its range.
        const opened = v.seq.pre.some((k) => k === 'raise' || k === '3bet');
        if (!big && opened) cont = Math.min(0.97, P.pfr * pm) + P.cont3b;
        else if (!big && v.limped) cont = P.limpCont * Math.min(0.97, P.vpip * pm) * Math.pow(3 / Math.max(2, raiseBB), P.contElast);
        else if (!big && v.put > (v.pos === 'blinds' ? bb : 0) && v.seq.pre.length) cont = Math.max(cont, 0.85 * P.vpip * pm);
        cont = clamp(cont, 0.02, 0.97);
        const tb = clamp(P.threeBet * Math.pow(P.rrDecay, v.raises - 1), 0.003, cont);
        const pCont = sig((cont - pct) / w), pRR = Math.min(pCont, sig((tb - pct) / (w * 0.7)));
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
        return out;
      }
      const si = v.street === 3 ? 0 : v.street === 4 ? 1 : 2;
      const { hp, outs } = post(h, v.board);
      const strongDraw = v.street < 5 && outs >= 8, weakDraw = v.street < 5 && outs >= 4 && !strongDraw;
      const k = Math.max(0, v.nOpp - 1);
      const air = hp < 0.5 && !strongDraw && !weakDraw;
      const pot = v.pot;
      if (toCall === 0) {
        const pv = sig((hp - (P.val[si] + P.mw * k)) / P.w) * (hp > 0.98 ? 1 - P.slow : 1);
        let pb = 0;
        if (strongDraw) pb = P.semi / (1 + 0.5 * k);
        else if (weakDraw) pb = P.semi / 3 / (1 + k);
        else if (air) pb = P.bluff[si] * (si === 0 && v.pfAgg === v.seat ? P.cbet : 1) / (1 + k);
        let pBet = clamp(pv + (1 - pv) * pb, 0, 1);
        if (P.lineBet && si >= 1) {
          const pl = v.seq[STREET_OF[v.street - 1]] || [];
          const j = pl.some((x) => x === 'bet' || x === 'raise') ? 1 : pl.includes('call') ? 0 : -1;
          const sh = j < 0 ? 0 : P.lineBet[2 * (si - 1) + j];
          if (sh) { const q = clamp(pBet, 1e-4, 1 - 1e-4); pBet = sig(Math.log(q / (1 - q)) + sh); }
        }
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
      // after someone has already called (overcall); heads-up has no shift.
      const mwShift = !P.callMw ? P.mw * k : v.callsNow > 0 ? P.callMw[2] : v.toAnswer > 0 ? P.callMw[0] : v.foldsNow > 0 ? P.callMw[1] : 0;
      const tc = P.call[si] + P.callSlope * (Math.min(f, P.sizeCap) - 0.5) + mwShift + (v.raises >= 2 ? 0.06 : 0);
      let pCont = sig((hp - tc) / P.wc);
      if (strongDraw) pCont = Math.max(pCont, f <= 1 ? P.drawCall : P.drawCall / 2);
      else if (weakDraw) pCont = Math.max(pCont, f <= 0.5 ? P.drawCall / 2 : 0.1);
      const reR = P.reRaise !== 1 && (v.seq[STREET_OF[v.street]] || []).some((x) => x === 'bet' || x === 'raise') ? P.reRaise : 1;
      const pRv = v.raises < 4 ? Math.min(pCont, reR * P.raiseProb * sig((hp - (P.raise[si] + P.mw * k)) / (P.w * 0.6))) : 0;
      const pRb = v.raises < 3 ? reR * P.bluffRaise * (strongDraw ? 2 : air ? 1 : 0.5) : 0;
      const pRaise = pRv + (1 - pCont) * pRb;
      const to = Math.round(v.cur * P.raiseX);
      const out = [{ t: 'call', p: pCont - pRv }, { t: 'fold', p: (1 - pCont) * (1 - pRb) }];
      // Raise sizes: min-raises, all-ins and bigger raises in the friends' mix (the old bots: always raiseX).
      const mn = P.raiseMin || 0, sh = P.raiseShove || 0, minTo = v.cur + v.lastRaise;
      if (mn > 0) out.push({ t: 'raise', to: minTo >= 0.6 * allinTo ? allinTo : minTo, p: pRaise * mn });
      if (sh > 0) out.push({ t: 'raise', to: allinTo, p: pRaise * sh });
      out.unshift({ t: 'raise', to: to >= 0.6 * allinTo ? allinTo : to, p: pRaise * (1 - mn - sh) });
      return out;
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

module.exports = { LEGACY, HOME_DEFAULT, legacyBot, baseline, homeBot, makeBot, pfStrength, pfPct, post };
