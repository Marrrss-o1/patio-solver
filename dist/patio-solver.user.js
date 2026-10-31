// ==UserScript==
// @name         Patio Solver
// @description  Solver advice for your Poker Patio private lobbies. Reads the table automatically.
// @version      1.2.2
// @match        https://pokerpatio.com/mp*
// @match        https://www.pokerpatio.com/mp*
// @run-at       document-end
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

(function () {
"use strict";
// ---- Solver engine (also loaded into a background worker via ENGINE.toString()) ----
function ENGINE() {
/*
 * Hold'em Read Solver engine (from your "Hold'em Read Solver" artifact).
 *
 * Pipeline:
 *   1. Opponent tallies -> stats (VPIP, PFR, AF, bet / fold / raise frequencies),
 *      shrunk toward table defaults when the sample is small.
 *   2. Stats + the opponent's actions this hand -> a weighted range over all
 *      1326 hole-card combos (preflop ranking, then street-by-street narrowing
 *      against hand strength on the board that was out at the time).
 *   3. Monte Carlo over opponents' ranges and the remaining board, for every
 *      candidate action, including the chance that opponents fold to a bet.
 *   4. The action with the highest expected value is recommended.
 *
 * No dependencies. Works in the browser, in a service worker and in Node.
 */
(function (global) {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'cdhs';
  const RANK_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

  function parseCard(s) {
    if (typeof s !== 'string' || s.length !== 2) return -1;
    const r = RANKS.indexOf(s[0].toUpperCase());
    const su = SUITS.indexOf(s[1].toLowerCase());
    return r < 0 || su < 0 ? -1 : r * 4 + su;
  }

  function cardToString(c) {
    return RANKS[c >> 2] + SUITS[c & 3];
  }

  const STRAIGHT_HIGH = new Int8Array(8192);
  const TOP5 = new Int32Array(8192);
  const POPCOUNT = new Uint8Array(8192);
  const HIGHBIT = new Int8Array(8192);

  for (let m = 0; m < 8192; m++) {
    let hi = -1;
    for (let r = 12; r >= 4; r--) {
      if (((m >> (r - 4)) & 31) === 31) { hi = r; break; }
    }
    if (hi < 0 && (m & 0x100f) === 0x100f) hi = 3;
    STRAIGHT_HIGH[m] = hi;

    let v = 0, k = 0, pc = 0, hb = -1;
    for (let r = 12; r >= 0; r--) {
      if ((m >> r) & 1) {
        pc++;
        if (hb < 0) hb = r;
        if (k < 5) { v |= r << (4 * (4 - k)); k++; }
      }
    }
    TOP5[m] = v;
    POPCOUNT[m] = pc;
    HIGHBIT[m] = hb;
  }

  const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  function evaluate(cards, n) {
    let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      const bit = 1 << (c >> 2);
      switch (c & 3) {
        case 0: m0 |= bit; break;
        case 1: m1 |= bit; break;
        case 2: m2 |= bit; break;
        default: m3 |= bit;
      }
    }
    let fm = -1;
    if (POPCOUNT[m0] >= 5) fm = m0;
    else if (POPCOUNT[m1] >= 5) fm = m1;
    else if (POPCOUNT[m2] >= 5) fm = m2;
    else if (POPCOUNT[m3] >= 5) fm = m3;
    if (fm >= 0) {
      const sf = STRAIGHT_HIGH[fm];
      if (sf >= 0) return (8 << 20) | (sf << 16);
    }
    const any = m0 | m1 | m2 | m3;
    const quads = m0 & m1 & m2 & m3;
    if (quads) {
      const q = HIGHBIT[quads];
      return (7 << 20) | (q << 16) | (HIGHBIT[any & ~(1 << q)] << 12);
    }
    const trips = (m0 & m1 & m2) | (m0 & m1 & m3) | (m0 & m2 & m3) | (m1 & m2 & m3);
    const pairs = ((m0 & m1) | (m0 & m2) | (m0 & m3) | (m1 & m2) | (m1 & m3) | (m2 & m3)) & ~trips;
    if (trips) {
      const t = HIGHBIT[trips];
      const rest = (trips & ~(1 << t)) | pairs;
      if (rest) return (6 << 20) | (t << 16) | (HIGHBIT[rest] << 12);
    }
    if (fm >= 0) return (5 << 20) | TOP5[fm];
    const st = STRAIGHT_HIGH[any];
    if (st >= 0) return (4 << 20) | (st << 16);
    if (trips) {
      const t = HIGHBIT[trips];
      return (3 << 20) | (t << 16) | ((TOP5[any & ~(1 << t)] >> 12) << 8);
    }
    if (pairs) {
      const p1 = HIGHBIT[pairs];
      const rest = pairs & ~(1 << p1);
      if (rest) {
        const p2 = HIGHBIT[rest];
        return (2 << 20) | (p1 << 16) | (p2 << 12) | (HIGHBIT[any & ~(1 << p1) & ~(1 << p2)] << 8);
      }
      return (1 << 20) | (p1 << 16) | ((TOP5[any & ~(1 << p1)] >> 8) << 4);
    }
    return TOP5[any];
  }

  function scoreCategory(score) {
    return score >> 20;
  }

  function describeScore(score) {
    const cat = score >> 20;
    const a = (score >> 16) & 15, b = (score >> 12) & 15;
    switch (cat) {
      case 8: return a === 12 ? 'Royal flush' : 'Straight flush, ' + RANK_NAMES[a] + ' high';
      case 7: return 'Four ' + RANK_PLURAL[a];
      case 6: return 'Full house, ' + RANK_PLURAL[a] + ' full of ' + RANK_PLURAL[b];
      case 5: return 'Flush, ' + RANK_NAMES[a] + ' high';
      case 4: return 'Straight, ' + RANK_NAMES[a] + ' high';
      case 3: return 'Three ' + RANK_PLURAL[a];
      case 2: return 'Two pair, ' + RANK_PLURAL[a] + ' and ' + RANK_PLURAL[b];
      case 1: return 'Pair of ' + RANK_PLURAL[a];
      default: return RANK_NAMES[a] + ' high';
    }
  }

  const NUM_COMBOS = 1326;
  const COMBO_HI = new Uint8Array(NUM_COMBOS);
  const COMBO_LO = new Uint8Array(NUM_COMBOS);
  const COMBO_INDEX = new Int16Array(52 * 52).fill(-1);
  const COMBO_CLASS = new Uint8Array(NUM_COMBOS);
  const CLASS_NAMES = new Array(169);
  const CLASS_COMBO_COUNT = new Uint8Array(169);

  {
    let k = 0;
    for (let a = 51; a >= 1; a--) {
      for (let b = a - 1; b >= 0; b--) {
        COMBO_HI[k] = a;
        COMBO_LO[k] = b;
        COMBO_INDEX[a * 52 + b] = k;
        COMBO_INDEX[b * 52 + a] = k;
        const ra = a >> 2, rb = b >> 2;
        let row, col;
        if (ra === rb) { row = col = 12 - ra; }
        else if ((a & 3) === (b & 3)) { row = 12 - ra; col = 12 - rb; }
        else { row = 12 - rb; col = 12 - ra; }
        const cls = row * 13 + col;
        COMBO_CLASS[k] = cls;
        CLASS_COMBO_COUNT[cls]++;
        k++;
      }
    }
    for (let row = 0; row < 13; row++) {
      for (let col = 0; col < 13; col++) {
        const hi = RANKS[12 - Math.min(row, col)], lo = RANKS[12 - Math.max(row, col)];
        CLASS_NAMES[row * 13 + col] = row === col ? hi + lo : hi + lo + (row < col ? 's' : 'o');
      }
    }
  }

  const PREFLOP_ORDER = (
    'AA KK QQ JJ TT 99 AKs 88 AQs AJs AKo KQs 77 ATs AQo KJs AJo A9s 66 QJs ATo KTs A8s KQo A7s QTs KJo 55 K9s A9o JTs A5s KTo 44 A6s A8o A4s QJo Q9s K8s A7o 33 K9o A3s J9s QTo K7s A2s T9s A5o A6o 22 K6s Q8s A4o JTo K8o K5s Q9o J8s A3o K4s 98s T8s K7o Q7s K3s A2o J9o Q8o K6o Q6s J7s K2s 87s Q5s T9o K5o 97s Q4s J8o T7s K4o Q7o Q3s J6s K3o T8o 76s Q6o J5s Q2s T6s 86s J7o J4s K2o Q5o 98o 65s 96s J3s T7o Q4o 54s J6o J2s Q3o 75s T5s 97o T4s 95s 87o J5o Q2o T3s T6o 64s 85s J4o 96o T2s J3o 94s 53s 86o 93s 84s 76o T5o J2o T4o 74s 92s 95o 85o T3o 65o 75o T2o 83s 82s 73s 63s 43s 94o 93o 54o 52s 84o 64o 74o 72s 92o 62s 42s 83o 53o 32s 82o 63o 73o 43o 72o 52o 62o 42o 32o'
  ).split(' ');

  const CLASS_RANK = new Int16Array(169);
  const CLASS_STRENGTH = new Float64Array(169);
  const COMBO_PREFLOP_STRENGTH = new Float64Array(NUM_COMBOS);
  {
    const nameToClass = {};
    CLASS_NAMES.forEach((n, i) => { nameToClass[n] = i; });
    let cum = 0;
    PREFLOP_ORDER.forEach((name, i) => {
      const cls = nameToClass[name];
      CLASS_RANK[cls] = i;
      const n = CLASS_COMBO_COUNT[cls];
      CLASS_STRENGTH[cls] = 1 - (cum + n / 2) / NUM_COMBOS;
      cum += n;
    });
    for (let k = 0; k < NUM_COMBOS; k++) COMBO_PREFLOP_STRENGTH[k] = CLASS_STRENGTH[COMBO_CLASS[k]];
  }

  function topClassWeights(frac) {
    const w = new Float64Array(169);
    const target = Math.max(0, Math.min(1, frac)) * NUM_COMBOS;
    let cum = 0;
    for (let i = 0; i < 169; i++) {
      const cls = CLASS_NAMES.indexOf(PREFLOP_ORDER[i]);
      const n = CLASS_COMBO_COUNT[cls];
      if (cum + n <= target) w[cls] = 1;
      else if (cum < target) w[cls] = (target - cum) / n;
      cum += n;
      if (cum >= target) break;
    }
    return w;
  }

  const TABLE_PRIORS = {
    tight: { vpip: 0.20, pfr: 0.14, af: 2.0, betFreq: 0.40, foldToBet: 0.52, raiseFreq: 0.09 },
    typical: { vpip: 0.28, pfr: 0.14, af: 1.8, betFreq: 0.38, foldToBet: 0.45, raiseFreq: 0.09 },
    loose: { vpip: 0.40, pfr: 0.13, af: 1.4, betFreq: 0.34, foldToBet: 0.36, raiseFreq: 0.08 },
  };

  const EMPTY_TALLY = { pfFold: 0, pfCall: 0, pfRaise: 0, check: 0, bet: 0, call: 0, raise: 0, fold: 0, pf3betOpp: 0, pf3bet: 0, cbetOpp: 0, cbet: 0, vsCbet: 0, foldCbet: 0, sawFlop: 0, wtsd: 0 };
  const STREET_KEYS = { 3: 'flop', 4: 'turn', 5: 'river' };
  // Facing-bet size buckets (bet as a fraction of the pot before it) and the size each one stands for.
  const SIZE_BUCKETS = [['small', 0.33], ['medium', 0.66], ['large', 1.1]];
  const BIG_BET = 0.75;

  // Balanced-play references for a bet of f x pot.
  const eqFold = (f) => f / (1 + f);
  const eqValueShare = (f) => (1 + f) / (1 + 2 * f);
  // Position groups: 'late' = button and cutoff, 'blinds' = SB and BB, 'early' = the rest.
  const POS_SCALE = { early: 0.8, late: 1.25, blinds: 1 };

  // How often a player with fold-to-bet `ftb` folds to a bet of `f` x pot, before any size-specific data.
  function modelFold(ftb, f) {
    const mdf = 1 / (1 + Math.max(0.05, f));
    // Fold rates rise only gently with bet size: home-game players call big bets far
    // more than pot odds say they should (the old, steeper curve made overbets with
    // weak hands look profitable, and they lost at the table).
    const elasticity = clamp(0.8 * Math.sqrt(ftb / 0.45), 0.5, 1.1);
    return clamp(1 - (1 - ftb) * Math.pow(mdf / 0.625, elasticity), 0.03, 0.97);
  }

  // Strength (percentile against every hand) of one known hand on a board, without potential.
  function handPercentile(hole, board) {
    const dead = new Uint8Array(52);
    board.forEach((c) => { dead[c] = 1; });
    const buf = new Int32Array(7);
    for (let i = 0; i < board.length; i++) buf[i] = board[i];
    const n = board.length;
    buf[n] = hole[0]; buf[n + 1] = hole[1];
    const mine = evaluate(buf, n + 2);
    let below = 0, ties = 0, total = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      const a = COMBO_HI[k], b = COMBO_LO[k];
      if (dead[a] || dead[b] || a === hole[0] || a === hole[1] || b === hole[0] || b === hole[1]) continue;
      buf[n] = a; buf[n + 1] = b;
      const sc = evaluate(buf, n + 2);
      total++;
      if (sc < mine) below++; else if (sc === mine) ties++;
    }
    return total ? (below + ties / 2) / total : 0.5;
  }

  // Shown hands -> how many of their bets and raises were value, thin value or bluffs.
  // A bet counts as value when the hand was in the top 30% of all hands on that board,
  // a bluff when it was in the bottom 45% (semi-bluffs with draws count as bluffs).
  const showCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function classifyShows(shows) {
    const out = { value: 0, bluff: 0, mid: 0, bigValue: 0, bigBluff: 0, bigMid: 0, hands: 0 };
    for (const sh of shows || []) {
      if (!sh || !sh.cards || sh.cards.length !== 2 || !sh.board) continue;
      let c = showCache && showCache.get(sh);
      if (!c) {
        const hole = sh.cards.map(parseCard), board = sh.board.map(parseCard);
        if (hole.some((x) => x < 0) || board.some((x) => x < 0)) continue;
        c = (sh.agg || []).filter((a) => a.n >= 3 && a.n <= board.length).map((a) => ({
          big: a.frac >= BIG_BET, p: handPercentile(hole, board.slice(0, a.n)),
        }));
        if (showCache) showCache.set(sh, c);
      }
      if (c.length) out.hands++;
      for (const a of c) {
        const kind = a.p >= 0.7 ? 'value' : a.p < 0.45 ? 'bluff' : 'mid';
        out[kind]++;
        if (a.big) out['big' + kind[0].toUpperCase() + kind.slice(1)]++;
      }
    }
    return out;
  }

  function computeStats(tally, tableStyle) {
    const t = Object.assign({}, EMPTY_TALLY, tally || {});
    const pr = TABLE_PRIORS[tableStyle] || TABLE_PRIORS.typical;
    const hands = t.pfFold + t.pfCall + t.pfRaise;
    const unopened = t.check + t.bet;
    const facing = t.fold + t.call + t.raise;
    const KP = 8, KF = 6, KA = 3;

    const vpip = (t.pfCall + t.pfRaise + KP * pr.vpip) / (hands + KP);
    const pfr = Math.min(vpip, (t.pfRaise + KP * pr.pfr) / (hands + KP));
    const stats = {
      hands,
      postflopActions: unopened + facing,
      vpip,
      pfr,
      af: (t.bet + t.raise + KA * pr.af) / (t.call + KA),
      betFreq: (t.bet + KF * pr.betFreq) / (unopened + KF),
      foldToBet: (t.fold + KF * pr.foldToBet) / (facing + KF),
      raiseFreq: (t.raise + KF * pr.raiseFreq) / (facing + KF),
      raw: {
        vpip: hands ? (t.pfCall + t.pfRaise) / hands : null,
        pfr: hands ? t.pfRaise / hands : null,
        af: t.call ? (t.bet + t.raise) / t.call : (t.bet + t.raise ? Infinity : null),
        betFreq: unopened ? t.bet / unopened : null,
        foldToBet: facing ? t.fold / facing : null,
        raiseFreq: facing ? t.raise / facing : null,
      },
    };

    // Preflop 3-bet and flop c-bet frequencies.
    stats.threeBet = (t.pf3bet + 10 * clamp(pr.pfr * 0.45, 0.04, 0.1)) / (t.pf3betOpp + 10);
    stats.cbet = (t.cbet + 5 * clamp(pr.betFreq + 0.22, 0.4, 0.75)) / (t.cbetOpp + 5);
    stats.foldToCbet = (t.foldCbet + 5 * stats.foldToBet) / (t.vsCbet + 5);
    stats.wtsd = (t.wtsd + 5 * 0.3) / (t.sawFlop + 5);
    stats.raw.threeBet = t.pf3betOpp ? t.pf3bet / t.pf3betOpp : null;
    stats.raw.cbet = t.cbetOpp ? t.cbet / t.cbetOpp : null;
    stats.raw.foldToCbet = t.vsCbet ? t.foldCbet / t.vsCbet : null;
    stats.raw.wtsd = t.sawFlop ? t.wtsd / t.sawFlop : null;

    // Per street, shrunk toward the all-streets numbers.
    const KS = 5;
    stats.byStreet = {};
    for (const n of [3, 4, 5]) {
      const x = Object.assign({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, (t.st && t.st[STREET_KEYS[n]]) || {});
      const u = x.check + x.bet, f = x.fold + x.call + x.raise;
      stats.byStreet[n] = {
        betFreq: (x.bet + KS * stats.betFreq) / (u + KS),
        foldToBet: (x.fold + KS * stats.foldToBet) / (f + KS),
        raiseFreq: (x.raise + KS * stats.raiseFreq) / (f + KS),
        samples: u + f,
      };
    }

    // Folds by the size of the bet they face, shrunk toward the size model.
    stats.foldBySize = {};
    stats.raw.foldBySize = {};
    for (const [key, f] of SIZE_BUCKETS) {
      const x = Object.assign({ fold: 0, call: 0, raise: 0 }, (t.vs && t.vs[key]) || {});
      const nf = x.fold + x.call + x.raise;
      const prior = modelFold(stats.foldToBet, f);
      stats.foldBySize[key] = (x.fold + 4 * prior) / (nf + 4);
      stats.raw.foldBySize[key] = nf ? x.fold / nf : null;
      stats.raw.foldBySize[key + 'N'] = nf;
    }

    // Their usual bet size, as a fraction of the pot.
    const bs = t.betSize || { n: 0, sum: 0 };
    stats.betSize = clamp((bs.sum + 3 * 0.6) / (bs.n + 3), 0.2, 2);

    // Value share of their bets: the aggression-based guess, corrected by hands they showed.
    const vr0 = clamp(0.9 - 0.08 * (stats.af - 1), 0.55, 0.9);
    const sd = classifyShows(t.shows);
    const V = sd.value + sd.mid / 2, B = sd.bluff + sd.mid / 2;
    const vr = clamp((V + 5 * vr0) / (V + B + 5), 0.3, 0.95);
    const Vb = sd.bigValue + sd.bigMid / 2, Bb = sd.bigBluff + sd.bigMid / 2;
    const Vs = V - Vb, Bs = B - Bb;
    stats.valueShare = vr;
    stats.valueShareBig = clamp((Vb + 4 * Math.min(0.95, vr + 0.04)) / (Vb + Bb + 4), 0.3, 0.97);
    stats.valueShareSmall = clamp((Vs + 4 * Math.max(0.3, vr - 0.03)) / (Vs + Bs + 4), 0.3, 0.95);
    stats.shown = { hands: sd.hands, bets: sd.value + sd.mid + sd.bluff, bluffs: sd.bluff };
    stats.raw.bluffShare = V + B ? B / (V + B) : null;
    stats.bluffShare = 1 - vr;

    // Preflop by position group, shrunk toward their overall numbers scaled by how
    // much looser people usually play late and tighter early.
    stats.byPos = {};
    for (const g of Object.keys(POS_SCALE)) {
      const x = Object.assign({ n: 0, vpip: 0, pfr: 0 }, (t.pos && t.pos[g]) || {});
      const pv = clamp(vpip * POS_SCALE[g], 0.05, 0.95), pp = clamp(stats.pfr * POS_SCALE[g], 0.02, pv);
      const v = (x.vpip + 8 * pv) / (x.n + 8);
      stats.byPos[g] = { vpip: v, pfr: Math.min(v, (x.pfr + 8 * pp) / (x.n + 8)), hands: x.n };
    }

    const n = hands + stats.postflopActions / 2;
    stats.confidence = n < 10 ? 'guess' : n < 40 ? 'low' : n < 120 ? 'medium' : 'solid';

    // Confidence-pinned exploitation (restricted Nash response): trust the read with
    // weight p, which grows from 0.5 with no hands to 0.9 at about 120, and fill the rest
    // with balanced play: fold f/(1+f) to a bet of f x pot (minimum defense), and bet
    // value:bluff in the (1+f):f ratio that makes calling break even.
    // The floor is 0.5, not the 0.2 the papers use: the default read is already a
    // typical amateur, which is a better guess for a home game than balanced play.
    // Read accuracy: where each shown hand sat in the range we would have put them on.
    // A well-calibrated range has the shown hand in its more likely half about half the
    // time. Reads that keep missing get less trust.
    const fits = (t.shows || []).map((x) => x && x.fit).filter((f) => f && f.top != null);
    const hits = fits.filter((f) => f.top < 0.5).length;
    stats.accuracy = fits.length ? {
      n: fits.length, hits,
      // How many times more likely the shown hand was under our range than under a random guess.
      vsGuess: Math.pow(2, fits.reduce((a, f) => a + Math.log2(Math.max(1e-3, f.lr)), 0) / fits.length),
    } : null;
    // Average miss in strength (0 = shown hands sit in the middle of our ranges), shrunk
    // toward zero until there are several showdowns.
    const sqs = fits.filter((f) => f.sq != null);
    stats.strengthBias = clamp(sqs.reduce((a, f) => a + (f.sq - 0.5), 0) / (sqs.length + 4), -0.3, 0.3);
    const trust = clamp(((hits + 2) / (fits.length + 4)) / 0.5, 0.5, 1.1);
    const p = clamp((0.5 + (0.4 * n) / 120) * trust, 0.3, 0.95);
    stats.exploitWeight = p;
    const mix = (read, eq) => p * read + (1 - p) * eq;
    stats.foldToBet = mix(stats.foldToBet, eqFold(0.6));
    for (const k of [3, 4, 5]) stats.byStreet[k].foldToBet = mix(stats.byStreet[k].foldToBet, eqFold(0.6));
    for (const [key, f] of SIZE_BUCKETS) stats.foldBySize[key] = mix(stats.foldBySize[key], eqFold(f));
    stats.valueShare = mix(stats.valueShare, eqValueShare(0.66));
    stats.valueShareBig = mix(stats.valueShareBig, eqValueShare(1.1));
    stats.valueShareSmall = mix(stats.valueShareSmall, eqValueShare(0.33));
    return stats;
  }

  const PLAYER_TYPES = {
    unknown: { label: 'Unknown', tip: 'Not many hands yet, so table defaults fill the gaps.' },
    maniac: { label: 'Maniac', tip: 'Bets and raises with almost anything. Call down lighter, let them bluff into you, and do not bluff them.' },
    station: { label: 'Calling station', tip: 'Calls far too much. Value bet thinner and bigger, and skip the bluffs.' },
    lag: { label: 'Loose-aggressive', tip: 'Plays lots of hands and pushes. Defend wider and re-raise your strong hands for value.' },
    tag: { label: 'Tight-aggressive', tip: 'Solid and selective. Respect big bets on later streets and steal when they check.' },
    nit: { label: 'Nit', tip: 'Plays very few hands. Fold to their heavy aggression and bluff them when they show weakness.' },
    rock: { label: 'Tight-passive', tip: 'Rarely bets without a real hand. When they raise, believe them.' },
    loosePassive: { label: 'Loose-passive', tip: 'Sees lots of flops and calls more than they bet. Bet your good hands; bluff only after they check twice.' },
    regular: { label: 'Average', tip: 'No big leaks showing yet. Play straightforward, solid poker.' },
  };

  function classifyPlayer(stats) {
    let key;
    const ratio = stats.pfr / Math.max(stats.vpip, 0.01);
    if (stats.hands < 8 && stats.postflopActions < 8) key = 'unknown';
    else if (stats.vpip >= 0.45 && (stats.af >= 3 || stats.pfr >= 0.3 || (stats.raw.bluffShare != null && stats.raw.bluffShare >= 0.5))) key = 'maniac';
    else if (stats.vpip >= 0.35 && (ratio < 0.4 || stats.af < 1.2)) key = 'station';
    else if (stats.vpip >= 0.27 && stats.pfr >= 0.19) key = 'lag';
    else if (stats.vpip <= 0.16) key = ratio >= 0.55 ? 'nit' : 'rock';
    else if (stats.vpip <= 0.27 && ratio >= 0.6) key = 'tag';
    else if (ratio < 0.45) key = stats.vpip >= 0.26 ? 'loosePassive' : 'rock';
    else key = 'regular';
    return Object.assign({ key }, PLAYER_TYPES[key]);
  }

  // One line of the extra reads, from observed numbers only.
  function readSummary(stats) {
    const p = (x) => Math.round(x * 100) + '%';
    const r = stats.raw || {}, parts = [];
    const acc = stats.accuracy;
    if (acc) parts.push('range read right ' + acc.hits + ' of ' + acc.n + ' showdowns (' + acc.vsGuess.toFixed(1) + '× better than a guess)');
    if (r.threeBet != null) parts.push('3-bet ' + p(r.threeBet));
    if (r.cbet != null) parts.push('c-bet ' + p(r.cbet));
    const fs = r.foldBySize;
    if (fs && (fs.smallN || fs.largeN)) parts.push('folds to small/big bets ' + (fs.smallN ? p(fs.small) : '–') + '/' + (fs.largeN ? p(fs.large) : '–'));
    if (stats.shown && stats.shown.bets) parts.push('bluffed ' + stats.shown.bluffs + ' of ' + stats.shown.bets + ' shown bets');
    if (r.wtsd != null) parts.push('to showdown ' + p(r.wtsd));
    return parts.join(' · ');
  }

  // Score a shown hand against the range the engine would have put that player on.
  // Returns { top, lr }: top = share of the range's weight on hands it rated more likely
  // than the real one (0 = our top guess), lr = the real hand's weight / the range's average.
  function scoreShow(show, tally, tableStyle) {
    const hole = show.cards.map(parseCard), board = show.board.map(parseCard);
    if (hole.length !== 2 || hole.some((x) => x < 0) || board.some((x) => x < 0) || board.length < 3) return null;
    const stats = computeStats(tally, tableStyle);
    const strengths = { 0: boardStrength([]) };
    for (const n of [3, 4, 5]) if (board.length >= n) strengths[n] = boardStrength(board.slice(0, n));
    const W = buildRange(stats, show.actions || {}, strengths, board, show.sizes, show.pfAggressor, show.position, true);
    const k = COMBO_INDEX[hole[0] * 52 + hole[1]];
    // Where the real hand ranked by strength (on the final board) inside our range.
    const sq = rangeQuantiles(W, strengths[board.length].hs)[k];
    let total = 0, above = 0, same = 0, live = 0;
    for (let j = 0; j < NUM_COMBOS; j++) {
      if (!(W[j] >= 0) || board.includes(COMBO_HI[j]) || board.includes(COMBO_LO[j])) continue;
      live++;
      total += W[j];
      if (W[j] > W[k] + 1e-12) above += W[j];
      else if (Math.abs(W[j] - W[k]) <= 1e-12) same += W[j];
    }
    if (!(total > 0)) return null;
    return {
      top: Math.round(((above + same / 2) / total) * 1000) / 1000,
      lr: Math.round((W[k] / (total / live)) * 100) / 100,
      sq: Math.round(sq * 1000) / 1000,
    };
  }

  function percentiles(scores, valid, count, out) {
    const keys = new Float64Array(count);
    for (let i = 0; i < count; i++) keys[i] = scores[valid[i]] * 2048 + valid[i];
    keys.sort();
    let i = 0;
    const denom = Math.max(1, count - 1);
    while (i < count) {
      const s = Math.floor(keys[i] / 2048);
      let j = i;
      while (j < count && Math.floor(keys[j] / 2048) === s) j++;
      const p = (i + (j - i - 1) / 2) / denom;
      for (let x = i; x < j; x++) out[keys[x] % 2048] = p;
      i = j;
    }
  }

  function boardStrength(board) {
    const n = board.length;
    const hs = new Float64Array(NUM_COMBOS).fill(-1);
    const pot = new Float64Array(NUM_COMBOS);
    const ehs = new Float64Array(NUM_COMBOS).fill(-1);

    if (n === 0) {
      for (let k = 0; k < NUM_COMBOS; k++) { hs[k] = ehs[k] = COMBO_PREFLOP_STRENGTH[k]; }
      return { hs, pot, ehs, street: 0 };
    }

    const dead = new Uint8Array(52);
    board.forEach((c) => { dead[c] = 1; });
    const buf = new Int32Array(8);
    for (let i = 0; i < n; i++) buf[i] = board[i];

    const scores = new Int32Array(NUM_COMBOS);
    const valid = new Int16Array(NUM_COMBOS);
    let count = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      const a = COMBO_HI[k], b = COMBO_LO[k];
      if (dead[a] || dead[b]) continue;
      buf[n] = a; buf[n + 1] = b;
      scores[k] = evaluate(buf, n + 2);
      valid[count++] = k;
    }
    percentiles(scores, valid, count, hs);

    if (n < 5) {
      const potSum = new Float64Array(NUM_COMBOS);
      const potCnt = new Uint8Array(NUM_COMBOS);
      const hs2 = new Float64Array(NUM_COMBOS);
      const valid2 = new Int16Array(NUM_COMBOS);
      buf[n] = 0;
      for (let x = 0; x < 52; x++) {
        if (dead[x]) continue;
        buf[n] = x;
        let c2 = 0;
        for (let i = 0; i < count; i++) {
          const k = valid[i];
          const a = COMBO_HI[k], b = COMBO_LO[k];
          if (a === x || b === x) continue;
          buf[n + 1] = a; buf[n + 2] = b;
          scores[k] = evaluate(buf, n + 3);
          valid2[c2++] = k;
        }
        percentiles(scores, valid2, c2, hs2);
        for (let i = 0; i < c2; i++) {
          const k = valid2[i];
          const d = hs2[k] - hs[k];
          if (d > 0) potSum[k] += d;
          potCnt[k]++;
        }
      }
      const scale = n === 3 ? 1.6 : 1;
      for (let i = 0; i < count; i++) {
        const k = valid[i];
        pot[k] = potCnt[k] ? (potSum[k] / potCnt[k]) * scale : 0;
      }
    }
    for (let i = 0; i < count; i++) {
      const k = valid[i];
      ehs[k] = Math.min(1, hs[k] + pot[k]);
    }
    return { hs, pot, ehs, street: n };
  }

  function expandClassWeights(cw) {
    const w = new Float64Array(NUM_COMBOS);
    for (let k = 0; k < NUM_COMBOS; k++) w[k] = cw[COMBO_CLASS[k]];
    return w;
  }

  function preflopRange(stats, action) {
    const cw = new Float64Array(169);
    if (action === 'raise') {
      cw.set(topClassWeights(stats.pfr));
    } else if (action === '3bet') {
      cw.set(topClassWeights(clamp(stats.threeBet != null ? stats.threeBet : stats.pfr * 0.4, 0.025, 0.25)));
    } else if (action === 'call') {
      const v = topClassWeights(stats.vpip), p = topClassWeights(stats.pfr);
      const trap = 0.15 + 0.35 * (1 - stats.pfr / Math.max(stats.vpip, 0.01));
      for (let i = 0; i < 169; i++) cw[i] = Math.max(0, v[i] - p[i] * (1 - trap));
    } else if (action === 'check') {
      const p = topClassWeights(stats.pfr);
      for (let i = 0; i < 169; i++) cw[i] = 1 - 0.85 * p[i];
    } else {
      cw.fill(1);
    }
    return expandClassWeights(cw);
  }

  function rangeQuantiles(W, score) {
    const q = new Float64Array(NUM_COMBOS);
    const idx = [];
    let total = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (W[k] > 0) { idx.push(k); total += W[k]; }
    }
    if (!total) return q;
    idx.sort((a, b) => score[a] - score[b]);
    let cum = 0, i = 0;
    while (i < idx.length) {
      let j = i, gw = 0;
      const s = score[idx[i]];
      while (j < idx.length && score[idx[j]] === s) { gw += W[idx[j]]; j++; }
      const qv = (cum + gw / 2) / total;
      for (let x = i; x < j; x++) q[idx[x]] = qv;
      cum += gw;
      i = j;
    }
    return q;
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  // Share of a player's bets that are for value. `size` (fraction of pot) picks the
  // big-bet or small-bet estimate when we know how much they bet.
  function valueShare(stats, size) {
    if (stats.valueShare == null) return clamp(0.9 - 0.08 * (stats.af - 1), 0.55, 0.9);
    if (size == null || !(size > 0)) return stats.valueShare;
    return size >= BIG_BET ? stats.valueShareBig : stats.valueShareSmall;
  }

  // Street-specific view of a player's stats.
  function streetStats(stats, n) {
    const b = stats.byStreet && stats.byStreet[n];
    return b ? Object.assign({}, stats, b) : stats;
  }

  // Fold probability against a bet of `f` x pot on street `n`: the size model for that
  // street, corrected by how they actually reacted to small, medium and large bets.
  function foldAtSize(stats, f, n) {
    const ss = streetStats(stats, n);
    // Past about pot size, folds grow much more slowly than the curve says: home-game
    // players call overbets more than the pot-odds math suggests.
    const top = SIZE_BUCKETS[SIZE_BUCKETS.length - 1][1];
    const base = f <= top ? modelFold(ss.foldToBet, f) : modelFold(ss.foldToBet, top) + 0.3 * (modelFold(ss.foldToBet, f) - modelFold(ss.foldToBet, top));
    if (!stats.foldBySize) return base;
    const corr = SIZE_BUCKETS.map(([k, c]) => [c, stats.foldBySize[k] - modelFold(stats.foldToBet, c)]);
    let d;
    if (f <= corr[0][0]) d = corr[0][1];
    else if (f >= corr[corr.length - 1][0]) d = corr[corr.length - 1][1];
    else {
      let i = 0;
      while (f > corr[i + 1][0]) i++;
      const w = (f - corr[i][0]) / (corr[i + 1][0] - corr[i][0]);
      d = corr[i][1] * (1 - w) + corr[i + 1][1] * w;
    }
    return clamp(base + d + (stats.foldShift || 0), 0.02, 0.98);
  }

  function aggressionProbs(W, st, freq, vr) {
    const qv = rangeQuantiles(W, st.ehs);
    const valueFrac = freq * vr;
    const bluffFrac = freq * (1 - vr);
    const bluffScore = new Float64Array(NUM_COMBOS);
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (W[k] > 0) {
        const notValue = qv[k] < 1 - valueFrac;
        bluffScore[k] = notValue ? st.pot[k] + 0.3 * Math.pow(1 - st.hs[k], 2) : -1;
      }
    }
    const Wb = new Float64Array(NUM_COMBOS);
    for (let k = 0; k < NUM_COMBOS; k++) if (bluffScore[k] >= 0) Wb[k] = W[k];
    const qb = rangeQuantiles(Wb, bluffScore);
    const bluffCut = 1 - bluffFrac / Math.max(1e-6, 1 - valueFrac);
    const P = new Float64Array(NUM_COMBOS);
    const bluff = new Float64Array(NUM_COMBOS);
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (!(W[k] > 0)) continue;
      const pv = sigmoid((qv[k] - (1 - valueFrac)) / 0.035);
      const pb = Wb[k] > 0 ? sigmoid((qb[k] - bluffCut) / 0.06) : 0;
      bluff[k] = (1 - pv) * pb;
      P[k] = pv + bluff[k];
    }
    P.bluff = bluff;
    return P;
  }

  function applyAction(W, st, action, stats, size, opts) {
    const out = new Float64Array(NUM_COMBOS);
    stats = streetStats(stats, st.street);
    if (opts && opts.cbet && action === 'bet') stats = Object.assign({}, stats, { betFreq: stats.cbet });
    if (opts && opts.cbet && action === 'check') stats = Object.assign({}, stats, { betFreq: stats.cbet });
    const vr = valueShare(stats, size);
    // Big bets come from a narrower, more polarized range; small bets from a wider one
    // that includes more medium hands.
    const sizeScale = !(size > 0) ? 1 : size >= 1 ? 0.8 : size >= BIG_BET ? 0.9 : size < 0.45 ? 1.2 : 1;
    let P;
    if (action === 'bet') {
      P = aggressionProbs(W, st, clamp(stats.betFreq * sizeScale, 0.03, 0.95), vr);
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(0.03, P[k]);
    } else if (action === 'check') {
      P = aggressionProbs(W, st, stats.betFreq, vr);
      const slow = clamp(0.5 - 0.1 * stats.af, 0.1, 0.45);
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(slow, 1 - P[k]);
    } else if (action === 'raise') {
      P = aggressionProbs(W, st, clamp(stats.raiseFreq * 1.2 * sizeScale, 0.04, 0.5), clamp(vr + 0.05, 0.6, 0.92));
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(0.02, P[k]);
    } else if (action === 'call') {
      const q = rangeQuantiles(W, st.ehs);
      const ftb = stats.foldToBet, rf = stats.raiseFreq;
      P = new Float64Array(NUM_COMBOS);
      for (let k = 0; k < NUM_COMBOS; k++) {
        if (!(W[k] > 0)) continue;
        const cont = sigmoid((q[k] - ftb) / 0.05);
        const raisesInstead = 0.6 * sigmoid((q[k] - (1 - rf)) / 0.03);
        P[k] = Math.max(0.03, cont * (1 - raisesInstead));
      }
    } else {
      return W.slice();
    }
    let all = 0, bl = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      out[k] = W[k] * P[k];
      all += out[k];
      if (P.bluff) bl += W[k] * Math.min(P.bluff[k], P[k]);
    }
    // Share of the hands taking this line that do it as a bluff (bets and raises only).
    out.bluffShare = P.bluff && all > 0 ? bl / all : null;
    return out;
  }

  const STREET_ACTION_MAP = {
    check: 'check', bet: 'bet', call: 'call', raise: 'raise',
    checkcall: 'call', checkraise: 'raise',
  };

  function sumWeights(W) {
    let s = 0;
    for (let k = 0; k < NUM_COMBOS; k++) s += W[k];
    return s;
  }

  function buildRange(stats, actions, strengths, deadCards, sizes, pfAggressor, position, noTilt) {
    const pre = position && stats.byPos && stats.byPos[position] ? Object.assign({}, stats, stats.byPos[position]) : stats;
    let W = preflopRange(pre, actions.pre || 'pending');
    const dead = new Uint8Array(52);
    deadCards.forEach((c) => { dead[c] = 1; });
    for (let k = 0; k < NUM_COMBOS; k++) if (dead[COMBO_HI[k]] || dead[COMBO_LO[k]]) W[k] = 0;

    const streets = [['flop', 3], ['turn', 4], ['river', 5]];
    for (const [name, len] of streets) {
      const st = strengths[len];
      const act = STREET_ACTION_MAP[actions[name]];
      if (!st || !act) continue;
      const cbet = name === 'flop' && (pfAggressor || (pfAggressor == null && (actions.pre === 'raise' || actions.pre === '3bet')));
      const next = applyAction(W, st, act, stats, sizes && sizes[name], { cbet });
      if (sumWeights(next) > 1e-9) W = next;
      W.bluffShare = act === 'bet' || act === 'raise' ? next.bluffShare : null;
    }
    if (sumWeights(W) <= 1e-9) {
      for (let k = 0; k < NUM_COMBOS; k++) W[k] = dead[COMBO_HI[k]] || dead[COMBO_LO[k]] ? 0 : 1;
    }
    // Learned correction: if this player's shown hands keep landing below (or above) the
    // middle of the range we predicted, tilt the range weaker (or stronger) to match.
    const bias = stats.strengthBias || 0;
    if (!noTilt && Math.abs(bias) > 0.005) {
      const last = [5, 4, 3].find((n) => strengths[n] && actions[STREET_KEYS[n]]) || 0;
      const q = rangeQuantiles(W, strengths[last].ehs);
      const keep = W.bluffShare;
      for (let k = 0; k < NUM_COMBOS; k++) if (W[k] > 0) W[k] *= Math.exp(8 * bias * (q[k] - 0.5));
      W.bluffShare = keep;
    }
    return W;
  }

  function rangeGrid(W, deadCards) {
    const dead = new Uint8Array(52);
    (deadCards || []).forEach((c) => { dead[c] = 1; });
    const wsum = new Float64Array(169), live = new Float64Array(169);
    let total = 0, liveTotal = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (dead[COMBO_HI[k]] || dead[COMBO_LO[k]]) continue;
      const c = COMBO_CLASS[k];
      live[c]++;
      liveTotal++;
      wsum[c] += W[k];
      total += W[k];
    }
    let max = 0;
    const cells = new Float64Array(169);
    for (let c = 0; c < 169; c++) {
      cells[c] = live[c] ? wsum[c] / live[c] : 0;
      if (cells[c] > max) max = cells[c];
    }
    if (max > 0) for (let c = 0; c < 169; c++) cells[c] /= max;
    const top = [];
    for (let c = 0; c < 169; c++) if (wsum[c] > 0) top.push([c, wsum[c]]);
    top.sort((a, b) => cells[b[0]] - cells[a[0]] || CLASS_RANK[a[0]] - CLASS_RANK[b[0]]);
    return {
      cells,
      combos: max > 0 ? total / max : 0,
      share: liveTotal && max > 0 ? total / max / liveTotal : 0,
      topClasses: top.slice(0, 12).map(([c, w]) => ({ name: CLASS_NAMES[c], share: w / total })),
    };
  }

  function describeHero(hero, board) {
    if (hero.length < 2) return null;
    if (board.length < 3) {
      const k = COMBO_INDEX[hero[0] * 52 + hero[1]];
      const cls = COMBO_CLASS[k];
      return {
        made: CLASS_NAMES[cls],
        preflopRank: CLASS_RANK[cls] + 1,
        topPercent: (1 - CLASS_STRENGTH[cls]) * 100,
        draws: [],
      };
    }
    const cards = hero.concat(board);
    const score = evaluate(cards, cards.length);
    const cat = score >> 20;
    const draws = [];
    if (board.length < 5) {
      const dead = new Uint8Array(52);
      cards.forEach((c) => { dead[c] = 1; });
      let flushOuts = 0, straightOuts = 0;
      for (let x = 0; x < 52; x++) {
        if (dead[x]) continue;
        const s2 = evaluate(cards.concat([x]), cards.length + 1);
        const c2 = s2 >> 20;
        const boardOnly = scoreCategory(evaluate(board.concat([x]), board.length + 1));
        if ((c2 === 5 || c2 === 8) && cat < 5 && boardOnly < 5) flushOuts++;
        else if (c2 === 4 && cat < 4 && boardOnly < 4) straightOuts++;
      }
      if (flushOuts >= 7) draws.push({ name: 'Flush draw', outs: flushOuts });
      else if (flushOuts > 0 && board.length === 3) draws.push({ name: 'Backdoor flush draw', outs: 0 });
      if (straightOuts >= 7) draws.push({ name: 'Open-ended straight draw', outs: straightOuts });
      else if (straightOuts >= 3) draws.push({ name: 'Gutshot straight draw', outs: straightOuts });
    }
    return { made: describeScore(score), category: cat, draws };
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildSampler(W) {
    const idx = [], cum = [];
    let total = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      if (W[k] > 0) { total += W[k]; idx.push(k); cum.push(total); }
    }
    return { idx: Int16Array.from(idx), cum: Float64Array.from(cum), total };
  }

  function sampleCombo(s, r) {
    const x = r * s.total;
    let lo = 0, hi = s.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.cum[mid] < x) lo = mid + 1; else hi = mid;
    }
    return s.idx[lo];
  }

  function continueRule(opp, ctx, mdf, kind) {
    const s = opp.stats;
    if (ctx.street === 0) {
      if (opp.pending) {
        const sizeFactor = Math.min(1, (6 * ctx.bigBlind) / Math.max(ctx.bigBlind, kind.amount));
        const cont = s.vpip * 0.7 * (mdf / 0.375) * Math.sqrt(sizeFactor);
        return { cont: clamp(Math.min(s.vpip, cont), 0.01, 0.95), nut: 0.965, reraise: clamp(s.pfr * 0.4, 0.02, 0.12) };
      }
      const base = opp.actions.pre === 'raise' || opp.actions.pre === '3bet' ? 0.55 : 0.5;
      return { cont: clamp(base * (mdf / 0.5), 0.03, 0.97), nut: 0.965, reraise: 0.2 * base };
    }
    const f = 1 / Math.max(0.05, mdf) - 1;
    let fold = foldAtSize(s, f, ctx.street);
    if (kind.raiseOverAggressor) fold *= 0.75;
    let cont = 1 - fold;
    if (kind.raiseOverAggressor) cont = Math.min(cont, valueShare(s) + (ctx.street < 5 ? 0.1 : 0));
    return {
      cont: clamp(cont, 0.03, 0.97),
      nut: clamp(0.86 + 0.08 * (1 - mdf), 0.86, 0.95) - (kind.raiseOverAggressor ? 0.02 : 0),
      reraise: clamp(streetStats(s, ctx.street).raiseFreq, 0.02, 0.3),
    };
  }

  // ---------- Lookahead over the streets still to come ----------
  // Strength (percentile against every hand) of each combo on boards that are not out
  // yet, computed the first time a runout is needed. On the flop, a turn card's value is
  // the hand's average river percentile over every river, so draws count.
  function makeRunouts(board) {
    const rivers = new Map(), turns = new Map();
    const buf = new Int32Array(7);
    const scores = new Int32Array(NUM_COMBOS);
    const valid = new Int16Array(NUM_COMBOS);
    const tmp = new Float64Array(NUM_COMBOS);
    function strengthOn(b) {
      const dead = new Uint8Array(52);
      for (const c of b) dead[c] = 1;
      for (let i = 0; i < 5; i++) buf[i] = b[i];
      let count = 0;
      for (let k = 0; k < NUM_COMBOS; k++) {
        const a = COMBO_HI[k], c = COMBO_LO[k];
        if (dead[a] || dead[c]) continue;
        buf[5] = a; buf[6] = c;
        scores[k] = evaluate(buf, 7);
        valid[count++] = k;
      }
      percentiles(scores, valid, count, tmp);
      const out = new Float32Array(NUM_COMBOS).fill(-1);
      for (let i = 0; i < count; i++) out[valid[i]] = tmp[valid[i]];
      return out;
    }
    // River strengths for a 4-card board plus x (y < 0), or a flop plus x and y.
    function river(x, y) {
      const key = y < 0 ? x : Math.min(x, y) * 52 + Math.max(x, y);
      let a = rivers.get(key);
      if (!a) {
        a = strengthOn(y < 0 ? board.concat([x]) : board.concat([x, y]));
        rivers.set(key, a);
      }
      return a;
    }
    function turn(t) {
      let a = turns.get(t);
      if (a) return a;
      const sum = new Float64Array(NUM_COMBOS), cnt = new Uint8Array(NUM_COMBOS);
      for (let r = 0; r < 52; r++) {
        if (r === t || board.includes(r)) continue;
        const R = river(t, r);
        for (let k = 0; k < NUM_COMBOS; k++) if (R[k] >= 0) { sum[k] += R[k]; cnt[k]++; }
      }
      a = new Float32Array(NUM_COMBOS).fill(-1);
      for (let k = 0; k < NUM_COMBOS; k++) if (cnt[k]) a[k] = sum[k] / cnt[k];
      turns.set(t, a);
      return a;
    }
    return { river, turn };
  }

  function lowerBound(xs, v) {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  const HERO_BET = 0.66;
  // Opponent versions the lookahead plays against (Pluribus-style leaves): as read, then
  // folding more, calling more, and betting and bluffing more than the read says.
  const VARIANTS = [{}, { foldShift: 0.15, betShift: -0.08 }, { foldShift: -0.15 }, { betShift: 0.15, valueShift: 0.15, raiseShift: 0.1 }];
  const PLAN_SAMPLES = 500;

  /*
   * An opponent's strategy on each street still to come, read off their stats:
   *   - bets for value with the top (betFreq x valueShare) of their range on that street,
   *     and bluffs with a slice of their weakest 35%;
   *   - folds to a bet of f x pot as often as their size-specific fold rate says.
   * Thresholds are quantiles of their strength on random runouts, so they adapt to the
   * board. The same samples tell hero how often it is ahead of their betting range.
   */
  function makePlan(o, ctx) {
    const { street, dead, current, runouts, seed } = ctx;
    const rng = mulberry32(seed);
    const N = PLAN_SAMPLES;
    const streets = street === 3 ? [3, 4, 5] : [4, 5];
    const xs = {};
    for (const s of streets) xs[s] = new Float64Array(N);
    const used = new Uint8Array(52);
    const draw = () => { let x; do { x = Math.floor(rng() * 52); } while (used[x]); used[x] = 1; return x; };
    for (let j = 0; j < N; j++) {
      used.fill(0);
      for (const c of dead) used[c] = 1;
      let k = -1;
      for (let tries = 0; tries < 60 && k < 0; tries++) {
        const cand = sampleCombo(o.sampler, rng());
        if (!used[COMBO_HI[cand]] && !used[COMBO_LO[cand]]) k = cand;
      }
      if (k < 0) do { k = Math.floor(rng() * NUM_COMBOS); } while (used[COMBO_HI[k]] || used[COMBO_LO[k]]);
      used[COMBO_HI[k]] = used[COMBO_LO[k]] = 1;
      xs[street][j] = current.ehs[k];
      if (street === 3) {
        const t = draw(), r = draw();
        xs[4][j] = runouts.turn(t)[k];
        xs[5][j] = runouts.river(t, r)[k];
      } else {
        xs[5][j] = runouts.river(draw(), -1)[k];
      }
    }
    const plan = {};
    for (const s of streets) {
      const x = xs[s].sort();
      const q = (p) => x[clamp(Math.floor(p * (N - 1)), 0, N - 1)];
      const ss = streetStats(o.stats, s);
      const betFreq = clamp(ss.betFreq + (o.stats.betShift || 0), 0.05, 0.9);
      const vr = clamp(valueShare(o.stats, o.stats.betSize) - (o.stats.valueShift || 0), 0.2, 0.97);
      const vCut = q(1 - betFreq * vr);
      const airCut = q(0.35);
      const pBluff = clamp((betFreq * (1 - vr)) / 0.35, 0, 0.9);
      const cum = new Float64Array(N + 1);
      for (let j = 0; j < N; j++) cum[j + 1] = cum[j] + (x[j] >= vCut ? 1 : x[j] < airCut ? pBluff : 0);
      // Fold rate by bet size on a 5%-of-pot grid, so the hot loop does no allocation.
      const grid = new Float64Array(61);
      for (let g = 0; g <= 60; g++) grid[g] = q(foldAtSize(o.stats, g * 0.05, s));
      const callCut = (f) => grid[Math.min(60, Math.round(f * 20))];
      const c0 = lowerBound(x, callCut(HERO_BET));
      // Raises: value raises from the top of their range, plus a few bluff-raises.
      const rf = clamp(ss.raiseFreq + (o.stats.raiseShift || 0), 0.02, 0.35);
      const rCut = q(1 - rf * 0.85);
      const pBluffR = clamp((rf * 0.15) / 0.35, 0, 0.3);
      const cumR = new Float64Array(N + 1);
      for (let j = 0; j < N; j++) cumR[j + 1] = cumR[j] + (x[j] >= rCut ? 1 : x[j] < airCut ? pBluffR : 0);
      plan[s] = {
        rCut, pBluffR,
        // They call a raise of their bet with nearly all of their value range.
        raiseCallCut: q(1 - betFreq * vr * 0.9),
        eqVsRaise: (h) => (cumR[N] > 0 ? cumR[lowerBound(x, h)] / cumR[N] : 1),
        vCut, airCut, pBluff,
        betFrac: o.stats.betSize,
        foldHero: foldAtSize(o.stats, HERO_BET, s),
        callCut,
        // Hero value-bets when it beats 55% of the hands that would call.
        valueCut: c0 < N ? x[c0 + Math.floor(0.55 * (N - 1 - c0))] : 2,
        eqVsCall: (h) => (c0 < N ? Math.max(0, lowerBound(x, h) - c0) / (N - c0) : 1),
        eqVsBet: (h) => (cum[N] > 0 ? cum[lowerBound(x, h)] / cum[N] : 1),
      };
    }
    return plan;
  }

  // ---------- River solver ----------
  /*
   * Heads-up river spots get a small range-vs-range solve with Discounted CFR (the
   * real-time subgame solving behind Libratus and Pluribus), over a tree with a few bet
   * sizes and one raise. The opponent is pinned to their read: at every decision they
   * play the read's strategy with weight p (their exploitWeight) and an adaptive
   * strategy with weight 1 - p (a restricted Nash response). Hero's strategy is solved
   * for every hand in hero's range, so bluffs and bluff-catches come out balanced
   * against what the opponent could have.
   */
  const RIVER_ITERATIONS = 250;

  function riverSolve(cfg) {
    const { board, heroCombo, heroW, oppW, oppStats, p, pot: P0, toCall, stack, heroFirst, bigBlind } = cfg;
    const strengths = cfg.strengths;
    // Hands that are possible on this board.
    const onBoard = new Uint8Array(52);
    board.forEach((c) => { onBoard[c] = 1; });
    const idx = [];
    for (let k = 0; k < NUM_COMBOS; k++) if (!onBoard[COMBO_HI[k]] && !onBoard[COMBO_LO[k]]) idx.push(k);
    const N = idx.length;
    const local = new Int32Array(NUM_COMBOS).fill(-1);
    idx.forEach((k, i) => { local[k] = i; });
    const hi = new Uint8Array(N), lo = new Uint8Array(N);
    const buf = new Int32Array(7);
    for (let i = 0; i < 5; i++) buf[i] = board[i];
    const score = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      hi[i] = COMBO_HI[idx[i]]; lo[i] = COMBO_LO[idx[i]];
      buf[5] = hi[i]; buf[6] = lo[i];
      score[i] = evaluate(buf, 7);
    }
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => score[a] - score[b]);
    const h0 = local[heroCombo];
    if (h0 < 0) return null;

    const rangeOf = (W) => {
      const r = new Float64Array(N);
      for (let i = 0; i < N; i++) r[i] = Math.max(0, W[idx[i]]);
      return r;
    };
    const wH = rangeOf(heroW), wO = rangeOf(oppW);
    // Keep hero's real hand in hero's range even if the range model missed it.
    let meanH = 0;
    for (let i = 0; i < N; i++) meanH += wH[i];
    meanH /= N;
    wH[h0] = Math.max(wH[h0], 0.25 * meanH, 1e-6);

    // Opponent's strength quantile inside their own range (for the read's strategy).
    const qO = rangeQuantiles(oppW, strengths.hs);

    // Blocker-aware showdown masses: for each hand, the other side's reach that is below,
    // tied with and above it, and the total, skipping hands that share a card.
    const below = new Float64Array(N), tie = new Float64Array(N), tot = new Float64Array(N);
    const cum = new Float64Array(52), grp = new Float64Array(52), all = new Float64Array(52);
    function masses(r) {
      cum.fill(0); all.fill(0);
      let T = 0, cT = 0;
      for (let i = 0; i < N; i++) { T += r[i]; all[hi[i]] += r[i]; all[lo[i]] += r[i]; }
      let g = 0;
      while (g < N) {
        let e = g;
        const s = score[order[g]];
        while (e < N && score[order[e]] === s) e++;
        let gT = 0;
        for (let j = g; j < e; j++) { const i = order[j]; gT += r[i]; grp[hi[i]] += r[i]; grp[lo[i]] += r[i]; }
        for (let j = g; j < e; j++) {
          const i = order[j];
          below[i] = cT - cum[hi[i]] - cum[lo[i]];
          tie[i] = gT - grp[hi[i]] - grp[lo[i]] + r[i];
          tot[i] = T - all[hi[i]] - all[lo[i]] + r[i];
        }
        for (let j = g; j < e; j++) { const i = order[j]; cT += r[i]; cum[hi[i]] += r[i]; cum[lo[i]] += r[i]; grp[hi[i]] = 0; grp[lo[i]] = 0; }
        g = e;
      }
    }
    function totals(r) {
      all.fill(0);
      let T = 0;
      for (let i = 0; i < N; i++) { T += r[i]; all[hi[i]] += r[i]; all[lo[i]] += r[i]; }
      for (let i = 0; i < N; i++) tot[i] = T - all[hi[i]] - all[lo[i]] + r[i];
    }

    // ----- tree -----
    const round = (x) => roundChips(x, bigBlind);
    const st5 = streetStats(oppStats, 5);
    const oppBetFrac = clamp(oppStats.betSize || 0.6, 0.33, 1.5);
    // The read's strategy for the opponent at one of their decisions, per hand.
    // vsRaise: hero raised their bet. A player who bet keeps their value hands and gives
    // up most bluffs, whatever their general fold-to-bet rate is.
    function fixedStrategy(acts, facingFrac, vsRaise) {
      const bf = clamp(st5.betFreq, 0.05, 0.9), vrB = valueShare(oppStats, oppBetFrac);
      const nA = acts.length, s = new Float64Array(nA * N);
      for (let i = 0; i < N; i++) {
        const q = qO[idx[i]];
        const pr = new Float64Array(nA);
        if (facingFrac == null) {
          const bf = clamp(st5.betFreq, 0.05, 0.9), vr = valueShare(oppStats, oppBetFrac);
          const pBet = sigmoid((q - (1 - bf * vr)) / 0.035) + (1 - sigmoid((q - (1 - bf * vr)) / 0.035)) * sigmoid((bf * (1 - vr) - q) / 0.035);
          acts.forEach((a, j) => { pr[j] = a.kind === 'check' ? 1 - pBet : pBet / Math.max(1, nA - 1); });
        } else {
          let pCont;
          if (vsRaise && toCall > 0) {
            // Their range here is their betting range: fold the weakest (1 - valueShare) of it.
            pCont = sigmoid((q - 0.9 * (1 - vrB)) / 0.04);
          } else if (vsRaise) {
            // They bet inside the tree: value hands continue, bluffs mostly fold.
            pCont = q >= 1 - bf * vrB ? 1 : q < bf * (1 - vrB) ? 0.1 : 0.5;
          } else {
            pCont = sigmoid((q - foldAtSize(oppStats, facingFrac, 5)) / 0.04);
          }
          const pRaise = sigmoid((q - (1 - clamp(st5.raiseFreq, 0.02, 0.3))) / 0.03);
          const hasRaise = acts.some((a) => a.kind === 'raise');
          acts.forEach((a, j) => {
            if (a.kind === 'fold') pr[j] = 1 - pCont;
            else if (a.kind === 'raise') pr[j] = pCont * pRaise;
            else pr[j] = pCont * (hasRaise ? 1 - pRaise : 1);
          });
        }
        let t = 0;
        for (let j = 0; j < nA; j++) t += pr[j];
        for (let j = 0; j < nA; j++) s[j * N + i] = t > 0 ? pr[j] / t : 1 / nA;
      }
      return s;
    }

    function node(player, hIn, oIn, facing, raisesLeft, lastToAct, vsRaise) {
      const potNow = P0 + hIn + oIn;
      const myIn = player === 0 ? hIn : oIn;
      const left = stack - myIn;
      const acts = [];
      const kids = [];
      const add = (a, child) => { if (!acts.some((x) => x.kind === a.kind && Math.abs(x.amount - a.amount) < 1e-9)) { acts.push(a); kids.push(child); } };
      const after = (amt) => (player === 0 ? [hIn + amt, oIn] : [hIn, oIn + amt]);
      if (facing > 0) {
        add({ kind: 'fold', amount: 0 }, { term: 'fold', winner: 1 - player, hIn, oIn });
        const c = Math.min(facing, left);
        const [h2, o2] = after(c);
        add({ kind: c >= left ? 'allin' : 'call', amount: c }, { term: 'show', hIn: h2, oIn: o2 });
        if (raisesLeft > 0 && left > facing) {
          const r = Math.min(left, round(facing + (potNow + facing)));
          const [h3, o3] = after(r);
          add({ kind: r >= left ? 'allin' : 'raise', amount: r, frac: (r - facing) / (potNow + facing) }, () => node(1 - player, h3, o3, r - facing, raisesLeft - 1, true, true));
        }
      } else {
        add({ kind: 'check', amount: 0 }, lastToAct ? { term: 'show', hIn, oIn } : () => node(1 - player, hIn, oIn, 0, raisesLeft, true));
        const fracs = player === 0 ? [0.33, 0.66, 1] : [oppBetFrac];
        for (const f of fracs) {
          const b = Math.min(left, round(f * potNow));
          if (b <= 0) continue;
          const [h2, o2] = after(b);
          add({ kind: b >= left ? 'allin' : 'bet', amount: b, frac: b / potNow }, () => node(1 - player, h2, o2, b, raisesLeft, true));
        }
      }
      const n = { player, acts, kids: kids.map((k) => (typeof k === 'function' ? k() : k)), hIn, oIn };
      const nA = acts.length;
      n.regret = new Float64Array(nA * N);
      n.sum = new Float64Array(nA * N);
      if (player === 1) n.fixed = fixedStrategy(acts, facing > 0 ? facing / (potNow - facing) : null, !!vsRaise);
      return n;
    }
    const root = toCall > 0 ? node(0, 0, 0, toCall, 1, true) : node(0, 0, 0, 0, 1, !heroFirst);

    // ----- Discounted CFR: positive regrets discounted by t^1.5/(t^1.5+1), negative regrets
    // reset to zero (as in CFR+), average strategy weighted by (t/(t+1))^2 -----
    function strategy(n, out) {
      const nA = n.acts.length;
      for (let i = 0; i < N; i++) {
        let t = 0;
        for (let a = 0; a < nA; a++) { const r = n.regret[a * N + i]; if (r > 0) t += r; }
        for (let a = 0; a < nA; a++) {
          const r = n.regret[a * N + i];
          out[a * N + i] = t > 0 ? (r > 0 ? r / t : 0) : 1 / nA;
        }
      }
      if (n.player === 1) for (let j = 0; j < nA * N; j++) out[j] = p * n.fixed[j] + (1 - p) * out[j];
      return out;
    }
    let iter = 0;
    function cfr(n, trav, rH, rO, avg) {
      if (n.term) {
        const v = new Float64Array(N);
        const potF = P0 + n.hIn + n.oIn;
        if (n.term === 'fold') {
          const heroGain = n.winner === 0 ? P0 + n.oIn : -n.hIn;
          totals(trav === 0 ? rO : rH);
          const g = trav === 0 ? heroGain : P0 - heroGain;
          for (let i = 0; i < N; i++) v[i] = g * tot[i];
        } else {
          masses(trav === 0 ? rO : rH);
          for (let i = 0; i < N; i++) {
            const heroish = potF * (below[i] + tie[i] / 2) - (trav === 0 ? n.hIn : n.oIn) * tot[i];
            v[i] = heroish;
          }
          // For the opponent the same formula holds from their side: they win the pot when
          // the hero hand is below theirs. (Zero-sum up to the sunk pot.)
        }
        return v;
      }
      const nA = n.acts.length;
      const s = new Float64Array(nA * N);
      if (avg) {
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += n.sum[a * N + i];
          for (let a = 0; a < nA; a++) s[a * N + i] = t > 0 ? n.sum[a * N + i] / t : 1 / nA;
        }
      } else strategy(n, s);
      const v = new Float64Array(N);
      const own = n.player === trav;
      const vals = own ? [] : null;
      for (let a = 0; a < nA; a++) {
        const r2 = new Float64Array(N);
        const base = n.player === 0 ? rH : rO;
        for (let i = 0; i < N; i++) r2[i] = base[i] * s[a * N + i];
        const va = n.player === 0 ? cfr(n.kids[a], trav, r2, rO, avg) : cfr(n.kids[a], trav, rH, r2, avg);
        if (own) { vals.push(va); for (let i = 0; i < N; i++) v[i] += s[a * N + i] * va[i]; }
        else for (let i = 0; i < N; i++) v[i] += va[i];
      }
      if (own && !avg) {
        const pos = Math.pow(iter, 1.5) / (Math.pow(iter, 1.5) + 1);
        const w = Math.pow(iter / (iter + 1), 2);
        const reach = n.player === 0 ? rH : rO;
        for (let a = 0; a < nA; a++) {
          for (let i = 0; i < N; i++) {
            const j = a * N + i;
            const r = n.regret[j];
            n.regret[j] = (r > 0 ? r * pos : 0) + vals[a][i] - v[i];
            n.sum[j] = n.sum[j] * w + reach[i] * s[j];
          }
        }
      }
      if (own && avg) n.vals = vals;
      return v;
    }
    const iterations = cfg.iterations || RIVER_ITERATIONS;
    for (iter = 1; iter <= iterations; iter++) {
      cfr(root, 0, wH, wO, false);
      cfr(root, 1, wH, wO, false);
    }
    // Final pass with average strategies: EV of each root action for hero's real hand.
    cfr(root, 0, wH, wO, true);
    totals(wO);
    const norm = tot[h0] > 0 ? tot[h0] : 1;
    let t = 0;
    for (let a = 0; a < root.acts.length; a++) t += root.sum[a * N + h0];
    return {
      iterations,
      actions: root.acts.map((a, j) => ({
        kind: a.kind, amount: a.amount, frac: a.frac,
        freq: t > 0 ? root.sum[j * N + h0] / t : 1 / root.acts.length,
        ev: root.vals[j][h0] / norm,
      })),
    };
  }

  /*
   * input = {
   *   hero: [c, c], board: [..0/3/4/5 cards],
   *   pot, toCall, stack (number or null), bigBlind, inPosition (default true),
   *   tableStyle: 'tight' | 'typical' | 'loose',
   *   opponents: [{ name, tally, actions: { pre, flop, turn, river } }]   // only players still in the hand
   * }
   */
  function createAnalysis(input) {
    const hero = input.hero.slice();
    const board = input.board.slice();
    const street = board.length;
    const pot = Math.max(0, +input.pot || 0);
    const toCall = Math.max(0, +input.toCall || 0);
    const stack = input.stack > 0 ? +input.stack : Infinity;
    const bigBlind = input.bigBlind > 0 ? +input.bigBlind : 1;
    const tableStyle = input.tableStyle || 'typical';
    const streetName = ['preflop', null, null, 'flop', 'turn', 'river'][street];

    const strengths = { 0: boardStrength([]) };
    if (street >= 3) strengths[3] = boardStrength(board.slice(0, 3));
    if (street >= 4) strengths[4] = boardStrength(board.slice(0, 4));
    if (street >= 5) strengths[5] = boardStrength(board);
    const current = strengths[street];
    const dead = hero.concat(board);

    const opps = input.opponents.map((o) => {
      const stats = computeStats(o.tally, tableStyle);
      const actions = Object.assign({ pre: 'call', flop: '', turn: '', river: '' }, o.actions || {});
      const currentAction = actions[streetName] || '';
      const pending = street === 0 ? (actions.pre || 'pending') === 'pending' : !currentAction;
      const W = buildRange(stats, actions, strengths, dead, o.sizes, o.pfAggressor, o.position);
      const qCont = rangeQuantiles(W, current.ehs);
      const displayW = street === 0 && pending ? buildRange(stats, { pre: 'call' }, strengths, dead, null, null, o.position) : W;
      const aggressor = street === 0
        ? actions.pre === 'raise' || actions.pre === '3bet'
        : currentAction === 'bet' || currentAction === 'raise' || currentAction === 'checkraise';
      return {
        name: o.name, stats, type: classifyPlayer(stats), actions, pending, aggressor,
        W, sampler: buildSampler(W), qCont, grid: rangeGrid(displayW, dead),
      };
    });

    // Hero's story: if hero's line this hand looks strong (as a typical player's range would
    // with the same actions), opponents fold a little more to hero's bets, and less after a
    // weak-looking line.
    let credibility = 0;
    if (street > 0 && input.heroActions) {
      const hW = buildRange(computeStats({}, tableStyle), input.heroActions, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true);
      let a = 0, aw = 0, u = 0, un = 0;
      for (let k = 0; k < NUM_COMBOS; k++) {
        if (current.ehs[k] < 0) continue;
        a += hW[k] * current.ehs[k]; aw += hW[k]; u += current.ehs[k]; un++;
      }
      if (aw > 0 && un > 0) credibility = a / aw - u / un;
      const shift = clamp(0.4 * credibility, -0.08, 0.08);
      for (const o of opps) o.stats = Object.assign({}, o.stats, { foldShift: shift });
    }

    const scenarios = [];
    const cap = (x) => Math.min(x, stack);
    const fmtFrac = (f) => ({ 0.33: '⅓ pot', 0.5: '½ pot', 0.75: '¾ pot', 1: 'pot', 1.5: '1½ pot', 2: '2× pot overbet' })[f] || Math.round(f * 100) + '% pot';
    const addScenario = (s) => {
      if (scenarios.some((x) => x.kind === s.kind && Math.abs(x.amount - s.amount) < 1e-9)) return;
      scenarios.push(s);
    };

    const shoveMakesSense = isFinite(stack) && (street === 0
      ? stack <= 25 * bigBlind || stack <= 3 * (pot + toCall)
      : stack <= 2.5 * (pot + toCall));

    if (toCall <= 0) {
      addScenario({ kind: 'check', label: 'Check', amount: 0 });
      const fracs = street === 0 ? [0.75, 1, 1.5] : [0.33, 0.5, 0.75, 1, 1.5];
      for (const f of fracs) {
        const amt = cap(Math.max(bigBlind, roundChips(f * pot, bigBlind)));
        addScenario({ kind: amt >= stack ? 'allin' : 'bet', label: amt >= stack ? 'All-in' : 'Bet', sizeLabel: fmtFrac(f), amount: amt });
      }
      if (shoveMakesSense) addScenario({ kind: 'allin', label: 'All-in', amount: stack });
    } else {
      addScenario({ kind: 'fold', label: 'Fold', amount: 0 });
      addScenario({ kind: toCall >= stack ? 'allin' : 'call', label: toCall >= stack ? 'Call all-in' : 'Call', amount: cap(toCall) });
      if (stack > toCall) {
        const fracs = street === 0 ? [0.6, 1, 1.6] : [0.6, 1];
        for (const f of fracs) {
          const amt = cap(roundChips(toCall + f * (pot + toCall), bigBlind));
          const label = street === 0 ? (f === 0.6 ? 'small raise' : f === 1 ? 'pot-size raise' : 'big raise') : (f === 1 ? 'pot-size raise' : 'raise');
          addScenario({ kind: amt >= stack ? 'allin' : 'raise', label: amt >= stack ? 'All-in' : 'Raise', sizeLabel: label, amount: amt });
        }
        if (shoveMakesSense) addScenario({ kind: 'allin', label: 'All-in', amount: stack });
      }
    }

    const ctx = { street, bigBlind };
    let bigBlindSeat = -1;
    if (street === 0 && toCall > 0 && toCall <= bigBlind) {
      for (let i = opps.length - 1; i >= 0; i--) if (opps[i].pending) { bigBlindSeat = i; break; }
    }
    for (const sc of scenarios) {
      sc.opp = opps.map((o, i) => {
        const stay = { cont: 1, nut: 0, add: 0 };
        if (sc.kind === 'fold') return stay;
        if (sc.kind === 'check') {
          if (street === 0 && o.pending) return Object.assign(continueRule(o, ctx, 0.6, { amount: 0 }), { add: 0 });
          return stay;
        }
        const raising = sc.amount > toCall + 1e-9;
        if (!raising) {
          if (!o.pending) return stay;
          if (i === bigBlindSeat) return { cont: 1, nut: 0, add: 0, reraise: clamp(o.stats.pfr * 0.6, 0.02, 0.2) };
          const rule = continueRule(o, ctx, pot / (pot + toCall), { amount: toCall });
          rule.add = toCall;
          rule.reraise = street === 0 ? clamp(toCall <= bigBlind ? o.stats.pfr : o.stats.pfr * 0.4, 0.02, 0.3) : Math.min(rule.reraise, rule.cont);
          if (toCall >= stack) rule.reraise = 0;
          return rule;
        }
        let rule;
        if (i === bigBlindSeat) {
          const cont = clamp(o.stats.vpip * 1.6 * Math.sqrt((2.5 * bigBlind) / sc.amount), 0.05, 0.9);
          rule = { cont, nut: 0.965, reraise: clamp(o.stats.pfr * 0.4, 0.02, 0.12) / Math.max(cont, 0.05), add: sc.amount - bigBlind };
        } else {
          const mdf = o.pending ? pot / (pot + sc.amount) : (pot + toCall) / (pot + sc.amount);
          rule = continueRule(o, ctx, mdf, { amount: sc.amount, raiseOverAggressor: toCall > 0 && o.aggressor });
          rule.add = o.pending ? sc.amount : sc.amount - toCall;
          if (!(street === 0 && o.pending)) rule.reraise = Math.min(rule.reraise, rule.cont);
        }
        if (sc.amount >= stack) rule.reraise = 0;
        return rule;
      });
      Object.assign(sc, {
        n: 0, gainSum: 0, gainSq: 0, foldAll: 0, showdowns: 0, shareSum: 0, wins: 0, ties: 0,
        vsWins: new Float64Array(opps.length), vsTies: new Float64Array(opps.length), vsCount: new Float64Array(opps.length),
        oppFolds: new Float64Array(opps.length), reraised: 0, looked: 0, varSum: new Float64Array(VARIANTS.length),
      });
    }

    const heroCombo = COMBO_INDEX[hero[0] * 52 + hero[1]];
    const heroStrength = current.ehs[heroCombo];
    const heroStandsReraise = heroStrength >= (street === 0 ? 0.9 : 0.8);

    // Play out the later streets when hero ends up heads-up on the flop or turn.
    const lookahead = (street === 3 || street === 4) && input.lookahead !== false;
    const runouts = lookahead ? makeRunouts(board) : null;
    const plans = [];

    const inPosition = input.inPosition !== false;
    let realize = 1;
    if (street === 0) {
      // No preflop lookahead (a flop-by-flop playout is too slow for a phone), so how much of
      // its equity a hand turns into chips is estimated from what makes hands play well:
      // position, suitedness, connectedness, pairs, how many opponents and how deep stacks are.
      const ra = hero[0] >> 2, rb = hero[1] >> 2, gap = Math.abs(ra - rb);
      let play = 0;
      if ((hero[0] & 3) === (hero[1] & 3)) play += 0.04;
      if (ra === rb) play += 0.02;
      else if (gap <= 2) play += 0.02;
      else if (gap >= 4 && (hero[0] & 3) !== (hero[1] & 3)) play -= 0.04;
      const spr = isFinite(stack) ? stack / Math.max(1, pot + toCall) : 30;
      if (spr > 15) play *= 1.5;
      realize = 0.78 + 0.22 * heroStrength + (inPosition ? 0.06 : -0.04) + play - 0.04 * Math.max(0, opps.length - 1);
    }
    else if (street < 5) realize = 0.88 + 0.12 * heroStrength + (inPosition ? 0.04 : -0.04);
    realize = clamp(realize, 0.6, 1);

    const seed = (input.seed >>> 0) || 0x9e3779b9;
    const runnable = scenarios.filter((s) => s.kind !== 'fold');
    let target = input.iterations || 30000;
    const cards = new Int32Array(7);
    const used = new Uint8Array(52);
    const oppCombo = new Int16Array(opps.length);
    const oppScore = new Int32Array(opps.length);
    const oppIn = new Uint8Array(opps.length);
    const varGain = new Float64Array(VARIANTS.length);
    const addNow = new Float64Array(opps.length);

    // Side pots. With each player's chips in the pot so far (`committed`) and behind
    // (`stack`), an all-in player can only win what they matched from each other player.
    const oppLeft = new Float64Array(opps.length).fill(Infinity);
    input.opponents.forEach((o, i) => { if (o.stack != null && o.stack >= 0) oppLeft[i] = o.stack; });
    const sidePots = input.heroCommitted != null && input.opponents.every((o) => o.committed != null) &&
      input.opponents.some((o) => o.stack != null && o.stack < (isFinite(stack) ? stack : Infinity));
    const contrib = new Float64Array(opps.length + 1);
    function sidePotWin(heroAdd, heroScore) {
      let committedSum = input.heroCommitted;
      contrib[0] = input.heroCommitted + heroAdd;
      for (let i = 0; i < opps.length; i++) {
        committedSum += input.opponents[i].committed;
        contrib[i + 1] = input.opponents[i].committed + (oppIn[i] ? addNow[i] : 0);
      }
      const deadMoney = Math.max(0, pot - committedSum);
      const levels = [];
      if (contrib[0] > 0) levels.push(contrib[0]);
      for (let i = 0; i < opps.length; i++) if (oppIn[i]) levels.push(contrib[i + 1]);
      levels.sort((a, b) => a - b);
      let prev = 0, won = 0;
      for (let li = 0; li < levels.length; li++) {
        const L = levels[li];
        if (L <= prev) continue;
        let layer = 0;
        for (let j = 0; j <= opps.length; j++) layer += Math.min(contrib[j], L) - Math.min(contrib[j], prev);
        if (li === 0) layer += deadMoney;
        // Eligible: hero (if it reached this level) and opponents still in who did.
        let best = -1, n = 0, heroIn = contrib[0] >= L;
        if (heroIn) { best = heroScore; n = 1; }
        for (let i = 0; i < opps.length; i++) {
          if (!oppIn[i] || contrib[i + 1] < L) continue;
          if (oppScore[i] > best) { best = oppScore[i]; n = 1; heroIn = false; }
          else if (oppScore[i] === best) n++;
        }
        if (heroIn && heroScore === best) won += layer / n;
        prev = L;
      }
      return won;
    }
    let done = 0;

    function strengthAt(s, k) {
      if (s === street) return current.ehs[k];
      if (s === 4) return runouts.turn(cards[5])[k];
      return street === 3 ? runouts.river(cards[5], cards[6])[k] : runouts.river(cards[6], -1)[k];
    }

    // Hero and opponent i are alone with `P` in the pot and hero has put in `heroIn` with
    // this decision. Bet the remaining streets with both strategies and return hero's gain.
    // Simplifications: no raises after this decision, and hero only bluffs the river.
    function planFor(i, v) {
      const key = i * VARIANTS.length + v;
      if (!plans[key]) {
        const st = Object.assign({}, opps[i].stats, VARIANTS[v]);
        st.foldShift = (VARIANTS[v].foldShift || 0) + (opps[i].stats.foldShift || 0);
        plans[key] = makePlan({ stats: st, sampler: opps[i].sampler },
          { street, dead, current, runouts, seed: (seed ^ (0x5bd1e995 + i * 7919)) >>> 0 });
      }
      return plans[key];
    }

    // Hero and opponent i are alone with `P` in the pot and hero has put in `heroIn` with
    // this decision. Bet the remaining streets with both strategies and return hero's gain.
    // Either side can raise once per street; hero only bluffs the river.
    function playOut(i, P, heroIn, share, rng, startCur, v) {
      const plan = planFor(i, v);
      const oc = oppCombo[i];
      let left = stack - heroIn, extra = 0;
      for (let s = startCur ? street : street + 1; s <= 5; s++) {
        if (left <= 0) break;
        const t = plan[s];
        const sh = strengthAt(s, heroCombo), so = strengthAt(s, oc);
        const oppBets = () => so >= t.vCut || (so < t.airCut && rng() < t.pBluff);
        // Opponent bets; hero folds (false), calls, or raises with a monster.
        const heroFaces = () => {
          const B = Math.min(left, roundChips(t.betFrac * P, bigBlind));
          const eq = t.eqVsBet(sh);
          if (eq >= 0.8 && left > B) {
            const R = Math.min(left, roundChips(B + (P + 2 * B), bigBlind));
            if (so < t.raiseCallCut) { P += B + B; extra += B; left -= B; return 'won'; }
            P += 2 * R; extra += R; left -= R;
            return true;
          }
          if (eq < B / (P + 2 * B)) return false;
          P += 2 * B; extra += B; left -= B;
          return true;
        };
        // Hero bets for value or as a river bluff; the opponent folds, calls or raises.
        const heroBets = () => {
          const B = Math.min(left, roundChips(HERO_BET * P, bigBlind));
          const value = sh >= t.valueCut;
          const bluff = !value && s === 5 && t.eqVsCall(sh) < 0.2 && t.foldHero * P - (1 - t.foldHero) * B > 0.05 * P;
          if (!value && !bluff) return 'check';
          const raises = left > B && (so >= t.rCut || (so < t.airCut && rng() < t.pBluffR));
          if (!raises && so < t.callCut(B / P)) return 'won';
          if (raises) {
            const R = Math.min(left, roundChips(B + (P + 2 * B), bigBlind));
            const potBefore = P + B + R;
            if (t.eqVsRaise(sh) < (R - B) / (potBefore + R - B)) { P += B + R; extra += B; return 'lost'; }
            P += 2 * R; extra += R; left -= R;
            return 'called';
          }
          P += 2 * B; extra += B; left -= B;
          return 'called';
        };
        let r;
        if (s === street) {
          // Hero checked; the opponent acts behind.
          if (oppBets()) r = heroFaces();
          if (r === false) return -heroIn - extra;
          if (r === 'won') return P - heroIn - extra;
        } else if (inPosition) {
          if (oppBets()) {
            r = heroFaces();
            if (r === false) return -heroIn - extra;
            if (r === 'won') return P - heroIn - extra;
          } else {
            r = heroBets();
            if (r === 'won') return P - heroIn - extra;
            if (r === 'lost') return -heroIn - extra;
          }
        } else {
          r = heroBets();
          if (r === 'won') return P - heroIn - extra;
          if (r === 'lost') return -heroIn - extra;
          if (r === 'check' && oppBets()) {
            const f = heroFaces();
            if (f === false) return -heroIn - extra;
            if (f === 'won') return P - heroIn - extra;
          }
        }
      }
      return share * P - heroIn - extra;
    }

    // Same idea with two or more opponents left: on each later street the first player
    // whose plan says bet does so, the others call or fold, and hero calls when its chance
    // of beating the bettor and every caller beats the price. No raises here.
    const multiAlive = new Uint8Array(opps.length);
    function playOutMulti(list, P, heroIn, heroScore, rng, v) {
      let left = stack - heroIn, extra = 0;
      multiAlive.fill(0);
      for (const i of list) multiAlive[i] = 1;
      for (let s = street + 1; s <= 5; s++) {
        if (left <= 0) break;
        const sh = strengthAt(s, heroCombo);
        let bettor = -2, B = 0;
        const heroValue = () => list.every((i) => !multiAlive[i] || sh >= planFor(i, v)[s].valueCut);
        const tryOpps = () => {
          for (const i of list) {
            if (!multiAlive[i]) continue;
            const t = planFor(i, v)[s], so = strengthAt(s, oppCombo[i]);
            if (so >= t.vCut || (so < t.airCut && rng() < t.pBluff)) { bettor = i; B = Math.min(left, roundChips(t.betFrac * P, bigBlind)); return; }
          }
        };
        if (!inPosition && heroValue()) { bettor = -1; B = Math.min(left, roundChips(HERO_BET * P, bigBlind)); }
        if (bettor === -2) tryOpps();
        if (bettor === -2 && inPosition && heroValue()) { bettor = -1; B = Math.min(left, roundChips(HERO_BET * P, bigBlind)); }
        if (bettor === -2) continue;
        P += B;
        if (bettor === -1) { extra += B; left -= B; }
        let eq = bettor >= 0 ? planFor(bettor, v)[s].eqVsBet(sh) : 1;
        let callers = 0;
        for (const j of list) {
          if (!multiAlive[j] || j === bettor) continue;
          const t = planFor(j, v)[s];
          if (strengthAt(s, oppCombo[j]) >= t.callCut(B / Math.max(1, P - B))) { P += B; callers++; eq *= t.eqVsCall(sh); }
          else multiAlive[j] = 0;
        }
        if (bettor === -1) {
          if (!callers) return P - heroIn - extra;
        } else {
          if (eq < B / (P + B)) return -heroIn - extra;
          P += B; extra += B; left -= B;
        }
      }
      let best = heroScore, n = 1, heroBest = true;
      for (const i of list) {
        if (!multiAlive[i]) continue;
        if (oppScore[i] > best) { best = oppScore[i]; n = 1; heroBest = false; }
        else if (oppScore[i] === best) n++;
      }
      return (heroBest ? P / n : 0) - heroIn - extra;
    }

    function runScenario(sc, start, count) {
      const rng = mulberry32((seed + start * 2654435761) >>> 0);
      for (let it = 0; it < count; it++) {
        used.fill(0);
        for (const c of dead) used[c] = 1;
        for (let i = 0; i < opps.length; i++) {
          const s = opps[i].sampler;
          let k = -1;
          for (let tries = 0; tries < 60; tries++) {
            const cand = sampleCombo(s, rng());
            if (!used[COMBO_HI[cand]] && !used[COMBO_LO[cand]]) { k = cand; break; }
          }
          if (k < 0) {
            do { k = Math.floor(rng() * NUM_COMBOS); } while (used[COMBO_HI[k]] || used[COMBO_LO[k]]);
          }
          oppCombo[i] = k;
          used[COMBO_HI[k]] = used[COMBO_LO[k]] = 1;
        }
        let anyIn = 0, reraisedBy = -1;
        for (let i = 0; i < opps.length; i++) {
          const r = rng();
          const rule = sc.opp[i];
          const q = street === 0 && opps[i].pending ? current.hs[oppCombo[i]] : opps[i].qCont[oppCombo[i]];
          if (rule.cont >= 0.999) oppIn[i] = 1;
          else {
            const pRel = sigmoid((q - (1 - rule.cont)) / 0.04);
            const pNut = sigmoid((current.hs[oppCombo[i]] - rule.nut) / 0.015);
            oppIn[i] = r < Math.max(pRel, pNut) ? 1 : 0;
          }
          if (!oppIn[i]) sc.oppFolds[i]++;
          else if (rule.reraise > 0 && q >= 1 - rule.reraise) reraisedBy = i;
          anyIn |= oppIn[i];
        }
        for (let i = 0; i < street; i++) cards[i + 2] = board[i];
        for (let i = street; i < 5; i++) {
          let x;
          do { x = Math.floor(rng() * 52); } while (used[x]);
          used[x] = 1;
          cards[i + 2] = x;
        }
        let gain;
        varGain.fill(NaN);
        if (!anyIn) {
          gain = pot;
          sc.foldAll++;
        } else if (reraisedBy >= 0 && !heroStandsReraise) {
          gain = -sc.amount;
          sc.reraised++;
        } else {
          cards[0] = hero[0]; cards[1] = hero[1];
          const hs = evaluate(cards, 7);
          let best = hs, nBest = 1, heroBest = true, finalPot = pot + sc.amount;
          for (let i = 0; i < opps.length; i++) {
            if (!oppIn[i]) continue;
            addNow[i] = Math.min(sc.opp[i].add, oppLeft[i]);
            finalPot += addNow[i];
            cards[0] = COMBO_HI[oppCombo[i]]; cards[1] = COMBO_LO[oppCombo[i]];
            const s = evaluate(cards, 7);
            oppScore[i] = s;
            if (s > best) { best = s; nBest = 1; heroBest = false; }
            else if (s === best) nBest++;
            sc.vsCount[i]++;
            if (hs > s) sc.vsWins[i]++;
            else if (hs === s) sc.vsTies[i]++;
          }
          const share = heroBest ? 1 / nBest : 0;
          let inCount = 0, lastIn = -1;
          for (let i = 0; i < opps.length; i++) if (oppIn[i]) { inCount++; lastIn = i; }
          if (lookahead && inCount === 1 && sc.amount < stack && oppLeft[lastIn] > addNow[lastIn]) {
            const startCur = sc.kind === 'check' && opps[lastIn].pending;
            gain = playOut(lastIn, finalPot, sc.amount, share, rng, startCur, 0);
            for (let v = 1; v < VARIANTS.length; v++) varGain[v] = playOut(lastIn, finalPot, sc.amount, share, rng, startCur, v);
            sc.looked++;
          } else if (lookahead && inCount >= 2 && sc.amount < stack && !sidePots) {
            const list = [];
            for (let i = 0; i < opps.length; i++) if (oppIn[i]) list.push(i);
            gain = playOutMulti(list, finalPot, sc.amount, hs, rng, 0);
            for (let v = 1; v < VARIANTS.length; v++) varGain[v] = playOutMulti(list, finalPot, sc.amount, hs, rng, v);
            sc.looked++;
          } else if (sidePots) {
            gain = sidePotWin(sc.amount, hs) * (sc.amount >= stack ? 1 : realize) - sc.amount;
          } else {
            gain = share * (sc.amount >= stack ? 1 : realize) * finalPot - sc.amount;
          }
          sc.showdowns++;
          sc.shareSum += share;
          if (share === 1) sc.wins++;
          else if (share > 0) sc.ties++;
        }
        sc.n++;
        for (let v = 1; v < VARIANTS.length; v++) sc.varSum[v] += isNaN(varGain[v]) ? gain : varGain[v];
        sc.gainSum += gain;
        sc.gainSq += gain * gain;
      }
    }

    function step(count) {
      const n = Math.min(count, target - done);
      if (n > 0) for (const sc of runnable) runScenario(sc, done, n);
      done += Math.max(0, n);
      return done / target;
    }

    // How likely the bet or raise an opponent just made is a bluff, given their reads.
    function bluffChance(o) {
      if (street === 0 || !o.aggressor || o.W.bluffShare == null) return null;
      return o.W.bluffShare;
    }

    // Heads-up river: solve range against range instead of trusting the Monte Carlo alone.
    let solved = null;
    if (street === 5 && opps.length === 1 && input.riverSolver !== false && stack > 0) {
      const o = opps[0], oi = input.opponents[0];
      const heroStats = computeStats({}, tableStyle);
      const heroActs = Object.assign({ pre: 'call', flop: 'call', turn: 'call' }, input.heroActions || {});
      solved = riverSolve({
        board, heroCombo, strengths: strengths[5], bigBlind,
        heroW: buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true),
        oppW: buildRange(o.stats, o.actions, strengths, board, oi.sizes, oi.pfAggressor, oi.position),
        oppStats: Object.assign({}, o.stats, { foldShift: 0 }), p: o.stats.exploitWeight,
        pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
        heroFirst: toCall <= 0 && o.pending,
        iterations: input.riverIterations,
      });
      // The Monte Carlo then only feeds the equity readout, so it can be shorter.
      if (solved) target = Math.min(target, 6000);
    }

    const robustWeight = lookahead ? 0.35 * (1 - opps.reduce((a, o) => a + o.stats.exploitWeight, 0) / opps.length) : 0;

    function result() {
      for (const sc of scenarios) {
        if (sc.kind === 'fold') { sc.ev = sc.evRead = sc.evWorst = 0; sc.se = 0; continue; }
        const n = Math.max(1, sc.n);
        sc.evRead = sc.gainSum / n;
        sc.se = Math.sqrt(Math.max(0, sc.gainSq / n - sc.evRead * sc.evRead) / n);
        // Hold up against opponents who play differently from the read: blend in the worst
        // version, more so when the read is thin.
        sc.evWorst = sc.evRead;
        if (lookahead) for (let v = 1; v < VARIANTS.length; v++) sc.evWorst = Math.min(sc.evWorst, sc.varSum[v] / n);
        sc.ev = (1 - robustWeight) * sc.evRead + robustWeight * sc.evWorst;
        sc.foldPct = sc.foldAll / n;
        sc.reraisedPct = sc.reraised / n;
        sc.lookedPct = sc.looked / n;
        sc.equityWhenCalled = sc.showdowns ? sc.shareSum / sc.showdowns : null;
      }
      const ranked = scenarios.slice().sort((a, b) => b.ev - a.ev);
      const aggressive = (sc) => sc.kind === 'bet' || sc.kind === 'raise' || (sc.kind === 'allin' && sc.amount > toCall);
      let best = ranked[0];
      if (aggressive(best)) {
        const tol = Math.max(0.02 * (pot + toCall), 1.5 * best.se, 0.1 * bigBlind);
        const near = ranked.filter((sc) => aggressive(sc) && best.ev - sc.ev <= tol);
        best = near.sort((a, b) => a.amount - b.amount)[0];
      }
      let runnerUp = ranked.find((sc) => aggressive(sc) !== aggressive(best) || (!aggressive(best) && sc.kind !== best.kind));
      const passive = scenarios.find((s) => s.kind === 'check' || s.kind === 'call');
      const base = scenarios.find((s) => s.kind !== 'fold');
      const margin = runnerUp ? best.ev - runnerUp.ev : Infinity;
      const closeThreshold = Math.max(0.03 * (pot + toCall), 2 * best.se, 0.25 * bigBlind);
      const close = margin < closeThreshold;

      // Close spots: play a mix, so friends' helpers can't learn a fixed pattern. The better
      // option gets 50-100% depending on its edge, and the seed picks which one to show.
      let mix = null;
      if (solved) return solvedResult();
      if (close && runnerUp && input.mix !== false) {
        const fb = Math.round((0.5 + 0.5 * clamp(margin / closeThreshold, 0, 1)) * 20) / 20;
        mix = [{ kind: best.kind, amount: best.amount, label: best.label, freq: fb },
          { kind: runnerUp.kind, amount: runnerUp.amount, label: runnerUp.label, freq: 1 - fb }];
        if (mulberry32((seed ^ 0x2545f491) >>> 0)() >= fb) { const b = best; best = runnerUp; runnerUp = b; }
      }

      return finish(ranked, best, runnerUp, margin, close, mix);
    }

    // Advice from the river solve: its frequencies and EVs for hero's real hand.
    function solvedResult() {
      const name = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };
      const acts = solved.actions.map((a) => ({
        kind: a.kind, amount: a.amount, ev: a.ev, se: 0, freq: a.freq,
        label: a.kind === 'allin' ? (a.amount <= toCall + 1e-9 ? 'Call all-in' : 'All-in') : name[a.kind],
        sizeLabel: a.frac && a.kind !== 'allin' ? (a.kind === 'raise' ? 'pot-size raise' : Math.round(a.frac * 100) + '% pot') : '',
      }));
      const ranked = acts.slice().sort((a, b) => b.freq - a.freq || b.ev - a.ev);
      let best = ranked[0];
      const played = ranked.filter((a) => a.freq >= 0.1);
      const mix = played.length >= 2 ? played.map((a) => ({ kind: a.kind, amount: a.amount, label: a.label, freq: Math.round(a.freq * 20) / 20 })) : null;
      if (mix && input.mix !== false) {
        let u = mulberry32((seed ^ 0x2545f491) >>> 0)() * played.reduce((x, a) => x + a.freq, 0);
        best = played.find((a) => (u -= a.freq) <= 0) || played[0];
      }
      const runnerUp = ranked.find((a) => a !== best) || null;
      return finish(ranked, best, runnerUp, runnerUp ? best.ev - runnerUp.ev : Infinity, !!mix, mix);
    }

    function finish(ranked, best, runnerUp, margin, close, mix) {
      const passive = scenarios.find((s) => s.kind === 'check' || s.kind === 'call');
      const base = scenarios.find((s) => s.kind !== 'fold');
      const equity = base ? {
        share: base.showdowns ? base.shareSum / base.showdowns : 1,
        win: base.showdowns ? base.wins / base.showdowns : 1,
        tie: base.showdowns ? base.ties / base.showdowns : 0,
      } : null;
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      const heroInfo = describeHero(hero, board);

      let impliedOddsNeeded = null;
      if (toCall > 0 && equity && street > 0 && street < 5 && passive && passive.ev < 0 && equity.share > 0) {
        const need = toCall / equity.share - pot - toCall;
        if (need > 0 && need < stack) impliedOddsNeeded = need;
      }

      return {
        street, streetName, pot, toCall, stack, bigBlind, realize, inPosition, lookahead,
        scenarios, ranked, best, runnerUp, margin, close, mix, robustWeight,
        credibility,
        solver: solved ? { iterations: solved.iterations, exploitWeight: opps[0].stats.exploitWeight } : null,
        equity, potOdds, hero: heroInfo, impliedOddsNeeded,
        iterations: done,
        opponents: opps.map((o, i) => ({
          name: o.name, stats: o.stats, type: o.type, pending: o.pending, aggressor: o.aggressor,
          grid: o.grid,
          summary: readSummary(o.stats),
          bluffChance: bluffChance(o),
          heroVs: base && base.vsCount[i] ? (base.vsWins[i] + base.vsTies[i] / 2) / base.vsCount[i] : null,
          foldToBest: best && best.n ? best.oppFolds[i] / best.n : null,
        })),
      };
    }

    return { step, result, target, scenarios };
  }

  function roundChips(x, bb) {
    const unit = bb >= 1 ? Math.max(1, Math.round(bb / 2)) : bb / 2;
    return Math.max(unit, Math.round(x / unit) * unit);
  }

  function analyzeSync(input) {
    const a = createAnalysis(input);
    while (a.step(5000) < 1);
    return a.result();
  }

  const api = {
    RANKS, SUITS, CATEGORY_NAMES, CLASS_NAMES, CLASS_COMBO_COUNT, PREFLOP_ORDER, PLAYER_TYPES, TABLE_PRIORS,
    parseCard, cardToString, evaluate, describeScore, describeHero,
    computeStats, classifyPlayer, preflopRange, boardStrength, buildRange, applyAction, rangeGrid,
    foldAtSize, valueShare, classifyShows, handPercentile, readSummary, scoreShow,
    createAnalysis, analyzeSync, comboIndex: (a, b) => COMBO_INDEX[a * 52 + b],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

}
ENGINE();

// Turns Poker Patio socket events into hand state, opponent tallies and
// solver input. No browser APIs here, so it can be tested on its own.
(function (global) {
  'use strict';

  const SUIT = { clubs: 'c', diamonds: 'd', hearts: 'h', spades: 's' };
  const RANK = { '10': 'T', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A' };
  const RANKS = '23456789TJQKA';
  const SUITS = 'cdhs';

  function cardStr(cd) {
    if (!cd || cd.value == null || !cd.suite) return null;
    const r = RANK[String(cd.value)] || String(cd.value);
    const s = SUIT[cd.suite];
    return r.length === 1 && s ? r + s : null;
  }
  function cardId(str) {
    return RANKS.indexOf(str[0]) * 4 + SUITS.indexOf(str[1]);
  }
  function seatNum(pos) {
    const n = parseInt(String(pos).replace(/\D/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  const MAX_SHOWS = 40;
  const MAX_HISTORY = 150;
  // Each hand a player is dealt into shrinks their older counts by 1%, so the last
  // hundred or so hands carry most of the weight and reads follow players who change.
  const DECAY = 0.99;
  function decayTally(t) {
    for (const k of Object.keys(t)) {
      if (k === 'shows') continue;
      if (typeof t[k] === 'number') t[k] *= DECAY;
      else if (t[k] && typeof t[k] === 'object') decayTally(t[k]);
    }
  }
  const streetTally = () => ({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 });
  const facingTally = () => ({ fold: 0, call: 0, raise: 0 });
  const posTally = () => ({ n: 0, vpip: 0, pfr: 0 });
  function blankTally() {
    return {
      pfFold: 0, pfCall: 0, pfRaise: 0, check: 0, bet: 0, call: 0, raise: 0, fold: 0,
      // Preflop re-raising: times they faced an open, and how often they 3-bet it.
      pf3betOpp: 0, pf3bet: 0,
      // Continuation bets: preflop raiser's first flop decision, and how others react to it.
      cbetOpp: 0, cbet: 0, vsCbet: 0, foldCbet: 0,
      // Per-street action counts (the flat counts above are all streets together).
      st: { flop: streetTally(), turn: streetTally(), river: streetTally() },
      // Reaction to a bet by its size (fraction of the pot before the bet): <45%, 45-85%, >85%.
      vs: { small: facingTally(), medium: facingTally(), large: facingTally() },
      // Their own bet sizes postflop, as fractions of the pot.
      betSize: { n: 0, sum: 0 },
      sawFlop: 0, wtsd: 0,
      // Preflop by position group ('early', 'late' = cutoff and button, 'blinds').
      pos: { early: posTally(), late: posTally(), blinds: posTally() },
      // Hands they showed after betting or raising: { cards, board, agg: [{ n: boardLen, frac }] }.
      shows: [],
    };
  }
  // Fills in fields added after a read was first saved.
  function upgradeTally(t) {
    const b = blankTally();
    for (const k of Object.keys(b)) {
      if (t[k] == null) t[k] = b[k];
      else if (k === 'st' || k === 'vs' || k === 'pos') for (const j of Object.keys(b[k])) if (!t[k][j]) t[k][j] = b[k][j];
    }
    return t;
  }
  function sizeBucket(f) {
    return f < 0.45 ? 'small' : f < 0.85 ? 'medium' : 'large';
  }

  const STREET_BY_STAGE = { pre_flop: 0, flop: 3, turn: 4, river: 5 };
  const STREET_KEY = { 0: 'pre', 3: 'flop', 4: 'turn', 5: 'river' };

  class PatioTracker {
    constructor(db) {
      // db: { players: { [authUserId]: { name, tally } } }
      this.db = db && db.players ? db : { players: {} };
      this.hand = null;
      this.snap = null;
      this.listeners = [];
    }

    on(fn) { this.listeners.push(fn); }
    emit(type, payload) { for (const fn of this.listeners) fn(type, payload); }

    record(authId, name) {
      if (!authId) return null;
      let r = this.db.players[authId];
      if (!r) r = this.db.players[authId] = { name, tally: blankTally() };
      else r.tally = upgradeTally(r.tally || {});
      if (name) r.name = name;
      return r;
    }

    heroId() {
      const s = this.snap;
      if (!s) return null;
      const me = s.players.find((p) => p.authUserId === s.heroAuthId);
      return me ? me.id : null;
    }

    newHand() {
      const s = this.snap || { players: [] };
      this.settleLog(s);
      const players = {};
      for (const p of s.players) {
        if (p.playState !== 'playing' && p.playState !== 'folded' && p.playState !== 'all_in') continue;
        const known = p.authUserId !== s.heroAuthId && this.db.players[p.authUserId];
        if (known && known.tally) decayTally(upgradeTally(known.tally));
        players[p.id] = {
          id: p.id, auth: p.authUserId, name: p.name, pos: p.posType,
          stageBet: 0, total: 0, folded: false, allin: false,
          seq: { pre: [], flop: [], turn: [], river: [] },
          pfCat: null, acted: false, faced3: false, cbetSeen: false,
          agg: [], sizes: {}, shown: [], start: +p.stack || 0,
        };
      }
      this.hand = {
        players, street: 0, started: false, board: [], heroUids: [], heroCards: {}, uidPos: {},
        pfRaiser: null, flopBet: false,
        currentBet: 0, preRaises: 0, dealerPos: null, bigBlind: s.bigBlind || null,
        finished: false, log: [],
      };
      this.emit('hand', this.hand);
    }

    handle(ev, data, snap) {
      if (snap) this.snap = snap;
      const h = this.hand;
      switch (ev) {
        case 'game:stage_began': {
          const t = data && data.stageType;
          if (t === 'set_blinds') this.newHand();
          else if (h && t in STREET_BY_STAGE) {
            h.street = STREET_BY_STAGE[t];
            h.started = true;
            if (h.street > 0) {
              h.currentBet = 0;
              for (const p of Object.values(h.players)) p.stageBet = 0;
            }
            this.emit('street', h);
          } else if (h && t === 'showdown') {
            this.finishHand();
          }
          break;
        }
        case 'game:dealer_updated':
          if (h) h.dealerPos = data.dealerSeatPos;
          break;
        case 'game:small_blind_paid':
        case 'game:big_blind_paid': {
          if (!h) break;
          const p = h.players[data.playerId];
          if (p) {
            p.stageBet += data.amount; p.total += data.amount;
            h.log.push({ st: 'pre', who: p.name, hero: p.id === this.heroId(), act: ev === 'game:big_blind_paid' ? 'bb' : 'sb', amt: data.amount });
          }
          h.currentBet = Math.max(h.currentBet, data.amount);
          if (ev === 'game:big_blind_paid') h.bigBlind = data.amount;
          break;
        }
        case 'game:cards_dealt_to_player':
        case 'game:card_dealt_to_player': {
          if (!h) break;
          const heroPos = this.heroPos();
          const list = Array.isArray(data) ? data : [data];
          for (const d of list) {
            if (d && d.cardData && d.playerPos) h.uidPos[d.cardData.uniqueID] = d.playerPos;
            if (d && d.playerPos === heroPos && d.cardData) {
              h.heroUids.push(d.cardData.uniqueID);
              const c = cardStr(d.cardData);
              if (c) h.heroCards[d.cardData.uniqueID] = c;
            }
          }
          break;
        }
        case 'game:update_card_data': {
          if (!h || !data || !data.cardData) break;
          const uid = data.cardData.uniqueID;
          if (h.heroUids.includes(uid)) {
            const c = cardStr(data.cardData);
            if (c) { h.heroCards[uid] = c; this.emit('cards', h); }
          } else if (h.uidPos[uid]) {
            this.onReveal(h.uidPos[uid], cardStr(data.cardData));
          }
          break;
        }
        case 'game:cards_deal_to_stack':
        case 'game:card_deal_to_stack': {
          if (!h) break;
          const list = Array.isArray(data) ? data.map((x) => x.emitData || x) : [data];
          for (const d of list) {
            if (!d || d.stackID !== 'community_stack') continue;
            const c = cardStr(d.cardData);
            if (c && !h.board.includes(c)) h.board.push(c);
          }
          break;
        }
        case 'player:game:action_taken':
          this.onAction(data);
          break;
        case 'game:player_turn_started':
          if (h && !h.finished) this.emit('turn', { playerID: data.playerID, isHero: data.playerID === this.heroId() });
          break;
        case 'game:player_turn_ended':
          if (h && data.playerID === this.heroId()) this.emit('heroDone', null);
          break;
        case 'game:game_ended':
        case 'admin:game:game_stopped':
          this.finishHand();
          break;
        default:
          break;
      }
    }

    heroPos() {
      const s = this.snap;
      if (!s) return null;
      const me = s.players.find((p) => p.authUserId === s.heroAuthId);
      return me ? me.posType : null;
    }

    onAction(d) {
      const h = this.hand;
      if (!h || !d) return;
      const p = h.players[d.playerID];
      if (!p) return;
      const street = h.street;
      const key = STREET_KEY[street];
      const added = +d.makeBetValue || 0;
      let potBefore = 0;
      for (const x of Object.values(h.players)) potBefore += x.total;
      const facing = Math.max(0, h.currentBet - p.stageBet);
      let kind = d.actionType;
      if (kind === 'raise') {
        if (street === 0) kind = h.preRaises >= 1 ? '3bet' : 'raise';
        else kind = h.currentBet > 0 ? 'raise' : 'bet';
      }
      p.stageBet += added;
      p.total += added;
      if (p.stageBet > h.currentBet) h.currentBet = p.stageBet;
      if (d.actionType === 'fold') p.folded = true;
      const snapP = this.snap && this.snap.players.find((x) => x.id === p.id);
      if (snapP && snapP.stack - added <= 0 && d.actionType !== 'fold' && d.actionType !== 'check') p.allin = true;
      if (key) p.seq[key].push(kind);
      p.acted = true;
      this.logAction(p, kind, added, facing, potBefore, snapP);

      const isHero = p.id === this.heroId();
      const r = isHero ? null : this.record(p.auth, p.name);
      if (street === 0) {
        if (r && !p.faced3 && h.preRaises === 1 && kind !== 'check') {
          p.faced3 = true;
          r.tally.pf3betOpp++;
          if (kind === '3bet') r.tally.pf3bet++;
        }
        if (kind === 'raise' || kind === '3bet') { h.preRaises++; h.pfRaiser = p.id; }
        const rank = { fold: 0, check: 0, call: 1, raise: 2, '3bet': 2 }[kind];
        const cat = rank === 2 ? 'pfRaise' : rank === 1 ? 'pfCall' : 'pfFold';
        const order = { pfFold: 0, pfCall: 1, pfRaise: 2 };
        if (!p.pfCat || order[cat] > order[p.pfCat]) p.pfCat = cat;
      } else {
        const frac = potBefore > 0 ? Math.min(3, Math.max(0, added - facing) / (potBefore + facing)) : 0;
        if (kind === 'bet' || kind === 'raise') {
          p.agg.push({ n: h.board.length, frac: Math.round(frac * 100) / 100 });
          p.sizes[key] = Math.round(frac * 100) / 100;
        }
        // C-bets: the preflop raiser's first flop decision, and replies to their flop bet.
        const cbetSpot = street === 3 && h.pfRaiser != null;
        if (r) {
          const t = r.tally;
          if (t[kind] != null) t[kind]++;
          if (key && t.st[key] && t.st[key][kind] != null) t.st[key][kind]++;
          if (facing > 0 && (kind === 'fold' || kind === 'call' || kind === 'raise')) {
            t.vs[sizeBucket(facing / Math.max(1, potBefore - facing))][kind]++;
          }
          if (kind === 'bet') { t.betSize.n++; t.betSize.sum += frac; }
          if (cbetSpot && p.id === h.pfRaiser && !p.cbetSeen && !h.flopBet) { t.cbetOpp++; if (kind === 'bet') t.cbet++; }
          if (cbetSpot && p.id !== h.pfRaiser && h.flopBet === 'cbet' && !p.vsCbetSeen && facing > 0) { t.vsCbet++; if (kind === 'fold') t.foldCbet++; }
        }
        if (street === 3) {
          if (kind === 'bet' && !h.flopBet) h.flopBet = p.id === h.pfRaiser ? 'cbet' : 'donk';
          p.cbetSeen = true;
          if (h.flopBet === 'cbet' && facing > 0) p.vsCbetSeen = true;
        }
      }
      this.emit('action', { player: p, kind, added });
    }

    finishHand() {
      const h = this.hand;
      if (!h || h.finished) return;
      h.finished = true;
      if (h.started) {
        const heroId = this.heroId();
        const live = Object.values(h.players).filter((p) => !p.folded).length;
        for (const p of Object.values(h.players)) {
          if (p.id === heroId) continue;
          const r = this.record(p.auth, p.name);
          if (!r) continue;
          r.tally[p.pfCat || 'pfFold']++;
          const g = this.posGroup(p.id);
          if (g) {
            const pt = r.tally.pos[g];
            pt.n++;
            if (p.pfCat === 'pfCall' || p.pfCat === 'pfRaise') pt.vpip++;
            if (p.pfCat === 'pfRaise') pt.pfr++;
          }
          const sawFlop = h.board.length >= 3 && (p.seq.flop.length > 0 || !p.folded);
          if (sawFlop) r.tally.sawFlop++;
          if (sawFlop && !p.folded && live >= 2) r.tally.wtsd++;
        }
      }
      if (h.started) this.logHand();
      this.emit('handEnd', h);
      this.emit('save', this.db);
    }

    // Keep a short hand history for review: board, everyone's actions, shown cards and
    // what the solver advised. Shown cards fill in later (they arrive after the hand ends).
    logHand() {
      const h = this.hand;
      const heroId = this.heroId();
      const entry = {
        t: Date.now(), board: h.board.slice(), bigBlind: h.bigBlind,
        hero: h.heroUids.map((u) => h.heroCards[u]).filter(Boolean),
        pot: Object.values(h.players).reduce((a, p) => a + p.total, 0),
        advice: (h.advice || []).slice(),
        log: h.log.slice(),
        players: Object.values(h.players).map((p) => ({
          name: p.name, hero: p.id === heroId, position: this.posGroup(p.id), folded: p.folded, stack: p.start,
          put: p.total, actions: p.seq, shown: p.shown,
        })),
      };
      h.logEntry = entry;
      const list = this.db.history || (this.db.history = []);
      list.push(entry);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    }

    // Every action with its amount, the pot before it, what the player faced and their stack,
    // so a hand can be replayed exactly from the log. Hero's action is also matched to the
    // advice shown for that decision.
    logAction(p, kind, added, facing, potBefore, snapP) {
      const h = this.hand;
      const r2 = (x) => Math.round(x * 100) / 100;
      const isHero = p.id === this.heroId();
      const e = {
        st: STREET_KEY[h.street] || 'pre', who: p.name, act: kind, amt: r2(added), to: r2(p.stageBet),
        pot: r2(potBefore), facing: r2(facing),
      };
      if (isHero) e.hero = true;
      if (snapP && snapP.stack != null) e.stack = r2(+snapP.stack);
      if (potBefore > 0 && (kind === 'bet' || kind === 'raise' || kind === '3bet')) e.potPct = Math.round(100 * Math.max(0, added - facing) / (potBefore + facing));
      if (p.allin) e.allin = true;
      h.log.push(e);
      if (!isHero || !h.advice) return;
      const adv = h.advice.slice().reverse().find((a) => a.street === h.board.length && !a.did);
      if (!adv) return;
      adv.did = kind + (added > 0 ? ' ' + r2(added) : '');
      const group = (k) => (k === 'bet' || k === 'raise' || k === '3bet' || k === 'allin' ? 'aggr' : k);
      if (adv.kind) adv.followed = group(adv.kind) === group(kind) || (adv.kind === 'allin' && kind === 'call');
    }

    // Stacks only update after the pot is paid, so each hand's result is filled in from the
    // next hand's starting stacks (rebuys between hands would show up as winnings).
    settleLog(s) {
      const prev = this.hand;
      if (!prev || !prev.logEntry || prev.logEntry.net) return;
      const net = {};
      for (const p of Object.values(prev.players)) {
        const now = s.players.find((x) => x.id === p.id);
        if (now && now.stack != null) net[p.name] = Math.round((+now.stack - p.start) * 100) / 100;
      }
      prev.logEntry.net = net;
      const hero = Object.values(prev.players).find((p) => p.id === this.heroId());
      if (hero && net[hero.name] != null) {
        prev.logEntry.heroNet = net[hero.name];
        if (prev.bigBlind) prev.logEntry.heroNetBB = Math.round((net[hero.name] / prev.bigBlind) * 10) / 10;
      }
      this.emit('save', this.db);
    }

    // The overlay reports each piece of advice so the hand log can show it. With the solver
    // result (and a formatter for its options) the log also keeps the pot, price, equity,
    // the other options' EVs and whether hero followed the advice.
    noteAdvice(text, ev, r, fmt) {
      const h = this.hand;
      if (!h || h.finished) return;
      const r2 = (x) => Math.round(x * 100) / 100;
      const a = { street: h.board.length, text, ev: r2(ev) };
      if (r) {
        if (r.best) { a.kind = r.best.kind; a.amount = r2(r.best.amount || 0); }
        a.pot = r2(r.pot); a.toCall = r2(r.toCall || 0);
        if (r.equity) a.equity = r2(r.equity.share);
        if (r.potOdds != null && r.toCall > 0) a.needed = r2(r.potOdds);
        if (r.hero && r.hero.made) a.hand = r.hero.made;
        if (r.best && r.best.foldPct > 0.02) a.foldPct = r2(r.best.foldPct);
        if (r.mix) a.mix = r.mix.map((m) => m.label + ' ' + Math.round(m.freq * 100) + '%');
        if (r.solver) a.riverSolve = true;
        if (fmt && r.ranked) a.options = r.ranked.slice(0, 5).map((sc) => ({ a: fmt(sc), ev: r2(sc.ev || 0) }));
        if (r.opponents) a.reads = r.opponents.map((o) => ({ name: o.name, type: o.type && o.type.label, hands: Math.round(o.stats.hands || 0), bluff: o.bluffChance != null ? r2(o.bluffChance) : undefined }));
      }
      (h.advice || (h.advice = [])).push(a);
    }

    // Players in postflop order: small blind first, button last.
    // (Assumes seats run clockwise in ascending number; see CLAUDE.md.)
    seatOrder() {
      const h = this.hand;
      const all = Object.values(h.players).sort((a, b) => seatNum(a.pos) - seatNum(b.pos));
      const dealerN = seatNum(h.dealerPos);
      return all.filter((p) => seatNum(p.pos) > dealerN).concat(all.filter((p) => seatNum(p.pos) <= dealerN));
    }

    // 'blinds', 'late' (button and cutoff) or 'early'. Heads-up the button is 'late'.
    posGroup(id) {
      const h = this.hand;
      if (!h || h.dealerPos == null) return null;
      const order = this.seatOrder();
      const i = order.findIndex((p) => p.id === id);
      const n = order.length;
      if (i < 0 || n < 2) return null;
      if (i === n - 1) return 'late';
      if (n === 2 || i < 2) return 'blinds';
      if (n >= 5 && i === n - 2) return 'late';
      return 'early';
    }

    // An opponent's hole card was turned face up (showdown, or a voluntary show).
    // Once both are known, keep the hand with the bets they made, so the engine
    // can tell how often their bets were value and how often bluffs.
    onReveal(pos, card) {
      const h = this.hand;
      if (!h || !card) return;
      const p = Object.values(h.players).find((x) => x.pos === pos);
      if (!p || p.id === this.heroId()) return;
      if (!p.shown.includes(card)) p.shown.push(card);
      if (p.shown.length !== 2 || p.logged) return;
      p.logged = true;
      if (h.board.length < 3) return;
      const r = this.record(p.auth, p.name);
      if (!r) return;
      const actions = { pre: PatioTracker.streetAction(p.seq.pre, 0) };
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = PatioTracker.streetAction(p.seq[k], n);
      if (actions.pre === 'pending') actions.pre = 'call';
      const show = {
        cards: p.shown.slice(), board: h.board.slice(), agg: p.agg.slice(),
        actions, sizes: Object.assign({}, p.sizes), pfAggressor: h.pfRaiser === p.id, position: this.posGroup(p.id),
      };
      // How well the range we would have put them on matches what they showed.
      if (this.scorer) { try { show.fit = this.scorer(show, r.tally); } catch (e) { /* scoring is optional */ } }
      r.tally.shows.push(show);
      if (r.tally.shows.length > MAX_SHOWS) r.tally.shows.splice(0, r.tally.shows.length - MAX_SHOWS);
      this.emit('save', this.db);
    }

    // Summarize what a player did on one street for the solver.
    static streetAction(seq, street) {
      if (!seq.length) return street === 0 ? 'pending' : '';
      if (street === 0) {
        if (seq.includes('fold')) return 'fold';
        if (seq.includes('3bet')) return '3bet';
        if (seq.includes('raise')) return 'raise';
        if (seq.includes('call')) return 'call';
        return 'check';
      }
      if (seq.includes('fold')) return 'fold';
      const first = seq[0];
      if (seq.includes('raise')) return first === 'check' ? 'checkraise' : 'raise';
      if (seq.includes('bet')) return 'bet';
      if (seq.includes('call')) return first === 'check' ? 'checkcall' : 'call';
      return 'check';
    }

    // Build the input for PokerEngine.analyzeSync, or { error } if not ready.
    solverInput(tableStyle) {
      const h = this.hand;
      if (!h || h.finished) return { error: 'Waiting for the next hand.' };
      const heroId = this.heroId();
      const hero = h.players[heroId];
      if (!hero) return { error: 'You are not dealt into this hand.' };
      const heroCards = h.heroUids.map((u) => h.heroCards[u]).filter(Boolean);
      if (heroCards.length < 2) return { error: 'Waiting to see your cards.' };
      if (![0, 3, 4, 5].includes(h.board.length)) return { error: 'Waiting for the board.' };

      const snapOf = (id) => (this.snap && this.snap.players.find((x) => x.id === id)) || null;
      const heroSnap = snapOf(heroId);
      const heroStack = heroSnap ? heroSnap.stack : null;

      // Seat order starting after the dealer (postflop action order).
      const afterDealer = this.seatOrder();
      const live = afterDealer.filter((p) => !p.folded);
      const canAct = live.filter((p) => !p.allin || p.id === heroId);
      const inPosition = canAct.length ? canAct[canAct.length - 1].id === heroId : true;

      // Opponents in the order they act after hero.
      const hi = afterDealer.findIndex((p) => p.id === heroId);
      const rotated = afterDealer.slice(hi + 1).concat(afterDealer.slice(0, hi));
      const opps = rotated.filter((p) => !p.folded);
      if (!opps.length) return { error: 'Everyone else has folded.' };

      let pot = 0;
      for (const p of Object.values(h.players)) pot += p.total;
      let toCall = Math.max(0, h.currentBet - hero.stageBet);

      // Effective stack: hero can't win more than the biggest opponent can put in.
      let maxOpp = 0;
      for (const o of opps) {
        const s = snapOf(o.id);
        const left = s ? s.stack : 0;
        maxOpp = Math.max(maxOpp, left + o.stageBet - hero.stageBet);
      }
      let stack = heroStack != null ? Math.min(heroStack, Math.max(maxOpp, toCall)) : null;
      if (stack != null && toCall > stack) toCall = stack;

      const street = h.board.length;
      const lineOf = (o) => {
        const a = { pre: PatioTracker.streetAction(o.seq.pre, 0) };
        for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (street >= n) a[k] = PatioTracker.streetAction(o.seq[k], n);
        if (street > 0 && a.pre === 'pending') a.pre = 'call';
        return a;
      };
      const opponents = opps.map((o) => {
        const r = this.record(o.auth, o.name);
        const actions = { pre: PatioTracker.streetAction(o.seq.pre, 0) };
        for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) {
          if (street >= n) actions[k] = PatioTracker.streetAction(o.seq[k], n);
        }
        if (street > 0 && actions.pre === 'pending') actions.pre = 'call';
        const cbetter = h.pfRaiser === o.id;
        return { name: o.name, tally: Object.assign(blankTally(), r ? r.tally : {}), actions, sizes: Object.assign({}, o.sizes), pfAggressor: cbetter, position: this.posGroup(o.id),
          // For side pots: chips already in the pot this hand, and chips behind.
          committed: o.total, stack: snapOf(o.id) ? snapOf(o.id).stack : null };
      });

      return {
        input: {
          hero: heroCards.map(cardId),
          board: h.board.map(cardId),
          pot, toCall, stack: stack > 0 ? stack : null,
          bigBlind: h.bigBlind || (this.snap && this.snap.bigBlind) || 1,
          inPosition, tableStyle: tableStyle || 'typical',
          opponents,
          // Hero's own line this hand, so the river solver knows what hero's range looks like.
          heroActions: lineOf(hero), heroSizes: Object.assign({}, hero.sizes),
          heroPfAggressor: h.pfRaiser === heroId, heroPosition: this.posGroup(heroId),
          heroCommitted: hero.total,
          iterations: opponents.length > 2 ? 16000 : 24000,
          // Fresh seed each decision, so close spots get mixed rather than always the same advice.
          seed: (Math.random() * 4294967296) >>> 0,
        },
        heroStageBet: hero.stageBet,
        heroCards, board: h.board.slice(),
      };
    }
  }

  PatioTracker.blankTally = blankTally;
  PatioTracker.upgradeTally = upgradeTally;
  PatioTracker.cardStr = cardStr;
  if (typeof module !== 'undefined' && module.exports) module.exports = PatioTracker;
  else global.PatioTracker = PatioTracker;
})(typeof window !== 'undefined' ? window : globalThis);


// ---- Patio Solver (userscript): socket hook + phone-friendly panel ----
// ENGINE (your solver) and PatioTracker are defined above this point.

function slim(r) {
  var sc = function (s) {
    return s && {
      kind: s.kind, label: s.label, sizeLabel: s.sizeLabel || '', amount: s.amount,
      ev: s.ev, se: s.se, foldPct: s.foldPct || 0, reraisedPct: s.reraisedPct || 0,
      equityWhenCalled: s.equityWhenCalled, freq: s.freq
    };
  };
  return {
    street: r.street, pot: r.pot, toCall: r.toCall, stack: isFinite(r.stack) ? r.stack : null,
    bigBlind: r.bigBlind, inPosition: r.inPosition, lookahead: !!r.lookahead,
    best: sc(r.best), runnerUp: sc(r.runnerUp), ranked: r.ranked.map(sc),
    margin: isFinite(r.margin) ? r.margin : null, close: r.close, mix: r.mix, solver: r.solver,
    equity: r.equity, potOdds: r.potOdds, hero: r.hero, impliedOddsNeeded: r.impliedOddsNeeded,
    opponents: r.opponents.map(function (o) {
      return {
        name: o.name, pending: o.pending, aggressor: o.aggressor,
        type: { key: o.type.key, label: o.type.label, tip: o.type.tip },
        stats: { hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, af: o.stats.af, foldToBet: o.stats.foldToBet, confidence: o.stats.confidence },
        topClasses: o.grid.topClasses.slice(0, 8).map(function (c) { return c.name; }),
        heroVs: o.heroVs, foldToBest: o.foldToBest, summary: o.summary || '', bluffChance: o.bluffChance
      };
    })
  };
}

(function () {
  'use strict';
  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__patioSolverUS) return;
  W.__patioSolverUS = true;

  // ---------- storage ----------
  var DB_KEY = 'patioSolverDb', UI_KEY = 'patioSolverUi';
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }

  // ---------- solver in a background worker ----------
  var worker = null, pending = {}, nextId = 1;
  try {
    var src = '(' + ENGINE.toString() + ')();\n' + slim.toString() +
      '\nself.onmessage=function(e){try{var t0=Date.now();var r=PokerEngine.analyzeSync(e.data.input);' +
      'self.postMessage({id:e.data.id,ok:true,result:slim(r),ms:Date.now()-t0})}catch(err){' +
      'self.postMessage({id:e.data.id,ok:false,error:String(err&&err.message||err)})}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = function (e) { var cb = pending[e.data.id]; delete pending[e.data.id]; if (cb) cb(e.data); };
    worker.onerror = function () { worker = null; };
  } catch (e) { worker = null; }

  function analyze(input) {
    return new Promise(function (res) {
      if (worker) {
        var id = nextId++;
        pending[id] = res;
        worker.postMessage({ id: id, input: input });
        return;
      }
      setTimeout(function () { // fallback: run on the page
        try { res({ ok: true, result: slim(PokerEngine.analyzeSync(input)) }); }
        catch (err) { res({ ok: false, error: String(err && err.message || err) }); }
      }, 30);
    });
  }

  // ---------- state ----------
  var narrow = Math.min(W.innerWidth, W.screen ? W.screen.width : 9999) < 640;
  var ui = Object.assign({ tableStyle: 'typical', x: null, y: null, expanded: !narrow, showOptions: !narrow }, load(UI_KEY) || {});
  var tracker = new PatioTracker(load(DB_KEY) || { players: {} });
  tracker.scorer = function (show, tally) { return PokerEngine.scoreShow(show, tally, ui.tableStyle); };
  var status = 'Connecting to the table…';
  var advice = null, thinking = false, blocked = false, reqId = 0;

  // ---------- formatting ----------
  function money(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var SUITSYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
  function cardHtml(c) { return '<span class="cd' + (c[1] === 'h' || c[1] === 'd' ? ' red' : '') + '">' + (c[0] === 'T' ? '10' : c[0]) + SUITSYM[c[1]] + '</span>'; }
  function actionText(sc, heroStageBet, toCall) {
    if (!sc) return '';
    if (sc.kind === 'fold') return 'Fold';
    if (sc.kind === 'check') return 'Check';
    if (sc.kind === 'call') return 'Call ' + money(sc.amount);
    if (sc.kind === 'allin') return sc.amount <= toCall + 1e-9 ? 'Call all-in ' + money(sc.amount) : 'All-in ' + money(heroStageBet + sc.amount);
    if (sc.kind === 'bet' && heroStageBet <= 0) return 'Bet ' + money(sc.amount);
    return 'Raise to ' + money(heroStageBet + sc.amount);
  }
  function tone(sc) { return !sc ? '' : sc.kind === 'fold' ? 'fold' : (sc.kind === 'check' || sc.kind === 'call') ? 'passive' : 'aggr'; }
  function sizeNote(s) {
    var size = s.sizeLabel && s.sizeLabel !== 'raise' ? s.sizeLabel : '';
    return s.freq != null ? (size ? size + ' · ' : '') + 'play ' + pct(s.freq) : size;
  }

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.id = 'patio-solver-host';
  host.style.cssText = 'position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.panel{position:fixed;width:min(340px,calc(100vw - 16px));background:rgba(16,20,18,.95);color:#eef2ef;border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%;overflow:hidden}' +
    '.bar{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:move}' +
    '.dot{width:9px;height:9px;border-radius:50%;background:#777;flex:none}.dot.live{background:#3fcf6e}.dot.turn{background:#ffcc33;box-shadow:0 0 8px #ffcc33}' +
    '.main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden}' +
    '.act{font-weight:700;font-size:17px;overflow:hidden;text-overflow:ellipsis}.act.aggr{color:#4be08a}.act.passive{color:#6cb8ff}.act.fold{color:#ff7a7a}.act.idle{font-weight:500;font-size:13.5px;color:#c4ccc6}' +
    '.ev{font-size:12px;color:#aab3ad;flex:none}' +
    '.chev{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:inherit;font-size:15px}' +
    '.stale .act{opacity:.45}' +
    '.badge{font-size:11px;padding:1px 6px;border-radius:99px;background:rgba(255,204,51,.18);color:#ffd866;flex:none}' +
    '.bd{padding:2px 12px 10px;display:flex;flex-direction:column;gap:10px;max-height:min(62vh,520px);overflow:auto;-webkit-overflow-scrolling:touch;border-top:1px solid rgba(255,255,255,.08)}' +
    '.hand{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:8px}' +
    '.cd{display:inline-block;background:#f4f4f0;color:#111;border-radius:4px;padding:0 4px;font-weight:700;font-size:13px}.cd.red{color:#c81e1e}' +
    '.muted{color:#95a09a;font-size:12px}.status{color:#aab3ad;font-size:13px;padding-top:8px}' +
    '.kv{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:13px}.kv span:nth-child(even){text-align:right;font-variant-numeric:tabular-nums}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}td{padding:3px 0;font-variant-numeric:tabular-nums}td:last-child{text-align:right}tr.best td{font-weight:700;color:#fff}' +
    '.neg{color:#ff9a9a}.pos{color:#8ff0b4}' +
    '.sec{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8c968f;margin-bottom:4px}' +
    '.opp{padding:6px 0;border-top:1px solid rgba(255,255,255,.06)}.opp:first-of-type{border-top:0}.nm{font-weight:600}.ty{font-size:11px;padding:1px 6px;border-radius:99px;background:rgba(255,255,255,.1);margin-left:4px}.tip{color:#aab3ad;font-size:12px;margin-top:2px}' +
    '.ft{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding-top:4px}' +
    '.btn,select{background:rgba(255,255,255,.1);color:inherit;border:0;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}select option{color:#111}' +
    '.spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;margin-right:6px;vertical-align:-1px}@keyframes s{to{transform:rotate(360deg)}}' +
    '</style>' +
    '<div class="panel"><div class="bar"><span class="dot"></span><div class="main"></div><button class="chev" data-a="toggle">▾</button></div><div class="bd"></div></div>';
  var panel = root.querySelector('.panel'), bar = root.querySelector('.bar'), mainEl = root.querySelector('.main'),
    body = root.querySelector('.bd'), dot = root.querySelector('.dot'), chev = root.querySelector('.chev');

  function place() {
    var w = panel.offsetWidth || 340;
    var x = ui.x == null ? (narrow ? (W.innerWidth - w) / 2 : W.innerWidth - w - 16) : ui.x;
    var y = ui.y == null ? (narrow ? 64 : 80) : ui.y;
    x = Math.min(Math.max(4, x), W.innerWidth - Math.min(w, 120));
    y = Math.min(Math.max(4, y), W.innerHeight - 48);
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  // Drag the bar to move; a short tap on it expands/collapses.
  (function () {
    var sx, sy, ox, oy, down = false, moved = false;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      down = true; moved = false; sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    bar.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      moved = true; ui.x = ox + dx; ui.y = oy + dy; place();
    });
    bar.addEventListener('pointerup', function () {
      if (!down) return; down = false;
      if (moved) save(UI_KEY, ui); else { ui.expanded = !ui.expanded; save(UI_KEY, ui); render(); }
    });
  })();

  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]');
    if (!a) return;
    var what = a.getAttribute('data-a');
    if (what === 'toggle') { ui.expanded = !ui.expanded; save(UI_KEY, ui); render(); }
    else if (what === 'opts') { ui.showOptions = !ui.showOptions; save(UI_KEY, ui); render(); }
    else if (what === 'log') {
      var url = URL.createObjectURL(new Blob([JSON.stringify(tracker.db.history || [], null, 1)], { type: 'application/json' }));
      var link = document.createElement('a');
      link.href = url; link.download = 'patio-hand-log.json';
      root.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }
    else if (what === 'reset') {
      if (a.getAttribute('data-c') !== '1') {
        a.setAttribute('data-c', '1'); a.textContent = 'Tap again to reset';
        setTimeout(function () { a.removeAttribute('data-c'); a.textContent = 'Reset reads'; }, 3000);
        return;
      }
      tracker.db = { players: {} }; save(DB_KEY, tracker.db); render();
    }
  });
  root.addEventListener('change', function (e) {
    if (e.target.matches('select')) {
      ui.tableStyle = e.target.value; save(UI_KEY, ui);
      if (advice && !advice.stale) requestAdvice(); else render();
    }
  });

  // ---------- rendering ----------
  function readsHtml(list) {
    if (!list.length) return '';
    return '<div><div class="sec">Reads</div>' + list.map(function (o) {
      return '<div class="opp"><span class="nm">' + esc(o.name) + '</span><span class="ty">' + esc(o.type) + '</span>' +
        '<div class="muted">' + Math.round(o.hands) + ' hand' + (Math.round(o.hands) === 1 ? '' : 's') + ' · VPIP ' + pct(o.vpip) + ' · PFR ' + pct(o.pfr) + ' · folds to bets ' + pct(o.ftb) + (o.likely ? ' · likely ' + esc(o.likely) : '') + '</div>' +
        (o.summary ? '<div class="muted">' + esc(o.summary) + '</div>' : '') +
        (o.bluffChance != null ? '<div class="tip">Bluffing here about ' + pct(o.bluffChance) + ' of the time</div>' : '') +
        (o.tip ? '<div class="tip">' + esc(o.tip) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function liveReads() {
    var h = tracker.hand;
    if (!h) return [];
    var heroId = tracker.heroId(), out = [];
    Object.keys(h.players).forEach(function (k) {
      var p = h.players[k];
      if (p.id === heroId) return;
      var r = tracker.db.players[p.auth];
      var st = PokerEngine.computeStats(Object.assign(PatioTracker.blankTally(), r ? r.tally : {}), ui.tableStyle);
      out.push({ name: p.name + (p.folded ? ' (folded)' : ''), type: PokerEngine.classifyPlayer(st).label, hands: st.hands, vpip: st.raw.vpip, pfr: st.raw.pfr, ftb: st.raw.foldToBet, summary: PokerEngine.readSummary(st) });
    });
    return out;
  }

  function render() {
    var fresh = advice && !advice.stale;
    dot.className = 'dot' + (blocked ? '' : (fresh || thinking) ? ' turn' : tracker.snap ? ' live' : '');
    chev.textContent = ui.expanded ? '▴' : '▾';
    panel.classList.toggle('stale', !!(advice && advice.stale));

    // Bar
    if (blocked) mainEl.innerHTML = '<span class="act idle">Off at public tables</span>';
    else if (thinking && !fresh) mainEl.innerHTML = '<span class="act idle"><span class="spin"></span>Thinking…</span>';
    else if (advice) {
      var b = advice.result.best;
      mainEl.innerHTML = '<span class="act ' + tone(b) + '">' + esc(actionText(b, advice.ctx.heroStageBet, advice.result.toCall)) + '</span>' +
        (advice.result.close && fresh ? '<span class="badge">close</span>' : '') +
        '<span class="ev">' + (advice.stale ? 'last turn' : (b.kind === 'fold' ? '' : (b.ev >= 0 ? '+' : '−') + money(Math.abs(b.ev)))) + '</span>';
    } else mainEl.innerHTML = '<span class="act idle">' + esc(status) + '</span>';

    body.style.display = ui.expanded ? '' : 'none';
    if (!ui.expanded) { place(); return; }
    if (blocked) { body.innerHTML = '<div class="status">' + esc(status) + '</div>'; place(); return; }

    var h = tracker.hand, html = '';
    var heroCards = h ? h.heroUids.map(function (u) { return h.heroCards[u]; }).filter(Boolean) : [];
    if (heroCards.length || (h && h.board.length)) {
      html += '<div class="hand">' + heroCards.map(cardHtml).join('') + (h.board.length ? '<span class="muted">&nbsp;board</span>' + h.board.map(cardHtml).join('') : '') + '</div>';
    }
    if (advice) {
      var r = advice.result, c = advice.ctx, best = r.best, kv = [];
      if (r.hero) kv.push(['Your hand', esc(r.hero.made + (r.hero.draws && r.hero.draws.length ? ' + ' + r.hero.draws.map(function (d) { return d.name.toLowerCase(); }).join(', ') : '') + (r.street === 0 && r.hero.topPercent != null ? ' (top ' + Math.max(1, Math.round(r.hero.topPercent)) + '%)' : ''))]);
      if (r.mix) kv.push(['Close spot, mix it', esc(r.mix.map(function (m) { return m.label + ' ' + pct(m.freq); }).join(' · '))]);
      if (r.equity) kv.push(['Equity vs their ranges', pct(r.equity.share)]);
      if (r.toCall > 0) kv.push(['Needed to call', pct(r.potOdds)]);
      kv.push(['Pot', money(r.pot)]);
      kv.push(['Position', r.inPosition ? 'In position' : 'Out of position']);
      if (r.lookahead) kv.push(['Plans ahead', r.street === 3 ? 'Turn and river' : 'River']);
      if (r.solver) kv.push(['River solve', 'Your range vs theirs']);
      if (best.foldPct > 0.02 && (best.kind === 'bet' || best.kind === 'raise' || best.kind === 'allin')) kv.push(['They fold to this', pct(best.foldPct)]);
      html += '<div class="kv">' + kv.map(function (p) { return '<span>' + p[0] + '</span><span>' + p[1] + '</span>'; }).join('') + '</div>';
      html += '<div><div class="sec" data-a="opts">All options ' + (ui.showOptions ? '▾' : '▸') + '</div>';
      if (ui.showOptions) {
        html += '<table>' + r.ranked.map(function (s) {
          var isBest = s.kind === best.kind && s.amount === best.amount;
          var note = sizeNote(s);
          return '<tr class="' + (isBest ? 'best' : '') + '"><td>' + esc(actionText(s, c.heroStageBet, r.toCall)) + (note ? ' <span class="muted">' + esc(note) + '</span>' : '') + '</td>' +
            '<td class="' + (s.ev < 0 ? 'neg' : s.ev > 0 ? 'pos' : '') + '">' + (s.ev >= 0 ? '+' : '−') + money(Math.abs(s.ev)) + '</td></tr>';
        }).join('') + '</table>';
      }
      html += '</div>';
      html += readsHtml(r.opponents.map(function (o) {
        return { name: o.name, type: o.type.label, tip: o.type.key !== 'unknown' ? o.type.tip : '', hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, ftb: o.stats.foldToBet, likely: o.topClasses.slice(0, 5).join(' '), summary: o.summary, bluffChance: o.bluffChance };
      }));
    } else {
      if (!thinking) html += '<div class="status">' + esc(status) + '</div>';
      html += readsHtml(liveReads());
    }
    var n = Object.keys(tracker.db.players).length;
    html += '<div class="ft"><select>' + ['tight', 'typical', 'loose'].map(function (s) {
      return '<option value="' + s + '"' + (ui.tableStyle === s ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + ' table</option>';
    }).join('') + '</select><span style="flex:1"></span><button class="btn" data-a="log">Hand log</button> <button class="btn" data-a="reset">Reset reads</button></div>';
    html += '<div class="muted">Tracking ' + n + ' player' + (n === 1 ? '' : 's') + '. Reads sharpen as hands pile up.</div>';
    body.innerHTML = html;
    place();
  }

  // ---------- solver ----------
  function requestAdvice() {
    var built = tracker.solverInput(ui.tableStyle);
    if (built.error) { status = built.error; render(); return; }
    var id = ++reqId;
    thinking = true;
    if (advice) advice.stale = true;
    render();
    analyze(built.input).then(function (res) {
      if (id !== reqId) return;
      thinking = false;
      if (!res || !res.ok) { status = 'Solver error: ' + (res && res.error); advice = null; render(); return; }
      advice = { result: res.result, ctx: built, stale: false };
      tracker.noteAdvice(actionText(res.result.best, built.heroStageBet, res.result.toCall), res.result.best.ev || 0, res.result, function (sc) { return actionText(sc, built.heroStageBet, res.result.toCall); });
      render();
    });
  }

  tracker.on(function (type, p) {
    if (type === 'save') save(DB_KEY, tracker.db);
    else if (type === 'hand') { advice = null; thinking = false; reqId++; status = 'New hand. Waiting for your turn…'; render(); }
    else if (type === 'handEnd') { if (advice) advice.stale = true; thinking = false; reqId++; status = 'Hand over. Waiting for the next one…'; render(); }
    else if (type === 'turn') {
      if (p.isHero) requestAdvice();
      else if (advice && !advice.stale) { advice.stale = true; render(); }
    } else if (type === 'heroDone') { reqId++; thinking = false; if (advice) advice.stale = true; render(); }
    else if (type === 'action' || type === 'street' || type === 'cards') { if (ui.expanded) render(); }
  });

  // ---------- reading the game ----------
  var WANTED = {
    'game:stage_began': 1, 'game:dealer_updated': 1, 'game:small_blind_paid': 1, 'game:big_blind_paid': 1,
    'game:cards_dealt_to_player': 1, 'game:card_dealt_to_player': 1, 'game:update_card_data': 1,
    'game:cards_deal_to_stack': 1, 'game:card_deal_to_stack': 1, 'player:game:action_taken': 1,
    'game:player_turn_started': 1, 'game:player_turn_ended': 1, 'game:game_ended': 1, 'admin:game:game_stopped': 1
  };
  function snapshot() {
    var gm = W.GameManager, st = (gm && gm.state) || {};
    var bs = (st.settings && st.settings.blind_sizes) || [];
    return {
      tableType: gm && gm.data ? gm.data.tableType : null,
      heroAuthId: gm && gm.playerData ? gm.playerData.id : null,
      bigBlind: bs.length ? bs[bs.length - 1].bb : null,
      players: (st.players || []).map(function (p) {
        return { id: p.id, authUserId: p.authUserId, name: p.name, stack: p.stack, posType: p.posType, playState: p.playState };
      })
    };
  }
  function onEvent(ev, data) {
    var snap = snapshot();
    if (snap.tableType && snap.tableType !== 'private') {
      if (!blocked) { blocked = true; status = 'Patio Solver only runs in private lobbies with friends. It stays off at public tables.'; render(); }
      return;
    }
    blocked = false;
    try { tracker.handle(ev, data, snap); } catch (err) { /* keep the table running */ }
  }
  var hooked = null;
  setInterval(function () {
    var gm = W.GameManager, sock = gm && gm.socket;
    if (!sock || sock === hooked || typeof sock.onAny !== 'function') return;
    hooked = sock;
    sock.onAny(function (ev, data) { if (WANTED[ev]) onEvent(ev, data); });
    tracker.snap = snapshot();
    if (tracker.snap.tableType && tracker.snap.tableType !== 'private') { blocked = true; status = 'Patio Solver only runs in private lobbies with friends. It stays off at public tables.'; }
    else if (!tracker.hand) status = 'Connected. Advice starts next hand.';
    render();
  }, 300);

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    W.addEventListener('resize', place);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();

})();
