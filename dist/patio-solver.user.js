// ==UserScript==
// @name         Patio Solver
// @description  Solver advice for your Poker Patio private lobbies. Reads the table automatically.
// @version      1.5.0
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

  // Scores of one board plus many two-card hands. Without a possible flush a hand's score
  // depends only on the ranks, so each pair of hole-card ranks is evaluated once per board
  // and looked up after that. Use: setBoard(cards, n), then scoreHole(a, b) for each hand.
  const SB_BUF = new Int32Array(9), SB_CNT = new Int32Array(4), SB_T = new Int32Array(169);
  let SB_N = 0, SB_ALL = false;
  function setBoard(cards, n) {
    SB_N = n;
    SB_CNT.fill(0);
    SB_T.fill(-1);
    for (let i = 0; i < n; i++) { const c = cards[i]; SB_BUF[i] = c; SB_CNT[c & 3]++; }
    SB_ALL = SB_CNT[0] >= 5 || SB_CNT[1] >= 5 || SB_CNT[2] >= 5 || SB_CNT[3] >= 5;
  }
  function scoreHole(a, b) {
    const sa = a & 3, sb = b & 3;
    if (!SB_ALL && (sa === sb ? SB_CNT[sa] < 3 : SB_CNT[sa] < 4 && SB_CNT[sb] < 4)) {
      const key = (a >> 2) * 13 + (b >> 2);
      const t = SB_T[key];
      if (t >= 0) return t;
      SB_BUF[SB_N] = a; SB_BUF[SB_N + 1] = b;
      return (SB_T[key] = evaluate(SB_BUF, SB_N + 2));
    }
    SB_BUF[SB_N] = a; SB_BUF[SB_N + 1] = b;
    return evaluate(SB_BUF, SB_N + 2);
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

  // All-in equity of each starting-hand class against each other one (169 x 169, upper
  // triangle with the diagonal, Uint16 / 65535), from scripts/preflop-equity.js.
  const PF_EQ_B64 = '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PrT1szWzELQntuRPPk1zht5eCbTls+i0ALmFuDa4sLhFuie7VnEDcK+8Tb5WeCWlFqd3qHWr7KzYrNutaq/hdpp0n73vvsKsU3xgo3qkc6Ycqaqryquqreh3q3aVvcy/ZK6cqDB91qG8o3Kle6mEq8+sX3lxeh+/csPPsGus36kkgbKjxaEIphapdKttekZ60767w3+zja/Gqjur6YD9npqh36XLqO13KnokvfXCYra3r42taKlwpsOB8p7xoTSlVXcZeQK/wcOotXKztK7prKWpgqZ2ghOjz6apeCR5nr/zxIS1fLOVsyKwv6xKqdGqkoTFpwh56XkfwbPFe7ggtdOzbrThr/isdK6ErryFXn/6sDOwurBZsCaxG7H2sVWzumoEaC5Qg1N1s92gtKPdpLio6qfOpwmpxKgwUM1NVoaVvgJfCbKlsim1drVxtwa5BLpauut1j3QOu1Ooz7sPenmjOKQXpzOpVawurc6ttncvd3a8casKveGqoX3rovSiU6WqqEGrp6twebl4WbygrK6/663tqBWClKCworKlJ6hXq1B59Hg5umWwiL/GrrOqOqhYgVCgbKM6pvSp/HdNetW7xa7bwyuxLK2QqoinBYMjoLijZqYeeX96arsSr13C0LTQrxytWaovp9+DfaOHpuR5o3mAvOOv28NgtCi0pbDlrOipRaqchcWn+3hre/+9kLARxdO14LIDs1mwkK4BrmSviIbrfxmsCq1srNmrf6zIrLCt3mehZRZQRVFekuuzGKAJo1Wl/KKHpBykDqUrZ/VkIlOCmMJRka9onTqgFqP/o32ktqMlpQtRI01ahvq977m+XA2uULLEsRy187c0uMO5kHIVdGC1uafJpK246Xn6odyiqaRgp56rxqvXdQd2+bY/qiqmcryVp4J7y59OoXulCKnxqu90dXWZtlmss6kzvNioDKVpfN2ePKJIpUqnBnSJdS21i6piq8i+Bay1qb+ljH/knvShlKQQddp2BrYerKWr4sEgscqs8Kj3paqB5qIdpqZ16nb4tmur4at3wySze6+mrKqo7KnSguamAHbTd0O4P61PrmXECrNWs56wBawRrtytD4REgAmnxKURphOlQKd3p8BlpGLyT2hRX4/tksOz6p+uopugd6EnoliksGXXYU9TopQDUWOQ4K+GnuSei6K7oSWjZ6MXaDxm7Fb2mNmX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';
  let PF_EQ = null;
  function preflopEquityTable() {
    if (PF_EQ) return PF_EQ;
    const bin = typeof atob === 'function' ? atob(PF_EQ_B64) : Buffer.from(PF_EQ_B64, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const tri = new Uint16Array(bytes.buffer);
    const eq = new Float64Array(169 * 169);
    let k = 0;
    for (let a = 0; a < 169; a++) {
      for (let b = a; b < 169; b++) {
        const v = tri[k++] / 65535;
        eq[a * 169 + b] = a === b ? 0.5 : v;
        eq[b * 169 + a] = a === b ? 0.5 : 1 - v;
      }
    }
    PF_EQ = eq;
    return eq;
  }

  // Top `frac` of hands by preflop order, with a soft edge: real players mix in hands around
  // their cut-off (and the odd hand well outside it), so hands just past the line keep some
  // weight instead of zero. The total still comes to about `frac` of all combos.
  const CLASS_ORDER_MID = (() => {
    const mid = new Float64Array(169);
    let cum = 0;
    for (let i = 0; i < 169; i++) {
      const cls = CLASS_NAMES.indexOf(PREFLOP_ORDER[i]);
      const n = CLASS_COMBO_COUNT[cls];
      mid[cls] = (cum + n / 2) / NUM_COMBOS;
      cum += n;
    }
    return mid;
  })();
  function topClassWeights(frac, hard) {
    const w = new Float64Array(169);
    const f = Math.max(0, Math.min(1, frac));
    if (hard || f <= 0 || f >= 1) {
      const target = f * NUM_COMBOS;
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
    const width = Math.max(0.025, 0.3 * f);
    const total = (shift) => {
      let t = 0;
      for (let c = 0; c < 169; c++) t += CLASS_COMBO_COUNT[c] * sigmoid((f + shift - CLASS_ORDER_MID[c]) / width);
      return t / NUM_COMBOS;
    };
    let lo = -1, hi = 1;
    for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (total(m) < f) lo = m; else hi = m; }
    const sh = (lo + hi) / 2;
    for (let c = 0; c < 169; c++) w[c] = sigmoid((f + sh - CLASS_ORDER_MID[c]) / width);
    return w;
  }

  // ---------- Population priors for reads ----------
  // Each kind of decision is a family of yes/no choices, seen in a few contexts:
  //   vpip    plays the hand (calls or raises preflop), by position group
  //   pfr     raises, given that they play the hand, by position group
  //   bet     bets when nobody has bet yet: c-bet spots, other flop spots, turn, river
  //   fold    folds when facing a bet, by street
  //   raise   raises when facing a bet, given that they don't fold, by street
  // `mu` is the population's rate in each context ('all' = over every context), `tau` how far
  // a typical player sits from the population on the log-odds scale, and `tauC` how much a
  // player's rate in one context can differ from their own rate in the others.
  // `rates` are single-context stats as [population rate, prior strength in hands].
  // 'home' is fitted from the owner's hand logs (test/fit-priors.js), so a friend seen for the
  // first time is read as the home game's average player, not a generic amateur. 'solid' is
  // the old 'typical' (a sound regular); it stands for hero's own range.
  const READ_PRIORS = {
    home: {
      vpip: { mu: { all: 0.644, early: 0.667, late: 0.733, blinds: 0.584, other: 0.644 }, tau: 0.35, tauC: 0.3 },
      pfr: { mu: { all: 0.253, early: 0.243, late: 0.241, blinds: 0.258, other: 0.253 }, tau: 1.15, tauC: 0.3 },
      bet: { mu: { all: 0.272, cbet: 0.351, flop: 0.181, turn: 0.257, river: 0.422, other: 0.272 }, tau: 0.5, tauC: 0.3 },
      fold: { mu: { all: 0.46, allMW: 0.541, flop: 0.378, turn: 0.435, river: 0.575, flopMW: 0.53, turnMW: 0.482, riverMW: 0.677, flopOld: 0.49, turnOld: 0.458, riverOld: 0.632, other: 0.46 }, tau: 0.35, tauC: 0.3 },
      raise: { mu: { all: 0.19, flop: 0.21, turn: 0.14, river: 0.244, other: 0.19 }, tau: 0.35, tauC: 0.3 },
      rates: {
        threeBet: [0.165, 10], callBig: [0.51, 6], foldAfterAgg: [0.351, 8], foldCbet: [0.348, 5], wtsd: [0.277, 5],
        f3bet: [0.133, 5], fourBet: [0.5, 5], limp: [0.572, 6],
      },
      // Response to a single open raise by its size (raise-to <= 2.5bb, <= 3.5bb, more):
      // continue (call or 3-bet) and 3-bet, as shares of their chances to respond.
      // Fitted on 78 responses: they continue against three in four opens of up to 3.5bb and 3-bet
      // a quarter of them (min-raise wars); bigger opens get about half.
      vsOpen: { small: [0.75, 0.3], medium: [0.72, 0.25], large: [0.49, 0.17], k: 6 },
      // betSize is their usual bet (the median; the mean is pulled up by shoves).
      af: 1.28, betSize: 0.5,
      // Range tilt (see buildRange) for lines with a bet or raise and for check/call lines: the
      // friends' shown hands sit a little lower than the model puts them after checking and
      // calling. After betting they fit +0.15, but showdowns over-sample value there (bluffs that
      // win uncontested are never shown), so it stays 0. k is the penalty that keeps a player near
      // it; kUp is for reading a betting line stronger than this.
      tilt: { agg: 0, pas: -0.15, k: 6, kUp: 20 },
      // Range noise (see applyAction): the share of each line's hands that take it whatever
      // their strength. The friends' showdowns fit about half.
      noise: { mu: 0.45, k: 6 },
      // Players who re-raised preflop (3-bet or more) fold less to bets after the flop: 38% against
      // 51% for everyone in the logs (25% on the flop and turn). Odds multiplier on their fold
      // rates (the benchmark's best; a single open raise made no difference there).
      reraisedFold: 0.65,
    },
    solid: {
      vpip: { mu: { all: 0.28, early: 0.224, late: 0.35, blinds: 0.28, other: 0.28 }, tau: 0.8, tauC: 0.35 },
      pfr: { mu: { all: 0.5, early: 0.5, late: 0.5, blinds: 0.5, other: 0.5 }, tau: 0.8, tauC: 0.35 },
      bet: { mu: { all: 0.38, cbet: 0.6, flop: 0.38, turn: 0.38, river: 0.38, other: 0.38 }, tau: 0.8, tauC: 0.45 },
      fold: { mu: { all: 0.45, allMW: 0.5, flop: 0.45, turn: 0.45, river: 0.45, flopMW: 0.5, turnMW: 0.5, riverMW: 0.5, flopOld: 0.45, turnOld: 0.45, riverOld: 0.45, other: 0.45 }, tau: 0.8, tauC: 0.45 },
      raise: { mu: { all: 0.165, flop: 0.165, turn: 0.165, river: 0.165, other: 0.165 }, tau: 0.8, tauC: 0.45 },
      rates: {
        threeBet: [0.063, 10], callBig: [0.21, 6], foldAfterAgg: [0.18, 8], foldCbet: [0.45, 5], wtsd: [0.3, 5],
        f3bet: [0.5, 5], fourBet: [0.45, 5], limp: [0.3, 6],
      },
      vsOpen: { small: [0.38, 0.07], medium: [0.32, 0.06], large: [0.26, 0.05], k: 6 },
      af: 1.8, betSize: 0.6,
      tilt: { agg: 0, pas: 0, k: 6, kUp: 20 },
      noise: { mu: 0.25, k: 6 },
      reraisedFold: 1,
    },
  };
  // A table style shifts the home prior: tighter players play fewer hands and fold more.
  function shiftedPrior(base, d) {
    const out = JSON.parse(JSON.stringify(base));
    for (const fam of Object.keys(d)) {
      const f = out[fam];
      if (f && f.mu) for (const k of Object.keys(f.mu)) f.mu[k] = sigmoid(logit(f.mu[k]) + d[fam]);
    }
    return out;
  }
  READ_PRIORS.tight = shiftedPrior(READ_PRIORS.home, { vpip: -0.9, pfr: 0.2, fold: 0.3, bet: 0.1 });
  READ_PRIORS.loose = shiftedPrior(READ_PRIORS.home, { vpip: 0.5, pfr: -0.2, fold: -0.3, bet: -0.1 });
  READ_PRIORS.typical = READ_PRIORS.home;
  // Hero's own range (for hero's story and the river and turn solvers) is read as a solid
  // regular's, not as the home game's average player: hero plays the solver's advice.
  const HERO_STYLE = 'solid';
  function readPrior(style) {
    if (style && typeof style === 'object' && style.vpip && style.vpip.mu) return style;
    return READ_PRIORS[style] || READ_PRIORS.home;
  }
  // The old flat summary of each style (kept for anything that reads it).
  const TABLE_PRIORS = {};
  for (const k of Object.keys(READ_PRIORS)) {
    const p = READ_PRIORS[k];
    const ftb = p.fold.mu.all;
    TABLE_PRIORS[k] = { vpip: p.vpip.mu.all, pfr: p.vpip.mu.all * p.pfr.mu.all, af: p.af, betFreq: p.bet.mu.all, foldToBet: ftb, raiseFreq: (1 - ftb) * p.raise.mu.all };
  }

  const EMPTY_TALLY = { pfFold: 0, pfCall: 0, pfRaise: 0, check: 0, bet: 0, call: 0, raise: 0, fold: 0, pf3betOpp: 0, pf3bet: 0, pfBigOpp: 0, pfBigCall: 0, aggVsN: 0, aggVsFold: 0, cbetOpp: 0, cbet: 0, vsCbet: 0, foldCbet: 0, sawFlop: 0, wtsd: 0, limpOpp: 0, limp: 0, f3betOpp: 0, f3bet: 0, pf4bet: 0 };
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
    setBoard(board, board.length);
    const mine = scoreHole(hole[0], hole[1]);
    let below = 0, ties = 0, total = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      const a = COMBO_HI[k], b = COMBO_LO[k];
      if (dead[a] || dead[b] || a === hole[0] || a === hole[1] || b === hole[0] || b === hole[1]) continue;
      const sc = scoreHole(a, b);
      total++;
      if (sc < mine) below++; else if (sc === mine) ties++;
    }
    return total ? (below + ties / 2) / total : 0.5;
  }

  // Shown hands -> how many of their bets and raises were value, thin value or bluffs.
  // A bet counts as value when the hand was in the top 30% of all hands on that board,
  // a bluff when it was in the bottom 45% (semi-bluffs with draws count as bluffs).
  const showCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  // A hand shown after its owner folded never reached the end of the line it would be scored
  // against, so it says nothing about that line's range (friends often show folded hands).
  // It still counts in classifyShows: bets made before the fold are real bluffs.
  function foldedShow(sh) {
    return !!(sh && (sh.folded || Object.values(sh.actions || {}).some((a) => a === 'fold')));
  }

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

  // ---------- Per-player reads ----------
  // A player's tally split into the contexts of each decision family, as [times, chances].
  function tallyCells(t) {
    const z = (x) => Math.max(0, x || 0);
    const cell = (x, n) => [Math.min(z(x), z(n)), z(n)];
    const pos = t.pos || {};
    const vpip = {}, pfr = {};
    let hn = 0, hv = 0, hr = 0;
    for (const k of ['early', 'late', 'blinds']) {
      const x = Object.assign({ n: 0, vpip: 0, pfr: 0 }, pos[k] || {});
      vpip[k] = cell(x.vpip, x.n); pfr[k] = cell(x.pfr, x.vpip);
      hn += z(x.n); hv += z(x.vpip); hr += z(x.pfr);
    }
    const hands = z(t.pfFold) + z(t.pfCall) + z(t.pfRaise), played = z(t.pfCall) + z(t.pfRaise);
    vpip.other = cell(played - hv, hands - hn);
    pfr.other = cell(z(t.pfRaise) - hr, played - hv);
    const st = (k) => Object.assign({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, (t.st && t.st[k]) || {});
    const f = st('flop'), tu = st('turn'), r = st('river');
    const bet = {
      cbet: cell(t.cbet, t.cbetOpp),
      flop: cell(f.bet - z(t.cbet), f.bet + f.check - z(t.cbetOpp)),
      turn: cell(tu.bet, tu.bet + tu.check),
      river: cell(r.bet, r.bet + r.check),
    };
    const fold = {}, raise = {};
    // Folds are split into heads-up and multiway spots (friends fold far more often when others
    // are still in), plus counts saved before the split was tracked, which keep the mixed rate.
    const part = (src, k) => Object.assign({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, (src && src[k]) || {});
    for (const [k, x] of [['flop', f], ['turn', tu], ['river', r]]) {
      const mw = part(t.stMw, k), old = part(t.stOld, k);
      const facing = (y) => y.fold + y.call + y.raise;
      fold[k] = cell(x.fold - mw.fold - old.fold, facing(x) - facing(mw) - facing(old));
      fold[k + 'MW'] = cell(mw.fold, facing(mw));
      fold[k + 'Old'] = cell(old.fold, facing(old));
      raise[k] = cell(x.raise, x.call + x.raise);
    }
    // Counts from reads saved before per-street tallies existed.
    const sum = (key) => f[key] + tu[key] + r[key];
    bet.other = cell(z(t.bet) - sum('bet'), z(t.bet) + z(t.check) - sum('bet') - sum('check'));
    fold.other = cell(z(t.fold) - sum('fold'), z(t.fold) + z(t.call) + z(t.raise) - sum('fold') - sum('call') - sum('raise'));
    raise.other = cell(z(t.raise) - sum('raise'), z(t.call) + z(t.raise) - sum('call') - sum('raise'));
    return { vpip, pfr, bet, fold, raise };
  }

  // One player's rates in a decision family: rate_c = sigmoid(mu_c + u + v_c), where u (prior
  // spread tau, see T_DF) is how the player differs from the population across the whole family and v_c
  // (prior N(0, tauC^2)) a smaller difference in one context. Maximum a posteriori by Newton
  // steps. Because u is shared, a few flop decisions also inform the turn and river, and the
  // population's street and position effects apply from a player's first hand.
  // `certainty` is the share of the between-player spread that the player's data has resolved
  // (0 = nothing seen, near 1 = many hands).
  // The spread between players is a Student-t (3 degrees of freedom) on the log-odds scale:
  // like a normal with sd tau for players near the average, with heavier tails, so a real
  // outlier (a friend who plays every hand) is learned in tens of hands, not hundreds.
  const T_DF = 3;
  function fitFamily(cells, fam) {
    const keys = Object.keys(fam.mu).filter((k) => k !== 'all' && k !== 'allMW');
    const m = {};
    for (const k of keys) m[k] = logit(clamp(fam.mu[k], 0.01, 0.99));
    const t2 = fam.tau * fam.tau, ic2 = 1 / (fam.tauC * fam.tauC);
    let u = 0, H = -1 / t2;
    for (let it = 0; it < 40; it++) {
      // Prior gradient and a always-negative curvature (iteratively reweighted).
      const w = (T_DF + 1) / (T_DF * t2 + u * u);
      let g = -w * u, h = -w;
      for (const k of keys) {
        const c = cells[k];
        if (!c || !(c[1] > 0)) continue;
        const p = sigmoid(m[k] + u);
        g += c[0] - c[1] * p; h -= c[1] * p * (1 - p);
      }
      const step = clamp(g / h, -1, 1);
      u -= step; H = h;
      if (Math.abs(step) < 1e-6) break;
    }
    const rate = {}, n = {};
    for (const k of keys) {
      const c = cells[k] || [0, 0];
      let v = 0;
      if (c[1] > 0) {
        for (let it = 0; it < 12; it++) {
          const p = sigmoid(m[k] + u + v);
          const g = c[0] - c[1] * p - v * ic2, h = -c[1] * p * (1 - p) - ic2;
          const step = g / h;
          v -= step;
          if (Math.abs(step) < 1e-6) break;
        }
      }
      rate[k] = sigmoid(m[k] + u + v);
      n[k] = c[1];
    }
    const sd = Math.sqrt(-1 / H);
    return {
      u, sd, rate, n,
      all: sigmoid(logit(clamp(fam.mu.all, 0.01, 0.99)) + u),
      allMW: fam.mu.allMW != null ? sigmoid(logit(clamp(fam.mu.allMW, 0.01, 0.99)) + u) : null,
      certainty: clamp(1 - (sd * sd) / t2, 0, 1),
    };
  }

  const tallyNumbers = (t, out, sign) => {
    for (const k of Object.keys(t || {})) {
      if (k === 'shows' || k === 'pred') continue;
      const v = t[k];
      if (typeof v === 'number') out[k] = (out[k] || 0) + sign * v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) tallyNumbers(v, out[k] || (out[k] = {}), sign);
    }
    return out;
  };
  // Every known player's counts added up: the table's own population, so the prior follows
  // the friends actually being played even when they differ from the logs it was fitted on.
  function poolTally(tallies) {
    const out = {};
    for (const t of tallies || []) if (t) tallyNumbers(t, out, 1);
    return out;
  }

  // Blend the fitted prior's population rates with the pooled table (minus the player
  // being read), weighted by how many decisions the table has shown in each family.
  const POOL_K = 120;
  function pooledPrior(base, pool, own) {
    if (!pool) return base;
    const rest = tallyNumbers(own || {}, tallyNumbers(pool, {}, 1), -1);
    const cells = tallyCells(Object.assign({}, EMPTY_TALLY, rest));
    const out = Object.assign({}, base);
    for (const fam of ['vpip', 'pfr', 'bet', 'fold', 'raise']) {
      const b = base[fam], c = cells[fam];
      const mu = {};
      let X = 0, N = 0;
      for (const k of Object.keys(b.mu)) {
        if (k === 'all' || k === 'allMW') { if (k === 'allMW') mu.allMW = b.mu.allMW; continue; }
        const x = c[k] ? c[k][0] : 0, nn = c[k] ? c[k][1] : 0;
        X += x; N += nn;
        // Per context, add the pooled counts to the prior's rate as pseudo-counts.
        mu[k] = (x + POOL_K * b.mu[k]) / (nn + POOL_K);
      }
      mu.all = (X + POOL_K * b.mu.all) / (N + POOL_K);
      out[fam] = Object.assign({}, b, { mu });
    }
    return out;
  }

  // Beta-binomial rate: (times + k * prior) / (chances + k).
  const betaRate = (x, n, prior, k) => (Math.max(0, x || 0) + k * prior) / (Math.max(0, n || 0) + k);

  // ctx.multiway: the read is for a pot with two or more opponents, so fold rates are the
  // player's multiway ones (stats.read keeps both, for predictAction).
  function computeStats(tally, tableStyle, pool, ctx) {
    const mwCtx = !!(ctx && ctx.multiway);
    const t = Object.assign({}, EMPTY_TALLY, tally || {});
    const prior = pooledPrior(readPrior(tableStyle), pool, tally);
    const R = prior.rates;
    const hands = t.pfFold + t.pfCall + t.pfRaise;
    const unopened = t.check + t.bet;
    const facing = t.fold + t.call + t.raise;
    const KA = 3;

    const cells = tallyCells(t);
    const fam = {};
    for (const k of ['vpip', 'pfr', 'bet', 'fold', 'raise']) fam[k] = fitFamily(cells[k], prior[k]);
    const vpip = fam.vpip.all;
    const pfr = vpip * fam.pfr.all;
    const foldHU = fam.fold.all, foldMW = fam.fold.allMW != null ? fam.fold.allMW : foldHU;
    const foldToBet = mwCtx ? foldMW : foldHU;
    const stats = {
      hands,
      postflopActions: unopened + facing,
      vpip,
      pfr,
      af: (t.bet + t.raise + KA * prior.af) / (t.call + KA),
      betFreq: fam.bet.all,
      foldToBet,
      raiseFreq: (1 - foldToBet) * fam.raise.all,
      raw: {
        vpip: hands ? (t.pfCall + t.pfRaise) / hands : null,
        pfr: hands ? t.pfRaise / hands : null,
        af: t.call ? (t.bet + t.raise) / t.call : (t.bet + t.raise ? Infinity : null),
        betFreq: unopened ? t.bet / unopened : null,
        foldToBet: facing ? t.fold / facing : null,
        raiseFreq: facing ? t.raise / facing : null,
      },
      // How far this player sits from the population in each family (log-odds) and how sure we are.
      families: {},
    };
    for (const k of Object.keys(fam)) stats.families[k] = { u: fam[k].u, sd: fam[k].sd, certainty: fam[k].certainty };

    // Preflop 3-bet and flop c-bet frequencies.
    stats.threeBet = betaRate(t.pf3bet, t.pf3betOpp, R.threeBet[0], R.threeBet[1]);
    // 4-bet: re-raising after they raised and got 3-bet.
    stats.fourBet = clamp(betaRate(t.pf4bet, t.f3betOpp, R.fourBet[0], R.fourBet[1]), 0.15, 0.95);
    stats.foldTo3bet = betaRate(t.f3bet, t.f3betOpp, R.f3bet[0], R.f3bet[1]);
    stats.limp = betaRate(t.limp, t.limpOpp, R.limp[0], R.limp[1]);
    // How often they call (or re-raise) a big preflop raise or shove. Home-game players call
    // shoves much wider than the bet-size math says, so the prior follows their looseness.
    const cbPrior = clamp(R.callBig[0] * Math.sqrt(vpip / Math.max(0.05, prior.vpip.mu.all)), 0.18, 0.6);
    stats.callBig = betaRate(t.pfBigCall, t.pfBigOpp, cbPrior, R.callBig[1]);
    stats.raw.callBig = t.pfBigOpp ? t.pfBigCall / t.pfBigOpp : null;
    // Folding to a bet after they already bet or raised this hand: their range is strong by then,
    // so this is much lower than their overall fold rate.
    const faPrior = clamp(R.foldAfterAgg[0] * foldToBet / Math.max(0.05, prior.fold.mu.all), 0.06, 0.4);
    stats.foldAfterAgg = betaRate(t.aggVsFold, t.aggVsN, faPrior, R.foldAfterAgg[1]);
    stats.raw.foldAfterAgg = t.aggVsN ? t.aggVsFold / t.aggVsN : null;
    stats.cbet = fam.bet.rate.cbet;
    stats.foldToCbet = betaRate(t.foldCbet, t.vsCbet, fam.fold.rate.flop, R.foldCbet[1]);
    stats.wtsd = betaRate(t.wtsd, t.sawFlop, R.wtsd[0], R.wtsd[1]);
    stats.raw.threeBet = t.pf3betOpp ? t.pf3bet / t.pf3betOpp : null;
    stats.raw.cbet = t.cbetOpp ? t.cbet / t.cbetOpp : null;
    stats.raw.foldToCbet = t.vsCbet ? t.foldCbet / t.vsCbet : null;
    stats.raw.wtsd = t.sawFlop ? t.wtsd / t.sawFlop : null;

    // Response to a single open raise, by its size in big blinds (for the preflop solver).
    // The prior follows the population's response to that size, moved by this player's looseness.
    stats.vsOpen = {};
    const vo = t.vsOpen || {};
    const looser = fam.vpip.u;
    for (const key of ['small', 'medium', 'large']) {
      const x = Object.assign({ fold: 0, call: 0, raise: 0 }, vo[key] || {});
      const n = x.fold + x.call + x.raise;
      const [c0, r0] = prior.vsOpen[key];
      const cont = betaRate(x.call + x.raise, n, sigmoid(logit(c0) + looser), prior.vsOpen.k);
      const threeBet = Math.min(cont, betaRate(x.raise, n, clamp(r0 * stats.threeBet / Math.max(0.01, R.threeBet[0]), 0.01, 0.4), prior.vsOpen.k));
      stats.vsOpen[key] = { cont, threeBet, n };
    }

    // Per street.
    stats.byStreet = {};
    for (const n of [3, 4, 5]) {
      const k = STREET_KEYS[n];
      const x = Object.assign({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 }, (t.st && t.st[k]) || {});
      const ftb = fam.fold.rate[mwCtx && fam.fold.rate[k + 'MW'] != null ? k + 'MW' : k];
      stats.byStreet[n] = {
        betFreq: fam.bet.rate[k],
        foldToBet: ftb,
        raiseFreq: (1 - ftb) * fam.raise.rate[k],
        samples: x.check + x.bet + x.fold + x.call + x.raise,
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
    stats.betSize = clamp((bs.sum + 3 * prior.betSize) / (bs.n + 3), 0.2, 2);

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

    // Preflop by position group.
    stats.byPos = {};
    for (const g of ['early', 'late', 'blinds']) {
      const v = fam.vpip.rate[g];
      stats.byPos[g] = { vpip: v, pfr: v * fam.pfr.rate[g], hands: fam.vpip.n[g] };
    }

    const n = hands + stats.postflopActions / 2;
    stats.confidence = n < 10 ? 'guess' : n < 40 ? 'low' : n < 120 ? 'medium' : 'solid';

    // Read accuracy: where each shown hand sat in the range we would have put them on.
    // A well-calibrated range has the shown hand in its more likely half about half the
    // time. Hands shown after folding are left out (the line we scored them on never finished).
    const fits = (t.shows || []).filter((x) => x && !x.folded && !(x.actions && Object.values(x.actions).includes('fold')))
      .map((x) => x.fit).filter((f) => f && f.top != null && f.v === FIT_VERSION);
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
    // Range tilt learned from showdowns, separately for lines where they bet or raised and lines
    // where they only checked and called: maximum a posteriori around the population's tilt, with
    // a stiffer penalty for reading a betting line stronger than the population (shown hands
    // over-sample value: bluffs that win uncontested are never seen).
    const tp = prior.tilt || { agg: 0, pas: 0, k: 6, kUp: 20 };
    const fitTilt = (agg) => {
      const mu = agg ? tp.agg : tp.pas;
      const fl = fits.filter((f) => f.tl && f.tl.length === TILTS.length && !!f.agg === agg);
      if (!fl.length) return mu;
      const sum = TILTS.map((_, i) => fl.reduce((a, f) => a + f.tl[i], 0));
      let best = mu, bestV = -Infinity;
      for (let j = 0; j <= 60; j++) {
        const tau = TILTS[0] + (j / 60) * (TILTS[TILTS.length - 1] - TILTS[0]);
        let i = 0;
        while (i < TILTS.length - 2 && tau > TILTS[i + 1]) i++;
        const w = (tau - TILTS[i]) / (TILTS[i + 1] - TILTS[i]);
        const d = tau - mu;
        const v = sum[i] * (1 - w) + sum[i + 1] * w - (agg && d > 0 ? tp.kUp : tp.k) * d * d;
        if (v > bestV) { bestV = v; best = tau; }
      }
      return Math.round(best * 1000) / 1000;
    };
    // How noisy their lines are (see applyAction): maximum a posteriori on the log-odds scale
    // around the population's level, from each show's likelihood at every NOISES level.
    const nz = prior.noise || { mu: 0.45, k: 3 };
    stats.rangeNoise = nz.mu;
    const fn = fits.filter((f) => f.nl && f.nl.length === NOISES.length);
    if (fn.length) {
      const sum = NOISES.map((_, i) => fn.reduce((a, f) => a + f.nl[i], 0));
      const L = NOISES.map(logit), l0 = logit(nz.mu);
      let best = nz.mu, bestV = -Infinity;
      for (let j = 0; j <= 50; j++) {
        const x = L[0] + (j / 50) * (L[L.length - 1] - L[0]);
        let i = 0;
        while (i < L.length - 2 && x > L[i + 1]) i++;
        const w = (x - L[i]) / (L[i + 1] - L[i]);
        const v = sum[i] * (1 - w) + sum[i + 1] * w - nz.k * (x - l0) * (x - l0);
        if (v > bestV) { bestV = v; best = sigmoid(x); }
      }
      stats.rangeNoise = Math.round(best * 1000) / 1000;
    }
    // On bets and raises the noise hands are mostly weak or medium ones, so it scales with how
    // often their shown bets were bluffs compared with the guess from their aggression: an honest
    // bettor's bets stay value-heavy, a known bluffer's get wider.
    stats.rangeNoiseAgg = Math.round(clamp(stats.rangeNoise * clamp((1 - vr) / Math.max(0.05, 1 - vr0), 0.25, 2), 0.02, 0.85) * 1000) / 1000;
    stats.tiltAgg = fitTilt(true);
    stats.tiltPas = fitTilt(false);

    // Unblended read, for predicting what they do (predictAction) rather than for deciding.
    const fr = fam.fold.rate;
    stats.read = {
      foldToBet: stats.foldToBet,
      byStreet: { 3: stats.byStreet[3].foldToBet, 4: stats.byStreet[4].foldToBet, 5: stats.byStreet[5].foldToBet },
      foldBySize: Object.assign({}, stats.foldBySize),
      hu: { all: foldHU, 3: fr.flop, 4: fr.turn, 5: fr.river },
      mw: { all: foldMW, 3: fr.flopMW != null ? fr.flopMW : fr.flop, 4: fr.turnMW != null ? fr.turnMW : fr.turn, 5: fr.riverMW != null ? fr.riverMW : fr.river },
      multiway: mwCtx,
    };
    // A player who re-raised preflop this hand (ctx.reraised) folds less after the flop.
    stats.reraisedFold = prior.reraisedFold != null ? prior.reraisedFold : 1;
    if (ctx && ctx.reraised && stats.reraisedFold !== 1) {
      const sc = (f) => oddsScale(f, stats.reraisedFold);
      stats.foldToBet = sc(stats.foldToBet);
      for (const k of [3, 4, 5]) stats.byStreet[k].foldToBet = sc(stats.byStreet[k].foldToBet);
      for (const [key] of SIZE_BUCKETS) stats.foldBySize[key] = sc(stats.foldBySize[key]);
      stats.foldToCbet = sc(stats.foldToCbet);
      stats.foldAfterAgg = sc(stats.foldAfterAgg);
    }

    // Confidence-pinned exploitation (restricted Nash response): trust the read with
    // weight p and fill the rest with balanced play: fold f/(1+f) to a bet of f x pot
    // (minimum defense), and bet value:bluff in the (1+f):f ratio that makes calling break even.
    // p grows from 0.5 with no hands (the home game's average player, a better guess than
    // balanced play) to 0.9 at about 120, scaled by how well the read has predicted this player:
    // where their shown hands sat in the predicted ranges (a calibrated range has about half in
    // its likelier half) and how it did on every action against an average player's read.
    const certainty = 0.4 * fam.fold.certainty + 0.3 * fam.bet.certainty + 0.3 * fam.vpip.certainty;
    stats.certainty = certainty;
    const pd = t.pred && t.pred.n > 0 ? t.pred : null;
    stats.predAccuracy = pd ? { n: pd.n, gain: (pd.pop - pd.read) / pd.n } : null;
    const actTrust = pd ? clamp(1 + (3 * (pd.pop - pd.read)) / (pd.n + 30), 0.75, 1.05) : 1;
    const trust = clamp((((hits + 2) / (fits.length + 4)) / 0.5) * actTrust, 0.5, 1.1);
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

  // For tracker.predictor: [the read's probabilities, an average player's] for a decision.
  // style() and pool() give the current table style and pooled counts.
  function makePredictor(style, pool) {
    let cache = null;
    return (tally, d) => {
      const s = style ? style() : 'typical', pl = pool ? pool() : null;
      if (!cache || cache.s !== s || cache.n !== (pl && pl.pfFold)) cache = { s, n: pl && pl.pfFold, st: computeStats({}, s, pl) };
      return [predictAction(computeStats(tally, s, pl), d), predictAction(cache.st, d)];
    };
  }

  // The read's probability for each thing a player can do at a decision, from their stats.
  // d: { kind: 'pf' | 'vo' | 'open' | 'face', n: street (3, 4, 5), pos, cbet, toBB (vo), frac: bet faced as a
  // fraction of the pot before it, aggLine: they bet or raised earlier this hand }.
  // Used to score reads against what players really did (test/reads-bench.js, tracker.pred).
  function predictAction(stats, d) {
    if (d.kind === 'pf') {
      const g = d.pos && stats.byPos && stats.byPos[d.pos] ? stats.byPos[d.pos] : stats;
      return { fold: 1 - g.vpip, call: g.vpip - g.pfr, raise: g.pfr };
    }
    if (d.kind === 'vo') {
      // First response to an open raise to d.toBB big blinds, as the preflop solver reads it.
      const r = vsOpenRead(stats, d.toBB) || { cont: stats.vpip, threeBet: stats.threeBet };
      return { fold: 1 - r.cont, call: r.cont - r.threeBet, raise: r.threeBet };
    }
    const bs = stats.byStreet[d.n] || stats;
    if (d.kind === 'open') {
      const b = d.cbet ? stats.cbet : bs.betFreq;
      return { check: 1 - b, bet: b };
    }
    const rd = stats.read || { foldToBet: stats.foldToBet, byStreet: {}, foldBySize: stats.foldBySize };
    // Heads-up or multiway fold rates as the decision needs (the size corrections stay as read).
    const side = d.mw != null && rd.hu ? (d.mw ? rd.mw : rd.hu) : null;
    const s2 = Object.assign({}, stats, { foldToBet: side ? side.all : rd.foldToBet, foldBySize: rd.foldBySize, foldShift: 0, byStreet: {} });
    if (side) {
      // foldBySize was built around the context's overall rate: move it with the switch.
      const shift = side.all - rd.foldToBet;
      s2.foldBySize = {};
      for (const k of Object.keys(rd.foldBySize)) s2.foldBySize[k] = clamp(rd.foldBySize[k] + shift, 0.01, 0.99);
    }
    for (const k of [3, 4, 5]) s2.byStreet[k] = Object.assign({}, stats.byStreet[k], { foldToBet: side ? side[k] : rd.byStreet[k] != null ? rd.byStreet[k] : stats.byStreet[k].foldToBet });
    let fold = d.frac != null ? foldAtSize(s2, d.frac, d.n) : s2.byStreet[d.n].foldToBet;
    if (d.aggLine && stats.foldAfterAgg != null) fold *= clamp(stats.foldAfterAgg / Math.max(0.05, s2.foldToBet), 0.15, 1);
    if (d.reraised && stats.reraisedFold != null) fold = oddsScale(fold, stats.reraisedFold);
    const cont = 1 - fold;
    const ftbN = s2.byStreet[d.n].foldToBet;
    const raiseShare = clamp(bs.raiseFreq / Math.max(0.02, 1 - ftbN), 0.005, 0.9);
    return { fold, call: cont * (1 - raiseShare), raise: cont * raiseShare };
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
    const pa = stats.predAccuracy;
    if (pa && pa.n >= 20) parts.push('actions read ' + Math.round(Math.abs(pa.gain) * 100) + '% ' + (pa.gain >= 0 ? 'better' : 'worse') + ' than an average player');
    if (r.threeBet != null) parts.push('3-bet ' + p(r.threeBet));
    if (r.cbet != null) parts.push('c-bet ' + p(r.cbet));
    const fs = r.foldBySize;
    if (fs && (fs.smallN || fs.largeN)) parts.push('folds to small/big bets ' + (fs.smallN ? p(fs.small) : '–') + '/' + (fs.largeN ? p(fs.large) : '–'));
    if (stats.shown && stats.shown.bets) parts.push('bluffed ' + stats.shown.bluffs + ' of ' + stats.shown.bets + ' shown bets');
    if (r.wtsd != null) parts.push('to showdown ' + p(r.wtsd));
    return parts.join(' · ');
  }

  // Score a shown hand against the range the engine would have put that player on.
  // Returns { top, lr, sq, tl, nl, agg, v }: top = share of the range's weight on hands it rated
  // more likely than the real one (0 = our top guess), lr = the real hand's weight / the range's
  // average, sq = where the hand sat by strength inside the range. tl and nl are the shown hand's
  // log-likelihood with the range tilted by each TILTS step and with each NOISES level, so
  // computeStats can learn this player's tilt and noise from their showdowns.
  const FIT_VERSION = 2;
  const NOISES = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];
  function scoreShow(show, tally, tableStyle, pool) {
    const hole = show.cards.map(parseCard), board = show.board.map(parseCard);
    if (hole.length !== 2 || hole.some((x) => x < 0) || board.some((x) => x < 0) || board.length < 3) return null;
    if (foldedShow(show)) return null;
    const stats = computeStats(tally, tableStyle, pool);
    const strengths = { 0: boardStrength([]) };
    for (const n of [3, 4, 5]) if (board.length >= n) strengths[n] = boardStrength(board.slice(0, n));
    const args = [show.actions || {}, strengths, board, show.sizes, show.pfAggressor, show.position];
    const W0 = buildRange(stats, ...args, true);
    const W = buildRange(stats, ...args);
    const k = COMBO_INDEX[hole[0] * 52 + hole[1]];
    // Where the real hand ranked by strength (on the final board) inside our range.
    const sq = rangeQuantiles(W, strengths[board.length].hs)[k];
    const lastN = [5, 4, 3].find((n) => strengths[n] && (show.actions || {})[STREET_KEYS[n]]) || board.length;
    const qT = rangeQuantiles(W0, strengths[lastN].ehs);
    const ll = (w) => {
      let tot = 0, n = 0;
      for (let j = 0; j < NUM_COMBOS; j++) if (w(j) > 0) { tot += w(j); n++; }
      return n && tot > 0 ? Math.round(Math.log(Math.max(1e-4, (w(k) * n) / tot)) * 1000) / 1000 : 0;
    };
    const tl = TILTS.map((tau) => ll((j) => (W0[j] > 0 ? W0[j] * Math.exp(8 * tau * (qT[j] - 0.5)) : 0)));
    const nl = NOISES.map((eps) => {
      const Wn = buildRange(Object.assign({}, stats, { rangeNoise: eps }), ...args, true);
      return ll((j) => Wn[j]);
    });
    const agg = ['flop', 'turn', 'river'].some((nm) => { const a = STREET_ACTION_MAP[(show.actions || {})[nm]]; return a === 'bet' || a === 'raise'; });
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
      tl, nl, agg, v: FIT_VERSION,
    };
  }

  // Percentile of each valid combo's score among all valid combos (ties share the middle).
  // Scores are below 2^24, so a 3-pass radix sort orders them (much faster than sorting floats).
  const RX_A = new Int32Array(NUM_COMBOS), RX_B = new Int32Array(NUM_COMBOS), RX_CNT = new Int32Array(256);
  function percentiles(scores, valid, count, out) {
    let src = RX_A, dst = RX_B;
    for (let i = 0; i < count; i++) src[i] = valid[i];
    for (let shift = 0; shift < 24; shift += 8) {
      RX_CNT.fill(0);
      for (let i = 0; i < count; i++) RX_CNT[(scores[src[i]] >> shift) & 255]++;
      let sum = 0;
      for (let b = 0; b < 256; b++) { const c = RX_CNT[b]; RX_CNT[b] = sum; sum += c; }
      for (let i = 0; i < count; i++) { const k = src[i]; dst[RX_CNT[(scores[k] >> shift) & 255]++] = k; }
      const t = src; src = dst; dst = t;
    }
    let i = 0;
    const denom = Math.max(1, count - 1);
    while (i < count) {
      const s = scores[src[i]];
      let j = i;
      while (j < count && scores[src[j]] === s) j++;
      const p = (i + (j - i - 1) / 2) / denom;
      for (let x = i; x < j; x++) out[src[x]] = p;
      i = j;
    }
  }

  // On a river board that is a straight or better by itself, the hands that only play the board
  // (they tie it) get flag 1. Those hands do not fold to a bet: calling wins back their share
  // of the pot, and a bluff into them can only lose. null when the board is weaker or no hand ties.
  function boardPlayers(board) {
    if (board.length !== 5) return null;
    const b = new Int32Array(7);
    for (let i = 0; i < 5; i++) b[i] = board[i];
    const own = evaluate(b, 5);
    if ((own >> 20) < 4) return null;
    const onBoard = new Uint8Array(52);
    for (const c of board) onBoard[c] = 1;
    const out = new Uint8Array(NUM_COMBOS);
    let any = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      const x = COMBO_HI[k], y = COMBO_LO[k];
      if (onBoard[x] || onBoard[y]) continue;
      b[5] = x; b[6] = y;
      if (evaluate(b, 7) === own) { out[k] = 1; any++; }
    }
    return any ? out : null;
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
    setBoard(buf, n);
    for (let k = 0; k < NUM_COMBOS; k++) {
      const a = COMBO_HI[k], b = COMBO_LO[k];
      if (dead[a] || dead[b]) continue;
      scores[k] = scoreHole(a, b);
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
        setBoard(buf, n + 1);
        let c2 = 0;
        for (let i = 0; i < count; i++) {
          const k = valid[i];
          const a = COMBO_HI[k], b = COMBO_LO[k];
          if (a === x || b === x) continue;
          scores[k] = scoreHole(a, b);
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

  const WAR_MIX = 1;
  function preflopRange(stats, action, sizePre) {
    const cw = new Float64Array(169);
    let raiseWidth = 1; // re-raising range width, for the floor below
    if (action === 'raise') {
      cw.set(topClassWeights(stats.pfr));
    } else if (action === '3bet' || action === '4bet' || action === '5bet') {
      // Each further re-raise keeps the share of the previous raising range that re-raises again
      // (`fourBet`). A min-reraise (raising by no more than the raise before, `sizePre` <= 1.25)
      // narrows half as much, once: these friends click min-raise back and forth with K4s and Q9o.
      let w = clamp(stats.threeBet != null ? stats.threeBet : stats.pfr * 0.4, 0.025, 0.25);
      // `fourBet` (share of raises that re-raise again when re-raised) comes from computeStats; 0.45 until then.
      const fb = stats.fourBet != null ? stats.fourBet : 0.45;
      const cheap = sizePre != null && sizePre <= 1.25;
      if (action === '4bet' || (action === '5bet' && cheap)) w = Math.max(0.02, w * (cheap ? Math.sqrt(fb) : fb));
      else if (action === '5bet') w = Math.max(0.015, w * fb * fb);
      cw.set(topClassWeights(w));
      raiseWidth = w;
      // Raise wars (4-bets and 5-bets) are half premiums, half ordinary hands: of 9 hands shown
      // from them in the logs, 4 were AA-JJ and 5 were K4s, Q9o, KTo, QJo and A8o. So the
      // narrow range gets the same mass again spread over the hands they play.
      if (action === '4bet' || action === '5bet') {
        const v = Math.max(0.05, stats.vpip), ord = topClassWeights(v);
        for (let i = 0; i < 169; i++) cw[i] = Math.min(1, cw[i] + WAR_MIX * (w / v) * ord[i]);
      }
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
    // Nobody's range is airtight: keep a little weight on every hand they could have played.
    // For narrow re-raising ranges the floor shrinks with the range, or junk would be a third
    // of a top-1.5% 5-bet range (KQs was told to shove into a 5-bet and a 6-bet).
    const floor = action === 'call' ? 0.02 : /raise|bet/.test(action) ? Math.min(0.008, 0.06 * raiseWidth) : 0;
    if (floor) for (let i = 0; i < 169; i++) cw[i] = Math.max(cw[i], floor);
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

  // Scales the odds of a probability: p / (1 - p) times m.
  function oddsScale(p, m) {
    const q = clamp(p, 1e-4, 1 - 1e-4);
    return (q * m) / (q * m + 1 - q);
  }

  function logit(p) {
    return Math.log(p / (1 - p));
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
  // Stats for the field as one opponent (multiway solvers): it folds only if all of them fold,
  // and bets or raises if any of them does. The rest follows `base` (the aggressor or the
  // stickiest caller).
  function fieldStats(list, base) {
    const prod = (f) => list.reduce((a, x) => a * clamp(f(x), 0, 1), 1);
    const st = Object.assign({}, base, { foldShift: 0, fieldOf: list });
    st.foldToBet = prod((x) => x.foldToBet);
    st.foldAfterAgg = prod((x) => (x.foldAfterAgg != null ? x.foldAfterAgg : x.foldToBet));
    st.betFreq = 1 - prod((x) => 1 - x.betFreq);
    st.raiseFreq = 1 - prod((x) => 1 - x.raiseFreq);
    st.byStreet = {};
    for (const n of [3, 4, 5]) {
      const ss = list.map((x) => streetStats(x, n));
      st.byStreet[n] = Object.assign({}, (base.byStreet && base.byStreet[n]) || {}, {
        foldToBet: ss.reduce((a, x) => a * clamp(x.foldToBet, 0, 1), 1),
        betFreq: 1 - ss.reduce((a, x) => a * (1 - clamp(x.betFreq, 0, 1)), 1),
        raiseFreq: 1 - ss.reduce((a, x) => a * (1 - clamp(x.raiseFreq, 0, 1)), 1),
      });
    }
    return st;
  }

  function streetStats(stats, n) {
    const b = stats.byStreet && stats.byStreet[n];
    return b ? Object.assign({}, stats, b) : stats;
  }

  // Fold probability against a bet of `f` x pot on street `n`: the size model for that
  // street, corrected by how they actually reacted to small, medium and large bets.
  function foldAtSize(stats, f, n) {
    // The field (several players as one): it folds only if every one of them folds.
    if (stats.fieldOf) return clamp(stats.fieldOf.reduce((a, x) => a * foldAtSize(Object.assign({}, x, { foldShift: 0 }), f, n), 1), 0.01, 0.98);
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
    // that includes more medium hands. Tiny bets and min-raises (under about a third of the pot)
    // are wider still: at the owner's table they came with K4s, K8o, Q9o and draws, not the nuts.
    const sizeScale = !(size > 0) ? 1 : size >= 1 ? 0.8 : size >= BIG_BET ? 0.9 : size < 0.45 ? Math.min(1.9, 1.2 + 2 * (0.45 - size)) : 1;
    let P;
    if (action === 'bet') {
      P = aggressionProbs(W, st, clamp(stats.betFreq * sizeScale, 0.03, 0.95), vr);
      // Home players also bet medium hands (second pair, weak top pair) "to see where they are".
      // Without this slice, a friend's TT betting the flop and turn on J-J-Q was ruled out of the range.
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(0.03, P[k], st.hs[k] >= 0.35 ? MEDIUM_BET * stats.betFreq * sizeScale : 0);
    } else if (action === 'check') {
      P = aggressionProbs(W, st, stats.betFreq, vr);
      const slow = clamp(0.5 - 0.1 * stats.af, 0.1, 0.45);
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(slow, 1 - P[k]);
    } else if (action === 'raise') {
      // Only flop min-raises get the extra width (K8o and a flush draw at the owner's table). Turn and
      // river raises stay value-heavy even when small: a turn min-raise there was a flush, a 23%
      // river raise was AA.
      const rScale = st.street === 3 ? sizeScale : Math.min(sizeScale, 1.2);
      P = aggressionProbs(W, st, clamp(stats.raiseFreq * 1.2 * rScale, 0.04, 0.5), clamp(vr + 0.05, 0.6, 0.92));
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(0.02, P[k]);
    } else if (action === 'call') {
      // Calls are ranked with draws counted at twice their one-card gain: home players chase.
      // Ranked by plain strength, open-enders and flush draws were folded out of turn calling
      // ranges, and those were exactly the hands friends showed after calling.
      const callScore = new Float64Array(NUM_COMBOS);
      for (let k = 0; k < NUM_COMBOS; k++) callScore[k] = st.hs[k] < 0 ? -1 : Math.min(1, st.hs[k] + DRAW_CALL * st.pot[k]);
      const q = rangeQuantiles(W, callScore);
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
    // Players are noisy: with chance `rangeNoise` a hand takes this line whatever its strength,
    // at the line's average rate, so unusual (but real) lines don't wipe out the hands behind them.
    // Fitted on the owner's showdowns (computeStats): the friends' lines are about half noise.
    // Big bets are seldom made at random: on bets and raises the noise shrinks as the size grows.
    const aggr = action === 'bet' || action === 'raise';
    const noise = aggr && stats.rangeNoiseAgg != null ? stats.rangeNoiseAgg : stats.rangeNoise;
    const eps = noise > 0 ? Math.min(0.9, noise * (aggr && size > 0 ? clamp(0.6 / size, 0.4, 1.3) : 1)) : 0;
    if (eps > 0) {
      let sw = 0, sp = 0;
      for (let k = 0; k < NUM_COMBOS; k++) if (W[k] > 0) { sw += W[k]; sp += W[k] * P[k]; }
      const avg = sw > 0 ? sp / sw : 0;
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = (1 - eps) * P[k] + eps * avg;
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

  const TILTS = [-0.75, -0.5, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.75];
  const DRAW_CALL = 2;
  const MEDIUM_BET = 0.3;
  // Preflop lines where the player raised: 'raise', '3bet', '4bet', '5bet'.
  const PRE_RAISED = /^(raise|\dbet)$/;
  const STREET_ACTION_MAP = {
    check: 'check', bet: 'bet', call: 'call', raise: 'raise',
    checkcall: 'call', checkraise: 'raise', betcall: 'bet',
  };

  function sumWeights(W) {
    let s = 0;
    for (let k = 0; k < NUM_COMBOS; k++) s += W[k];
    return s;
  }

  function buildRange(stats, actions, strengths, deadCards, sizes, pfAggressor, position, noTilt) {
    const pre = position && stats.byPos && stats.byPos[position] ? Object.assign({}, stats, stats.byPos[position]) : stats;
    let W = preflopRange(pre, actions.pre || 'pending', sizes && sizes.pre);
    const dead = new Uint8Array(52);
    deadCards.forEach((c) => { dead[c] = 1; });
    for (let k = 0; k < NUM_COMBOS; k++) if (dead[COMBO_HI[k]] || dead[COMBO_LO[k]]) W[k] = 0;

    const streets = [['flop', 3], ['turn', 4], ['river', 5]];
    for (const [name, len] of streets) {
      const st = strengths[len];
      const act = STREET_ACTION_MAP[actions[name]];
      if (!st || !act) continue;
      const cbet = name === 'flop' && (pfAggressor || (pfAggressor == null && PRE_RAISED.test(actions.pre || '')));
      const next = applyAction(W, st, act, stats, sizes && sizes[name], { cbet });
      if (sumWeights(next) > 1e-9) W = next;
      W.bluffShare = act === 'bet' || act === 'raise' ? next.bluffShare : null;
      // Bet, then called a raise: keep the part of the betting range that continues.
      if (actions[name] === 'betcall') {
        const after = applyAction(W, st, 'call', stats, null, {});
        if (sumWeights(after) > 1e-9) W = after;
        W.bluffShare = null;
      }
    }
    if (sumWeights(W) <= 1e-9) {
      for (let k = 0; k < NUM_COMBOS; k++) W[k] = dead[COMBO_HI[k]] || dead[COMBO_LO[k]] ? 0 : 1;
    }
    // Learned correction: if this player's shown hands keep landing below (or above) the
    // middle of the range we predicted, tilt the range weaker (or stronger) to match.
    const aggLine = ['flop', 'turn', 'river'].some((n) => { const a = STREET_ACTION_MAP[actions[n]]; return a === 'bet' || a === 'raise'; });
    const learned = aggLine ? stats.tiltAgg : stats.tiltPas;
    // Without a learned tilt for betting lines, only a weaker-than-expected average is used:
    // showdowns after bets are the ones that got called, so they look stronger than the bets were.
    const bias = learned != null ? learned : aggLine ? Math.min(0, stats.strengthBias || 0) : stats.strengthBias || 0;
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

  // A player's learned response to an open raise to `toBB` big blinds (stats.vsOpen, when the
  // reads have it: { small, medium, large } by raise-to size, each { cont, threeBet }), with
  // big raises still called at least at callBig. Null when there is no such read.
  function vsOpenRead(stats, toBB) {
    const vo = stats && stats.vsOpen;
    if (!vo || !(toBB > 0)) return null;
    const b = toBB <= 2.5 ? vo.small : toBB <= 3.5 ? vo.medium : vo.large;
    if (!b || b.cont == null) return null;
    const big = clamp((toBB - 4) / 4, 0, 1), callBig = stats.callBig != null ? stats.callBig : 0.25;
    const cont = clamp(Math.max(b.cont, big * callBig), 0.02, 0.98);
    return { cont, threeBet: clamp(b.threeBet != null ? b.threeBet : 0.05, 0.005, cont) };
  }

  function continueRule(opp, ctx, mdf, kind) {
    const s = opp.stats;
    if (ctx.street === 0) {
      // Big raises and shoves (8+ big blinds) get called at least at the player's callBig rate.
      const big = clamp((kind.amount / Math.max(1e-9, ctx.bigBlind) - 4) / 4, 0, 1);
      const callBig = s.callBig != null ? s.callBig : 0.25;
      if (opp.pending) {
        const learned = kind.openTo ? vsOpenRead(s, kind.openTo / Math.max(1e-9, ctx.bigBlind)) : null;
        if (learned) return { cont: learned.cont, nut: 0.965, reraise: learned.threeBet };
        const sizeFactor = Math.min(1, (6 * ctx.bigBlind) / Math.max(ctx.bigBlind, kind.amount));
        let cont = s.vpip * 0.7 * (mdf / 0.375) * Math.sqrt(sizeFactor);
        cont = Math.max(Math.min(s.vpip, cont), big * callBig);
        return { cont: clamp(cont, 0.01, 0.95), nut: 0.965, reraise: clamp(s.pfr * 0.4, 0.02, 0.12) };
      }
      const raised = PRE_RAISED.test(opp.actions.pre || '');
      const base = raised ? 0.55 : 0.5;
      // Shares of the range they already continued with: limpers and raisers are part-committed.
      const floor = big * (raised ? clamp(2 * callBig, 0.35, 0.75) : clamp(1.5 * callBig, 0.25, 0.6));
      return { cont: clamp(Math.max(base * (mdf / 0.5), floor), 0.03, 0.97), nut: 0.965, reraise: 0.2 * base };
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
      setBoard(buf, 5);
      let count = 0;
      for (let k = 0; k < NUM_COMBOS; k++) {
        const a = COMBO_HI[k], c = COMBO_LO[k];
        if (dead[a] || dead[c]) continue;
        scores[k] = scoreHole(a, c);
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
    const N = ctx.samples || PLAN_SAMPLES;
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
      const aggScale = ctx.aggro ? clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1) : 1;
      for (let g = 0; g <= 60; g++) grid[g] = q(aggScale * foldAtSize(o.stats, g * 0.05, s));
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
        foldHero: aggScale * foldAtSize(o.stats, HERO_BET, s),
        callCut,
        // Hero value-bets when it beats 55% of the hands that would call.
        valueCut: c0 < N ? x[c0 + Math.floor(0.55 * (N - 1 - c0))] : 2,
        eqVsCall: (h) => (c0 < N ? Math.max(0, lowerBound(x, h) - c0) / (N - c0) : 1),
        eqVsBet: (h) => (cum[N] > 0 ? cum[lowerBound(x, h)] / cum[N] : 1),
        eqAll: (h) => lowerBound(x, h) / N,
      };
    }
    return plan;
  }

  // ---------- WebAssembly SIMD kernels ----------
  /*
   * The solvers' inner loops (regret matching, regret updates, showdown sweeps, the preflop
   * leaves' matrix-vector products) also exist as WebAssembly functions using 128-bit SIMD,
   * which runs them 2-4x faster than the JIT. They do the same IEEE double operations in the
   * same order as the JS loops (no fused multiply-add, each sum accumulated in the same
   * sequence), so results are bit-for-bit the same either way. If WebAssembly SIMD is
   * missing or blocked (a page's Content-Security-Policy can do that), the JS loops run.
   *
   * The module is assembled here from a small S-expression form, so there is no build step
   * and no binary blob. Kernel arguments are byte offsets into one shared memory; solvers
   * reserve what they need with arenaBegin() and then take views with arenaF64() etc.
   */
  const WASM_OPS = {
    block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d,
    'local.get': 0x20, 'local.set': 0x21, 'local.tee': 0x22,
    'i32.load': 0x28, 'f32.load': 0x2a, 'f64.load': 0x2b, 'i32.load8_u': 0x2d,
    'i32.store': 0x36, 'f32.store': 0x38, 'f64.store': 0x39,
    'i32.const': 0x41, 'f64.const': 0x44,
    'i32.eqz': 0x45, 'i32.eq': 0x46, 'i32.ne': 0x47, 'i32.lt_s': 0x48, 'i32.gt_s': 0x4a, 'i32.le_s': 0x4c, 'i32.ge_s': 0x4e,
    'f64.ne': 0x62, 'f64.gt': 0x64,
    'i32.add': 0x6a, 'i32.sub': 0x6b, 'i32.mul': 0x6c, 'i32.shl': 0x74,
    'f64.add': 0xa0, 'f64.sub': 0xa1, 'f64.mul': 0xa2, 'f64.div': 0xa3,
    'f32.demote_f64': 0xb6, 'f64.promote_f32': 0xbb,
  };
  const WASM_SIMD = {
    'v128.load': 0x00, 'v128.store': 0x0b, 'f64x2.splat': 0x14, 'f64x2.gt': 0x4a, 'v128.bitselect': 0x52,
    'v128.store64_lane': 0x5b, 'v128.load64_zero': 0x5d, 'f32x4.demote_f64x2_zero': 0x5e, 'f64x2.promote_low_f32x4': 0x5f,
    'f64x2.add': 0xf0, 'f64x2.sub': 0xf1, 'f64x2.mul': 0xf2, 'f64x2.div': 0xf3, 'f64x2.pmax': 0xf7,
  };
  const WASM_ALIGN = { 'i32.load': 2, 'f32.load': 2, 'f64.load': 3, 'i32.load8_u': 0, 'i32.store': 2, 'f32.store': 2, 'f64.store': 3,
    'v128.load': 3, 'v128.store': 3, 'v128.load64_zero': 2, 'v128.store64_lane': 2 };
  const WASM_TYPES = { i32: 0x7f, f64: 0x7c, v128: 0x7b };
  function uleb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function sleb(n) { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
  // Expression form: a string is a local, [op, ...operands] an instruction after its operands;
  // ['i32', n] / ['f64', x] constants; ['set', name, e]; ['for', v, from, to, step, ...body]
  // (v < to, signed); ['if', cond, [then...], [else...]]; ['while', cond, ...body].
  function wasmFunc(f) {
    const names = {}, code = [];
    f.params.forEach(([n], i) => { names[n] = i; });
    const locals = f.locals || [];
    locals.forEach(([n], i) => { names[n] = f.params.length + i; });
    const local = (n) => { if (!(n in names)) throw new Error('kernel local ' + n); return uleb(names[n]); };
    const op = (o) => { if (o in WASM_SIMD) code.push(0xfd, ...uleb(WASM_SIMD[o])); else if (o in WASM_OPS) code.push(WASM_OPS[o]); else throw new Error('kernel op ' + o); if (o in WASM_ALIGN) code.push(WASM_ALIGN[o], 0); };
    const emit = (e) => {
      if (typeof e === 'string') { code.push(0x20, ...local(e)); return; }
      const [o, ...a] = e;
      if (o === 'i32') { code.push(0x41, ...sleb(a[0])); return; }
      if (o === 'f64') { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, a[0], true); code.push(0x44, ...b); return; }
      if (o === 'set') { emit(a[1]); code.push(0x21, ...local(a[0])); return; }
      if (o === 'seq') { a.forEach(emit); return; }
      if (o === 'if') { emit(a[0]); code.push(0x04, 0x40); a[1].forEach(emit); if (a[2]) { code.push(0x05); a[2].forEach(emit); } code.push(0x0b); return; }
      if (o === 'while') { code.push(0x02, 0x40, 0x03, 0x40); emit(a[0]); code.push(0x45, 0x0d, 1); a.slice(1).forEach(emit); code.push(0x0c, 0, 0x0b, 0x0b); return; }
      if (o === 'for') {
        const [v, from, to, step, ...body] = a;
        emit(['set', v, from]);
        code.push(0x02, 0x40, 0x03, 0x40);
        emit(['i32.ge_s', v, to]); code.push(0x0d, 1);
        body.forEach(emit);
        emit(['set', v, ['i32.add', v, ['i32', step]]]);
        code.push(0x0c, 0, 0x0b, 0x0b);
        return;
      }
      if (o === 'v128.store64_lane') { emit(a[0]); emit(a[1]); op(o); code.push(0); return; }
      a.forEach(emit);
      op(o);
    };
    f.body.forEach(emit);
    code.push(0x0b);
    const decl = [...uleb(locals.length), ...locals.flatMap(([, t]) => [1, WASM_TYPES[t]])];
    return [...uleb(decl.length + code.length), ...decl, ...code];
  }
  function wasmModule(funcs) {
    const vec = (xs) => [...uleb(xs.length), ...xs.flat()];
    const str = (s) => [...uleb(s.length), ...Array.from(s, (ch) => ch.charCodeAt(0))];
    const sec = (id, b) => [id, ...uleb(b.length), ...b];
    return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...sec(1, vec(funcs.map((f) => [0x60, ...vec(f.params.map(([, t]) => [WASM_TYPES[t]])), ...vec((f.results || []).map((t) => [WASM_TYPES[t]]))]))),
      ...sec(2, vec([[...str('e'), ...str('m'), 0x02, 0x00, 0x01]])),
      ...sec(3, vec(funcs.map((f, i) => uleb(i)))),
      ...sec(7, vec(funcs.map((f, i) => [...str(f.name), 0x00, ...uleb(i)]))),
      ...sec(10, vec(funcs.map(wasmFunc))),
    ]);
  }

  // Shorthands for the kernels below.
  const I = (n) => ['i32', n];
  const at = (base, i, shift) => ['i32.add', base, ['i32.shl', i, I(shift)]];
  const ld2 = (p) => ['v128.load', p], st2 = (p, v) => ['v128.store', p, v];
  const ldf = (p) => ['f64.load', p], stf = (p, v) => ['f64.store', p, v];
  const ldi = (p) => ['i32.load', p], ldu8 = (p) => ['i32.load8_u', p];
  const add = (a, b) => ['f64.add', a, b], sub = (a, b) => ['f64.sub', a, b], mul = (a, b) => ['f64.mul', a, b];
  const vadd = (a, b) => ['f64x2.add', a, b], vsub = (a, b) => ['f64x2.sub', a, b], vmul = (a, b) => ['f64x2.mul', a, b];
  const ldf32x2 = (p) => ['f64x2.promote_low_f32x4', ['v128.load64_zero', p]];
  const P = (names) => names.split(' ').map((n) => [n, 'i32']);
  // T = sum of r, all[c] = sum of r over hands holding card c (each in index order). Hands come
  // grouped by their high card, so the running sum for the current high card stays in a register
  // (same additions in the same order, without waiting on memory every hand).
  const ALL_SUMS = [
    ['set', 'cur', I(-1)], ['set', 'acc', ['f64', 0]],
    ['for', 'i', I(0), 'N', 1,
      ['set', 'x', ldf(at('r', 'i', 3))], ['set', 'T', add('T', 'x')],
      ['set', 'h', ldu8(['i32.add', 'hi', 'i'])],
      ['if', ['i32.ne', 'h', 'cur'], [
        ['if', ['i32.ge_s', 'cur', I(0)], [stf(at('all', 'cur', 3), 'acc')]],
        ['set', 'cur', 'h'], ['set', 'acc', ldf(at('all', 'h', 3))]]],
      ['set', 'acc', add('acc', 'x')],
      ['set', 'l', at('all', ldu8(['i32.add', 'lo', 'i']), 3)], stf('l', add(ldf('l'), 'x'))],
    ['if', ['i32.ge_s', 'cur', I(0)], [stf(at('all', 'cur', 3), 'acc')]],
  ];
  const KERNELS = [
    // Regret matching over nA rows of Np doubles (Np even): x = t > 0 ? max(r, 0) / t : u
    // with t the sum of positive regrets; then x = pf + q * x when pf is not 0.
    { name: 'strategyDiv', params: [...P('reg out nA Np pf'), ['q', 'f64'], ['u', 'f64']],
      locals: [...P('i a p row'), ['t', 'v128'], ['x', 'v128'], ['m', 'v128'], ['z', 'v128'], ['uv', 'v128'], ['qv', 'v128']],
      body: [
        ['set', 'z', ['f64x2.splat', ['f64', 0]]], ['set', 'uv', ['f64x2.splat', 'u']], ['set', 'qv', ['f64x2.splat', 'q']],
        ['set', 'row', ['i32.shl', 'Np', I(3)]],
        ['for', 'i', I(0), 'Np', 2,
          ['set', 't', 'z'], ['set', 'p', ['i32.shl', 'i', I(3)]],
          ['for', 'a', I(0), 'nA', 1,
            ['set', 't', vadd('t', ['f64x2.pmax', 'z', ld2(['i32.add', 'reg', 'p'])])],
            ['set', 'p', ['i32.add', 'p', 'row']]],
          ['set', 'm', ['f64x2.gt', 't', 'z']], ['set', 'p', ['i32.shl', 'i', I(3)]],
          ['for', 'a', I(0), 'nA', 1,
            ['set', 'x', ['v128.bitselect', ['f64x2.div', ['f64x2.pmax', 'z', ld2(['i32.add', 'reg', 'p'])], 't'], 'uv', 'm']],
            ['if', 'pf', [['set', 'x', vadd(ld2(['i32.add', 'pf', 'p']), vmul('qv', 'x'))]]],
            st2(['i32.add', 'out', 'p'], 'x'),
            ['set', 'p', ['i32.add', 'p', 'row']]]]] },
    // dst = a * b, n doubles (n even)
    { name: 'mul', params: P('dst a b n'), locals: P('i p'),
      body: [['for', 'i', I(0), 'n', 2, ['set', 'p', ['i32.shl', 'i', I(3)]],
        st2(['i32.add', 'dst', 'p'], vmul(ld2(['i32.add', 'a', 'p']), ld2(['i32.add', 'b', 'p'])))]] },
    // v += s * x
    { name: 'addMul', params: P('v s x n'), locals: P('i p'),
      body: [['for', 'i', I(0), 'n', 2, ['set', 'p', ['i32.shl', 'i', I(3)]],
        st2(['i32.add', 'v', 'p'], vadd(ld2(['i32.add', 'v', 'p']), vmul(ld2(['i32.add', 's', 'p']), ld2(['i32.add', 'x', 'p']))))]] },
    // v += x
    { name: 'addTo', params: P('v x n'), locals: P('i p'),
      body: [['for', 'i', I(0), 'n', 2, ['set', 'p', ['i32.shl', 'i', I(3)]],
        st2(['i32.add', 'v', 'p'], vadd(ld2(['i32.add', 'v', 'p']), ld2(['i32.add', 'x', 'p'])))]] },
    // River regret update for one action: reg = max(reg, 0) * pos + va - v; sum = sum * w + reach * s
    { name: 'regretRiver', params: [...P('reg sum va v reach s n'), ['pos', 'f64'], ['w', 'f64']],
      locals: [...P('i p'), ['z', 'v128'], ['pv', 'v128'], ['wv', 'v128']],
      body: [
        ['set', 'z', ['f64x2.splat', ['f64', 0]]], ['set', 'pv', ['f64x2.splat', 'pos']], ['set', 'wv', ['f64x2.splat', 'w']],
        ['for', 'i', I(0), 'n', 2, ['set', 'p', ['i32.shl', 'i', I(3)]],
          st2(['i32.add', 'reg', 'p'], vsub(vadd(vmul(['f64x2.pmax', 'z', ld2(['i32.add', 'reg', 'p'])], 'pv'), ld2(['i32.add', 'va', 'p'])), ld2(['i32.add', 'v', 'p']))),
          st2(['i32.add', 'sum', 'p'], vadd(vmul(ld2(['i32.add', 'sum', 'p']), 'wv'), vmul(ld2(['i32.add', 'reach', 'p']), ld2(['i32.add', 's', 'p']))))]] },
    // River showdown values (riverSolve's showValues): v[i] = potF * (below + tie / 2) - inv * total.
    { name: 'showRiver', params: [...P('r v N'), ['potF', 'f64'], ['inv', 'f64'], ...P('hi lo order oHi oLo gEnd rs cum all grp')],
      locals: [...P('i j g e h l k cur'), ['T', 'f64'], ['cT', 'f64'], ['gT', 'f64'], ['x', 'f64'], ['acc', 'f64']],
      body: [
        ['for', 'k', I(0), I(52), 1, stf(at('cum', 'k', 3), ['f64', 0]), stf(at('all', 'k', 3), ['f64', 0])],
        ['set', 'T', ['f64', 0]], ['set', 'cT', ['f64', 0]],
        ...ALL_SUMS,
        ['for', 'j', I(0), 'N', 1, stf(at('rs', 'j', 3), ldf(at('r', ldi(at('order', 'j', 2)), 3)))],
        ['set', 'g', I(0)],
        ['while', ['i32.lt_s', 'g', 'N'],
          ['set', 'e', ldi(at('gEnd', 'g', 2))],
          ['if', ['i32.eq', 'e', ['i32.add', 'g', I(1)]], [
            ['set', 'i', ldi(at('order', 'g', 2))], ['set', 'x', ldf(at('rs', 'g', 3))],
            ['set', 'h', ldu8(['i32.add', 'oHi', 'g'])], ['set', 'l', ldu8(['i32.add', 'oLo', 'g'])],
            stf(at('v', 'i', 3), sub(
              mul('potF', add(sub(sub('cT', ldf(at('cum', 'h', 3))), ldf(at('cum', 'l', 3))), ['f64', 0])),
              mul('inv', add(sub(sub('T', ldf(at('all', 'h', 3))), ldf(at('all', 'l', 3))), 'x')))),
            ['set', 'cT', add('cT', 'x')],
            stf(at('cum', 'h', 3), add(ldf(at('cum', 'h', 3)), 'x')), stf(at('cum', 'l', 3), add(ldf(at('cum', 'l', 3)), 'x')),
          ], [
            ['set', 'gT', ['f64', 0]],
            ['for', 'j', 'g', 'e', 1,
              ['set', 'x', ldf(at('rs', 'j', 3))], ['set', 'gT', add('gT', 'x')],
              ['set', 'h', at('grp', ldu8(['i32.add', 'oHi', 'j']), 3)], stf('h', add(ldf('h'), 'x')),
              ['set', 'l', at('grp', ldu8(['i32.add', 'oLo', 'j']), 3)], stf('l', add(ldf('l'), 'x'))],
            ['for', 'j', 'g', 'e', 1,
              ['set', 'i', ldi(at('order', 'j', 2))], ['set', 'x', ldf(at('rs', 'j', 3))],
              ['set', 'h', ldu8(['i32.add', 'oHi', 'j'])], ['set', 'l', ldu8(['i32.add', 'oLo', 'j'])],
              stf(at('v', 'i', 3), sub(
                mul('potF', add(sub(sub('cT', ldf(at('cum', 'h', 3))), ldf(at('cum', 'l', 3))),
                  ['f64.div', add(sub(sub('gT', ldf(at('grp', 'h', 3))), ldf(at('grp', 'l', 3))), 'x'), ['f64', 2]])),
                mul('inv', add(sub(sub('T', ldf(at('all', 'h', 3))), ldf(at('all', 'l', 3))), 'x'))))],
            ['for', 'j', 'g', 'e', 1,
              ['set', 'x', ldf(at('rs', 'j', 3))],
              ['set', 'h', ldu8(['i32.add', 'oHi', 'j'])], ['set', 'l', ldu8(['i32.add', 'oLo', 'j'])],
              ['set', 'cT', add('cT', 'x')],
              stf(at('cum', 'h', 3), add(ldf(at('cum', 'h', 3)), 'x')), stf(at('cum', 'l', 3), add(ldf(at('cum', 'l', 3)), 'x')),
              stf(at('grp', 'h', 3), ['f64', 0]), stf(at('grp', 'l', 3), ['f64', 0])],
          ]],
          ['set', 'g', 'e']]] },
    // River fold values: v[i] = g * (T - all[hi] - all[lo] + r[i]).
    { name: 'foldRiver', params: [...P('r v N'), ['g', 'f64'], ...P('hi lo all')],
      locals: [...P('i k h l cur'), ['T', 'f64'], ['x', 'f64'], ['acc', 'f64']],
      body: [
        ['for', 'k', I(0), I(52), 1, stf(at('all', 'k', 3), ['f64', 0])],
        ['set', 'T', ['f64', 0]],
        ...ALL_SUMS,
        ['for', 'i', I(0), 'N', 1,
          stf(at('v', 'i', 3), mul('g', add(sub(sub('T', ldf(at('all', ldu8(['i32.add', 'hi', 'i']), 3))), ldf(at('all', ldu8(['i32.add', 'lo', 'i']), 3))), ldf(at('r', 'i', 3)))))]] },
    // Preflop classMass: out[a] = g * cnt[a] * (T - P[r1[a]] - P[r2[a]] + r[a]) with T the
    // combo-weighted total of r and P[rank] the weight of classes holding that rank.
    { name: 'pfMass', params: [...P('r out'), ['g', 'f64'], ...P('cnt per r1 r2 PP')],
      locals: [...P('b k x1 x2'), ['T', 'f64'], ['w', 'f64'], ['m', 'f64']],
      body: [
        ['for', 'k', I(0), I(13), 1, stf(at('PP', 'k', 3), ['f64', 0])],
        ['set', 'T', ['f64', 0]],
        ['for', 'b', I(0), I(169), 1,
          ['set', 'w', ldf(at('r', 'b', 3))],
          ['if', ['f64.ne', 'w', ['f64', 0]], [
            ['set', 'T', add('T', mul(ldf(at('cnt', 'b', 3)), 'w'))],
            ['set', 'm', mul(ldf(at('per', 'b', 3)), 'w')],
            ['set', 'x1', at('PP', ldi(at('r1', 'b', 2)), 3)], ['set', 'x2', at('PP', ldi(at('r2', 'b', 2)), 3)],
            stf('x1', add(ldf('x1'), 'm')),
            ['if', ['i32.ne', 'x2', 'x1'], [stf('x2', add(ldf('x2'), 'm'))]]]]],
        ['for', 'b', I(0), I(169), 1,
          stf(at('out', 'b', 3), mul(mul('g', ldf(at('cnt', 'b', 3))),
            add(sub(sub('T', ldf(at('PP', ldi(at('r1', 'b', 2)), 3))), ldf(at('PP', ldi(at('r2', 'b', 2)), 3))), ldf(at('r', 'b', 3)))))]] },
    // Live classes of reach r (r[b] > 1e-7 * max): their indices into live, their weights into
    // lw; returns how many.
    { name: 'pfLive', params: P('r live lw'), results: ['i32'], locals: [...P('b nz'), ['mx', 'f64'], ['x', 'f64'], ['th', 'f64']],
      body: [
        ['set', 'mx', ['f64', 0]],
        ['for', 'b', I(0), I(169), 1, ['set', 'x', ldf(at('r', 'b', 3))], ['if', ['f64.gt', 'x', 'mx'], [['set', 'mx', 'x']]]],
        ['set', 'th', mul(['f64', 1e-7], 'mx')], ['set', 'nz', I(0)],
        ['for', 'b', I(0), I(169), 1, ['set', 'x', ldf(at('r', 'b', 3))],
          ['if', ['f64.gt', 'x', 'th'], [['i32.store', at('live', 'nz', 2), 'b'], stf(at('lw', 'nz', 3), 'x'), ['set', 'nz', ['i32.add', 'nz', I(1)]]]]],
        'nz'] },
    // Preflop leaf, hero's side: out[a] = sum over j of XT[live[j]][a] * lw[j], two classes per
    // lane pair, two rows per pass (each out[a] still adds its terms in order j = 0, 1, ...).
    // XT: 170 x 170 floats (transposed, padded); out: 170 doubles.
    { name: 'pfRowsT', params: P('XT live lw nz out'), locals: [...P('a j r0 r1'), ['w0', 'v128'], ['w1', 'v128']],
      body: [
        ['for', 'a', I(0), I(170), 2, st2(at('out', 'a', 3), ['f64x2.splat', ['f64', 0]])],
        ['set', 'j', I(0)],
        ['while', ['i32.lt_s', ['i32.add', 'j', I(1)], 'nz'],
          ['set', 'r0', ['i32.add', 'XT', ['i32.mul', ldi(at('live', 'j', 2)), I(680)]]],
          ['set', 'r1', ['i32.add', 'XT', ['i32.mul', ldi(at('live', ['i32.add', 'j', I(1)], 2)), I(680)]]],
          ['set', 'w0', ['f64x2.splat', ldf(at('lw', 'j', 3))]], ['set', 'w1', ['f64x2.splat', ldf(at('lw', ['i32.add', 'j', I(1)], 3))]],
          ['for', 'a', I(0), I(170), 2,
            st2(at('out', 'a', 3), vadd(vadd(ld2(at('out', 'a', 3)), vmul(ldf32x2(at('r0', 'a', 2)), 'w0')), vmul(ldf32x2(at('r1', 'a', 2)), 'w1')))],
          ['set', 'j', ['i32.add', 'j', I(2)]]],
        ['if', ['i32.lt_s', 'j', 'nz'], [
          ['set', 'r0', ['i32.add', 'XT', ['i32.mul', ldi(at('live', 'j', 2)), I(680)]]],
          ['set', 'w0', ['f64x2.splat', ldf(at('lw', 'j', 3))]],
          ['for', 'a', I(0), I(170), 2,
            st2(at('out', 'a', 3), vadd(ld2(at('out', 'a', 3)), vmul(ldf32x2(at('r0', 'a', 2)), 'w0')))]]]] },
    // Preflop leaf, villain's side: acc[b] = sum over j of ph[j] * XP[live[j]][b] (rows padded to 170).
    { name: 'pfAcc', params: P('XP live ph nz acc'), locals: [...P('b j r0 r1'), ['p0', 'v128'], ['p1', 'v128']],
      body: [
        ['for', 'b', I(0), I(170), 2, st2(at('acc', 'b', 3), ['f64x2.splat', ['f64', 0]])],
        ['set', 'j', I(0)],
        ['while', ['i32.lt_s', ['i32.add', 'j', I(1)], 'nz'],
          ['set', 'r0', ['i32.add', 'XP', ['i32.mul', ldi(at('live', 'j', 2)), I(680)]]],
          ['set', 'r1', ['i32.add', 'XP', ['i32.mul', ldi(at('live', ['i32.add', 'j', I(1)], 2)), I(680)]]],
          ['set', 'p0', ['f64x2.splat', ldf(at('ph', 'j', 3))]], ['set', 'p1', ['f64x2.splat', ldf(at('ph', ['i32.add', 'j', I(1)], 3))]],
          ['for', 'b', I(0), I(170), 2,
            st2(at('acc', 'b', 3), vadd(vadd(ld2(at('acc', 'b', 3)), vmul('p0', ldf32x2(at('r0', 'b', 2)))), vmul('p1', ldf32x2(at('r1', 'b', 2)))))],
          ['set', 'j', ['i32.add', 'j', I(2)]]],
        ['if', ['i32.lt_s', 'j', 'nz'], [
          ['set', 'r0', ['i32.add', 'XP', ['i32.mul', ldi(at('live', 'j', 2)), I(680)]]],
          ['set', 'p0', ['f64x2.splat', ldf(at('ph', 'j', 3))]],
          ['for', 'b', I(0), I(170), 2,
            st2(at('acc', 'b', 3), vadd(ld2(at('acc', 'b', 3)), vmul('p0', ldf32x2(at('r0', 'b', 2)))))]]]] },
  ];

  // The kernels, the shared memory and a bump allocator over it (null without WebAssembly SIMD).
  let WK = null, wkTried = false, wkEnabled = true;
  function kernels() {
    if (!wkEnabled) return null;
    if (wkTried) return WK;
    wkTried = true;
    try {
      if (typeof WebAssembly !== 'object') return null;
      const bytes = wasmModule(KERNELS);
      if (!WebAssembly.validate(bytes)) return null;
      const mem = new WebAssembly.Memory({ initial: 16 });
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { m: mem } });
      WK = { k: inst.exports, mem, top: 0, end: 0 };
    } catch (e) {
      WK = null;
    }
    return WK;
  }
  // Start a solve's allocations: room for `bytes` bytes (views from earlier solves become invalid).
  // False when the memory cannot grow that far; the solve then runs in plain JS.
  function arenaBegin(bytes) {
    const need = Math.ceil((bytes + 1024) / 65536);
    const have = WK.mem.buffer.byteLength / 65536;
    if (need > have) {
      try { WK.mem.grow(need - have); } catch (e) { return false; }
    }
    WK.top = 0;
    WK.end = WK.mem.buffer.byteLength;
    return true;
  }
  function arenaTake(bytes) {
    const off = WK.top;
    WK.top += Math.ceil(bytes / 16) * 16;
    if (WK.top > WK.end) throw new Error('kernel arena overflow');
    return off;
  }
  // Zeroed views (the memory is reused from solve to solve).
  const arenaF64 = (n) => new Float64Array(WK.mem.buffer, arenaTake(8 * n), n).fill(0);
  const arenaF32 = (n) => new Float32Array(WK.mem.buffer, arenaTake(4 * n), n).fill(0);
  const arenaI32 = (n) => new Int32Array(WK.mem.buffer, arenaTake(4 * n), n).fill(0);
  const arenaU8 = (n) => new Uint8Array(WK.mem.buffer, arenaTake(n), n).fill(0);
  const arenaBytes = (n, size) => Math.ceil((n * size) / 16) * 16;

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
    const score = new Int32Array(N);
    setBoard(board, 5);
    for (let i = 0; i < N; i++) {
      hi[i] = COMBO_HI[idx[i]]; lo[i] = COMBO_LO[idx[i]];
      score[i] = scoreHole(hi[i], lo[i]);
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
    const ties = boardPlayers(board);

    // Blocker-aware showdown masses: for each hand, the other side's reach that is below,
    // tied with and above it, and the total, skipping hands that share a card.
    const tot = new Float64Array(N);
    const cum = new Float64Array(52), grp = new Float64Array(52), all = new Float64Array(52);
    // Hands in showdown order (cards and tie groups precomputed), so the loop below does no searching.
    const oHi = new Uint8Array(N), oLo = new Uint8Array(N), gEnd = new Int32Array(N), rs = new Float64Array(N);
    for (let j = 0; j < N; j++) { oHi[j] = hi[order[j]]; oLo[j] = lo[order[j]]; }
    for (let g = 0; g < N;) {
      let e = g;
      const s = score[order[g]];
      while (e < N && score[order[e]] === s) e++;
      gEnd[g] = e;
      g = e;
    }
    // Showdown value of every hand against reach r (pot potF, `inv` chips put in by the side
    // being valued), written straight into v: potF * (below + tie / 2) - inv * total.
    function showValues(r, v, potF, inv) {
      cum.fill(0); all.fill(0);
      let T = 0, cT = 0;
      for (let i = 0; i < N; i++) { const x = r[i]; T += x; all[hi[i]] += x; all[lo[i]] += x; }
      for (let j = 0; j < N; j++) rs[j] = r[order[j]];
      let g = 0;
      while (g < N) {
        const e = gEnd[g];
        if (e === g + 1) {
          // A hand with no ties: the general formula's tie mass is exactly 0 here.
          const i = order[g], h = oHi[g], l = oLo[g], x = rs[g];
          const bl = cT - cum[h] - cum[l], tie = 0;
          v[i] = potF * (bl + tie / 2) - inv * (T - all[h] - all[l] + x);
          cT += x; cum[h] += x; cum[l] += x;
          g = e;
          continue;
        }
        let gT = 0;
        for (let j = g; j < e; j++) { const x = rs[j]; gT += x; grp[oHi[j]] += x; grp[oLo[j]] += x; }
        for (let j = g; j < e; j++) {
          const i = order[j], h = oHi[j], l = oLo[j], x = rs[j];
          v[i] = potF * ((cT - cum[h] - cum[l]) + (gT - grp[h] - grp[l] + x) / 2) - inv * (T - all[h] - all[l] + x);
        }
        for (let j = g; j < e; j++) { const x = rs[j], h = oHi[j], l = oLo[j]; cT += x; cum[h] += x; cum[l] += x; grp[h] = 0; grp[l] = 0; }
        g = e;
      }
    }
    // Value g * (the other side's reach not sharing a card) for every hand.
    function foldValues(r, v, g) {
      all.fill(0);
      let T = 0;
      for (let i = 0; i < N; i++) { const x = r[i]; T += x; all[hi[i]] += x; all[lo[i]] += x; }
      for (let i = 0; i < N; i++) v[i] = g * (T - all[hi[i]] - all[lo[i]] + r[i]);
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
      // Everything that does not depend on the hand, worked out once per decision.
      const vr = valueShare(oppStats, oppBetFrac);
      const foldCut = facingFrac != null && !vsRaise ? (cfg.aggScale || 1) * foldAtSize(oppStats, facingFrac, 5) : 0;
      const raiseCut = 1 - clamp(st5.raiseFreq, 0.02, 0.3);
      const hasRaise = acts.some((a) => a.kind === 'raise');
      const kinds = acts.map((a) => a.kind);
      const pr = new Float64Array(nA);
      for (let i = 0; i < N; i++) {
        const q = qO[idx[i]];
        if (facingFrac == null) {
          const pBet = sigmoid((q - (1 - bf * vr)) / 0.035) + (1 - sigmoid((q - (1 - bf * vr)) / 0.035)) * sigmoid((bf * (1 - vr) - q) / 0.035);
          for (let j = 0; j < nA; j++) pr[j] = kinds[j] === 'check' ? 1 - pBet : pBet / Math.max(1, nA - 1);
        } else {
          let pCont;
          if (vsRaise && toCall > 0) {
            // Their range here is their betting range: fold the weakest (1 - valueShare) of it.
            pCont = sigmoid((q - 0.9 * (1 - vrB)) / 0.04);
          } else if (vsRaise) {
            // They bet inside the tree: value hands continue, bluffs mostly fold.
            pCont = q >= 1 - bf * vrB ? 1 : q < bf * (1 - vrB) ? 0.1 : 0.5;
          } else {
            pCont = sigmoid((q - foldCut) / 0.04);
          }
          if (ties && ties[idx[i]]) pCont = 1;
          const pRaise = sigmoid((q - raiseCut) / 0.03);
          for (let j = 0; j < nA; j++) {
            if (kinds[j] === 'fold') pr[j] = 1 - pCont;
            else if (kinds[j] === 'raise') pr[j] = pCont * pRaise;
            else pr[j] = pCont * (hasRaise ? 1 - pRaise : 1);
          }
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
        const leafS = { term: 'show', hIn: h2, oIn: o2 };
        // Multiway: when the field calls hero's bet, the other callers' chips (cfg.overcall:
        // expected callers given that someone calls) go into the pot as well.
        if (player === 1 && oIn === 0 && cfg.overcall) {
          const m = cfg.overcall(facing / Math.max(1e-9, potNow - facing));
          if (m > 1) leafS.x = (m - 1) * c;
        }
        add({ kind: c >= left ? 'allin' : 'call', amount: c }, leafS);
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
      // Work buffers, reused on every visit (each node is visited once per traversal).
      n.s = new Float64Array(nA * N);
      n.v = new Float64Array(N);
      n.reach = n.kids.map(() => new Float64Array(N));
      if (player === 1) {
        n.fixed = fixedStrategy(acts, facing > 0 ? facing / (potNow - facing) : null, !!vsRaise);
        n.pFixed = n.fixed.map((x) => p * x);
      }
      n.sIter = 0;
      return n;
    }
    const root = toCall > 0 ? node(0, 0, 0, toCall, 1, true) : node(0, 0, 0, 0, 1, !heroFirst);
    // Terminal nodes get their own value buffer too.
    (function addBuffers(n) {
      for (const k of n.kids) { if (k.term) k.v = new Float64Array(N); else addBuffers(k); }
    })(root);

    // ----- Discounted CFR: positive regrets discounted by t^1.5/(t^1.5+1), negative regrets
    // reset to zero (as in CFR+), average strategy weighted by (t/(t+1))^2 -----
    function strategy(n, out) {
      const nA = n.acts.length, regret = n.regret;
      for (let i = 0; i < N; i++) {
        let t = 0;
        for (let a = 0; a < nA; a++) { const r = regret[a * N + i]; if (r > 0) t += r; }
        for (let a = 0; a < nA; a++) {
          const r = regret[a * N + i];
          out[a * N + i] = t > 0 ? (r > 0 ? r / t : 0) : 1 / nA;
        }
      }
      if (n.player === 1) { const pf = n.pFixed, q = 1 - p; for (let j = 0; j < nA * N; j++) out[j] = pf[j] + q * out[j]; }
      return out;
    }
    let iter = 0;
    // Returns the node's value buffer (valid until the node is visited again).
    function cfr(n, trav, rH, rO, avg) {
      if (n.term) {
        const v = n.v;
        const potF = n.x ? P0 + n.hIn + n.oIn + n.x : P0 + n.hIn + n.oIn;
        if (n.term === 'fold') {
          const heroGain = n.winner === 0 ? P0 + n.oIn : -n.hIn;
          foldValues(trav === 0 ? rO : rH, v, trav === 0 ? heroGain : P0 - heroGain);
        } else {
          // For the opponent the same formula holds from their side: they win the pot when
          // the hero hand is below theirs. (Zero-sum up to the sunk pot.)
          showValues(trav === 0 ? rO : rH, v, potF, trav === 0 ? n.hIn : n.x ? n.oIn + n.x : n.oIn);
        }
        return v;
      }
      const nA = n.acts.length;
      const s = n.s;
      if (avg) {
        const sum = n.sum;
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += sum[a * N + i];
          for (let a = 0; a < nA; a++) s[a * N + i] = t > 0 ? sum[a * N + i] / t : 1 / nA;
        }
      } else if (n.player === 0 || n.sIter !== iter) {
        // The opponent's regrets only change in their own traversal (the second one), so the
        // strategy worked out in hero's traversal of this iteration is still current there.
        strategy(n, s);
        if (n.player === 1) n.sIter = iter;
      }
      const v = n.v;
      v.fill(0);
      const own = n.player === trav;
      const vals = own ? [] : null;
      const base = n.player === 0 ? rH : rO;
      for (let a = 0; a < nA; a++) {
        const r2 = n.reach[a];
        const off = a * N;
        for (let i = 0; i < N; i++) r2[i] = base[i] * s[off + i];
        const va = n.player === 0 ? cfr(n.kids[a], trav, r2, rO, avg) : cfr(n.kids[a], trav, rH, r2, avg);
        if (own) { vals.push(va); for (let i = 0; i < N; i++) v[i] += s[off + i] * va[i]; }
        else for (let i = 0; i < N; i++) v[i] += va[i];
      }
      if (own && !avg) {
        const pos = Math.pow(iter, 1.5) / (Math.pow(iter, 1.5) + 1);
        const w = Math.pow(iter / (iter + 1), 2);
        const reach = n.player === 0 ? rH : rO;
        const regret = n.regret, sum = n.sum;
        for (let a = 0; a < nA; a++) {
          const va = vals[a];
          for (let i = 0; i < N; i++) {
            const j = a * N + i;
            const r = regret[j];
            regret[j] = (r > 0 ? r * pos : 0) + va[i] - v[i];
            sum[j] = sum[j] * w + reach[i] * s[j];
          }
        }
      }
      if (own && avg) n.vals = vals.map((x) => x.slice());
      return v;
    }

    // ----- the same CFR with the WebAssembly kernels: every buffer moves into the kernel
    // memory with rows padded to an even length Np (the padding stays zero) -----
    let KK = kernels();
    const Np = N + (N & 1);
    let wHk = null, wOk = null, kv = null;
    if (KK) {
      const B = arenaBytes, D = 8;
      let bytes = 2 * B(Np, D) + 4 * B(N, 1) + 2 * B(N, 4) + B(N, D) + 3 * B(52, D);
      (function size(n) {
        for (const k of n.kids) {
          if (k.term) { bytes += B(Np, D); continue; }
          const nA = k.acts.length;
          bytes += 4 * B(nA * Np, D) + B(Np, D) + nA * B(Np, D);
          size(k);
        }
      })({ kids: [root] });
      if (!arenaBegin(bytes)) KK = null;
    }
    if (KK) {
      wHk = arenaF64(Np); wHk.set(wH);
      wOk = arenaF64(Np); wOk.set(wO);
      const u8 = (x) => { const a = arenaU8(N); a.set(x); return a.byteOffset; };
      const i32 = (x) => { const a = arenaI32(N); a.set(x); return a.byteOffset; };
      kv = {
        hi: u8(hi), lo: u8(lo), oHi: u8(oHi), oLo: u8(oLo), order: i32(order), gEnd: i32(gEnd),
        rs: arenaF64(N).byteOffset, cum: arenaF64(52).byteOffset, all: arenaF64(52).byteOffset, grp: arenaF64(52).byteOffset,
      };
      (function move(n) {
        for (const k of n.kids) {
          if (k.term) { k.v = arenaF64(Np); continue; }
          const nA = k.acts.length;
          k.regret = arenaF64(nA * Np); k.sum = arenaF64(nA * Np); k.s = arenaF64(nA * Np);
          const pf = arenaF64(nA * Np);
          if (k.pFixed) for (let a = 0; a < nA; a++) pf.set(k.pFixed.subarray(a * N, (a + 1) * N), a * Np);
          k.pFixed = pf;
          k.v = arenaF64(Np);
          k.reach = k.kids.map(() => arenaF64(Np));
          move(k);
        }
      })({ kids: [root] });
    }
    function cfrK(n, trav, rH, rO, avg) {
      const k = KK.k;
      if (n.term) {
        const v = n.v;
        const r = trav === 0 ? rO : rH;
        if (n.term === 'fold') {
          const heroGain = n.winner === 0 ? P0 + n.oIn : -n.hIn;
          k.foldRiver(r.byteOffset, v.byteOffset, N, trav === 0 ? heroGain : P0 - heroGain, kv.hi, kv.lo, kv.all);
        } else {
          k.showRiver(r.byteOffset, v.byteOffset, N, n.x ? P0 + n.hIn + n.oIn + n.x : P0 + n.hIn + n.oIn, trav === 0 ? n.hIn : n.x ? n.oIn + n.x : n.oIn,
            kv.hi, kv.lo, kv.order, kv.oHi, kv.oLo, kv.gEnd, kv.rs, kv.cum, kv.all, kv.grp);
        }
        return v;
      }
      const nA = n.acts.length;
      const s = n.s, so = s.byteOffset, row = 8 * Np;
      if (avg) {
        const sum = n.sum;
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += sum[a * Np + i];
          for (let a = 0; a < nA; a++) s[a * Np + i] = t > 0 ? sum[a * Np + i] / t : 1 / nA;
        }
      } else if (n.player === 0 || n.sIter !== iter) {
        k.strategyDiv(n.regret.byteOffset, so, nA, Np, n.player === 1 ? n.pFixed.byteOffset : 0, 1 - p, 1 / nA);
        if (n.player === 1) n.sIter = iter;
      }
      const v = n.v;
      v.fill(0);
      const own = n.player === trav;
      const vals = own ? [] : null;
      const base = n.player === 0 ? rH : rO;
      for (let a = 0; a < nA; a++) {
        const r2 = n.reach[a];
        k.mul(r2.byteOffset, base.byteOffset, so + a * row, Np);
        const va = n.player === 0 ? cfrK(n.kids[a], trav, r2, rO, avg) : cfrK(n.kids[a], trav, rH, r2, avg);
        if (own) { vals.push(va); k.addMul(v.byteOffset, so + a * row, va.byteOffset, Np); }
        else k.addTo(v.byteOffset, va.byteOffset, Np);
      }
      if (own && !avg) {
        const pos = Math.pow(iter, 1.5) / (Math.pow(iter, 1.5) + 1);
        const w = Math.pow(iter / (iter + 1), 2);
        const ro = n.regret.byteOffset, sm = n.sum.byteOffset;
        for (let a = 0; a < nA; a++) k.regretRiver(ro + a * row, sm + a * row, vals[a].byteOffset, v.byteOffset, base.byteOffset, so + a * row, Np, pos, w);
      }
      if (own && avg) n.vals = vals.map((x) => x.slice());
      return v;
    }

    const iterations = cfg.iterations || RIVER_ITERATIONS;
    const run = KK ? cfrK : cfr, rH0 = KK ? wHk : wH, rO0 = KK ? wOk : wO, S = KK ? Np : N;
    for (iter = 1; iter <= iterations; iter++) {
      run(root, 0, rH0, rO0, false);
      run(root, 1, rH0, rO0, false);
    }
    // Final pass with average strategies: EV of each root action for hero's real hand.
    run(root, 0, rH0, rO0, true);
    totals(wO);
    const norm = tot[h0] > 0 ? tot[h0] : 1;
    let t = 0;
    for (let a = 0; a < root.acts.length; a++) t += root.sum[a * S + h0];
    return {
      iterations,
      actions: root.acts.map((a, j) => ({
        kind: a.kind, amount: a.amount, frac: a.frac,
        freq: t > 0 ? root.sum[j * S + h0] / t : 1 / root.acts.length,
        ev: root.vals[j][h0] / norm,
      })),
    };
  }


  // ---------- Turn solver (computer mode) ----------
  /*
   * Heads-up turn spots on the computer: the turn and the river are solved together with
   * Discounted CFR. Every turn line that sees a river leads to a river subgame for each of
   * the 48 possible river cards (built when first needed); each iteration samples a few
   * river cards per line (chance sampling), and the final pass for the advice uses every
   * card. Turn: hero bets 50% or 100% pot, the opponent their usual size, one raise. River:
   * out of position first, hero bets 66% pot, the opponent their size, one raise. The
   * opponent plays the read's strategy with weight p, as in the river solver; on the river
   * that strategy is applied to the range the read would bring there along that line.
   * Hero's and the opponent's hands are indexed separately (each range without its
   * negligible hands), which keeps the arrays short.
   */
  const TURN_ITERATIONS = 300;
  // The field for the multiway flop and turn solves: W = weights of the live hand with the most
  // equity on this street (ehs) over joint samples of every opponent's hand, and kappa per hero
  // combo = hero's showdown share against all of them over the share against that hand, from
  // the same samples (plus random cards to the river).
  function turnField(opps, heroW, board, dead, ehs, samples, seed) {
    const rng = mulberry32((seed ^ 0x6a09e667) >>> 0);
    const K = opps.length, W = new Float64Array(NUM_COMBOS);
    let mx = 0;
    for (let k = 0; k < NUM_COMBOS; k++) if (heroW[k] > mx) mx = heroW[k];
    if (!(mx > 0)) return null;
    const heroList = [];
    for (let k = 0; k < NUM_COMBOS; k++) if (heroW[k] > 0.03 * mx) heroList.push(k);
    const multiS = new Float64Array(NUM_COMBOS), repS = new Float64Array(NUM_COMBOS);
    const used = new Uint8Array(52), buf = new Int32Array(7), hand = new Int32Array(K), sc = new Int32Array(K);
    const nb = board.length;
    for (let j = 0; j < nb; j++) buf[j] = board[j];
    let got = 0;
    for (let it = 0; it < samples * 3 && got < samples; it++) {
      used.fill(0);
      for (const c of dead) used[c] = 1;
      let ok = true, rep = 0;
      for (let i = 0; i < K && ok; i++) {
        let k = -1;
        for (let tries = 0; tries < 40; tries++) {
          const cand = sampleCombo(opps[i].sampler, rng());
          if (!used[COMBO_HI[cand]] && !used[COMBO_LO[cand]]) { k = cand; break; }
        }
        if (k < 0) { ok = false; break; }
        used[COMBO_HI[k]] = used[COMBO_LO[k]] = 1;
        hand[i] = k;
        if (ehs[k] > ehs[hand[rep]]) rep = i;
      }
      if (!ok) continue;
      // Hero's own cards are dead for the field but not for hero's range: free them.
      for (let i = 0; i < K; i++) { used[COMBO_HI[hand[i]]] = 2; used[COMBO_LO[hand[i]]] = 2; }
      for (let j = 0; j < nb; j++) used[board[j]] = 2;
      for (let j = nb; j < 5; j++) {
        let c;
        do { c = Math.floor(rng() * 52); } while (used[c] !== 0);
        used[c] = 3;
        buf[j] = c;
      }
      W[hand[rep]]++;
      got++;
      let best = -1;
      for (let i = 0; i < K; i++) { buf[5] = COMBO_HI[hand[i]]; buf[6] = COMBO_LO[hand[i]]; sc[i] = evaluate(buf, 7); if (sc[i] > best) best = sc[i]; }
      let ties = 0;
      for (let i = 0; i < K; i++) if (sc[i] === best) ties++;
      const repScore = sc[rep];
      for (const k of heroList) {
        const a = COMBO_HI[k], b = COMBO_LO[k];
        if (used[a] >= 2 || used[b] >= 2) continue;
        buf[5] = a; buf[6] = b;
        const h = evaluate(buf, 7);
        multiS[k] += h > best ? 1 : h === best ? 1 / (ties + 1) : 0;
        repS[k] += h > repScore ? 1 : h === repScore ? 0.5 : 0;
      }
    }
    if (got < 50) return null;
    const kappa = new Float64Array(NUM_COMBOS).fill(1);
    for (const k of heroList) kappa[k] = clamp((multiS[k] + 0.25) / (repS[k] + 0.25), 0.05, 1.05);
    return { W, kappa, samples: got };
  }

  function turnSolve(cfg) {
    const { board, heroCombo, heroW, oppW, oppStats, p, pot: P0, toCall, stack, heroFirst, heroIP, bigBlind } = cfg;
    const st4 = cfg.strengths4;
    const onBoard = new Uint8Array(52);
    board.forEach((c) => { onBoard[c] = 1; });
    const possible = (k) => !onBoard[COMBO_HI[k]] && !onBoard[COMBO_LO[k]];
    const rivers = [];
    for (let c = 0; c < 52; c++) if (!onBoard[c]) rivers.push(c);
    const buf = new Int32Array(7);
    for (let j = 0; j < 4; j++) buf[j] = board[j];

    // One side's hands: global combo ids, cards, starting weights, and per river card the
    // 7-card score and the hands sorted by it (hands holding the card are left out).
    function side(W, keepFrac, must) {
      let mx = 0;
      for (let k = 0; k < NUM_COMBOS; k++) if (possible(k) && W[k] > mx) mx = W[k];
      if (!(mx > 0)) return null;
      const idx = [];
      for (let k = 0; k < NUM_COMBOS; k++) if (possible(k) && (k === must || W[k] > keepFrac * mx)) idx.push(k);
      const n = idx.length, S = { idx, n, hi: new Uint8Array(n), lo: new Uint8Array(n), w: new Float64Array(n), local: new Int32Array(NUM_COMBOS).fill(-1), R: new Array(52) };
      idx.forEach((k, i) => { S.hi[i] = COMBO_HI[k]; S.lo[i] = COMBO_LO[k]; S.w[i] = Math.max(0, W[k]); S.local[k] = i; });
      for (const c of rivers) {
        buf[4] = c;
        setBoard(buf, 5);
        const score = new Int32Array(n), valid = new Uint8Array(n), list = [];
        for (let i = 0; i < n; i++) {
          if (S.hi[i] === c || S.lo[i] === c) continue;
          score[i] = scoreHole(S.hi[i], S.lo[i]);
          valid[i] = 1;
          list.push(i);
        }
        list.sort((a, b) => score[a] - score[b]);
        S.R[c] = { score, valid, order: Int32Array.from(list) };
      }
      return S;
    }
    const H = side(heroW, cfg.heroPrune != null ? cfg.heroPrune : 0.03, heroCombo), O = side(oppW, cfg.oppPrune != null ? cfg.oppPrune : 0.01, -1);
    if (!H || !O) return null;
    const h0 = H.local[heroCombo];
    if (h0 < 0) return null;
    let meanH = 0;
    for (let i = 0; i < H.n; i++) meanH += H.w[i];
    meanH /= H.n;
    H.w[h0] = Math.max(H.w[h0], 0.25 * meanH, 1e-6);
    // The same hand on the other side (it can't be held by both).
    H.cross = Int32Array.from(H.idx, (k) => O.local[k]);
    O.cross = Int32Array.from(O.idx, (k) => H.local[k]);
    const NMAX = Math.max(H.n, O.n);
    const multi = cfg.multi && cfg.multi.kappa ? cfg.multi : null;
    const kapCache = {};
    const mtmp = multi ? new Float64Array(NMAX) : null, mrA = multi ? new Float64Array(H.n) : null, mrB = multi ? new Float64Array(H.n) : null;
    const sides = [H, O];

    // ----- blocker-aware showdown masses: for each hand of side T, the other side's reach
    // below, tied with and in total, skipping hands that share a card -----
    const tot = new Float64Array(NMAX);
    const cum = new Float64Array(52), grp = new Float64Array(52), all = new Float64Array(52);
    // Adds sc * (potF * (below + tie / 2) - myIn * total) to out[i] for every hand i of T that
    // is live with river card c (the showdown sweep and the value written in one pass).
    function showAdd(r, X, T, c, out, sc, potF, myIn) {
      const RX = X.R[c], RT = T.R[c];
      const oo = RX.order, os = RX.score, xv = RX.valid, to = RT.order, ts = RT.score;
      const xh = X.hi, xl = X.lo, th = T.hi, tl = T.lo, cross = T.cross;
      const no = oo.length, nt = to.length;
      cum.fill(0); all.fill(0);
      let tt = 0;
      for (let j = 0; j < no; j++) { const i = oo[j], x = r[i]; tt += x; all[xh[i]] += x; all[xl[i]] += x; }
      let a = 0, b = 0, cT = 0;
      while (b < nt) {
        const s = ts[to[b]];
        while (a < no && os[oo[a]] < s) { const i = oo[a], x = r[i]; cT += x; cum[xh[i]] += x; cum[xl[i]] += x; a++; }
        let a2 = a, gT = 0;
        while (a2 < no && os[oo[a2]] === s) { const i = oo[a2], x = r[i]; gT += x; grp[xh[i]] += x; grp[xl[i]] += x; a2++; }
        while (b < nt && ts[to[b]] === s) {
          const i = to[b], h = th[i], l = tl[i], ci = cross[i], same = ci >= 0 && xv[ci] ? r[ci] : 0;
          out[i] += sc * (potF * ((cT - cum[h] - cum[l]) + (gT - grp[h] - grp[l] + same) / 2) - myIn * (tt - all[h] - all[l] + same));
          b++;
        }
        for (let j = a; j < a2; j++) { const i = oo[j]; grp[xh[i]] = 0; grp[xl[i]] = 0; }
      }
    }
    function totals(r, X, T) {
      all.fill(0);
      let tt = 0;
      for (let i = 0; i < X.n; i++) { const x = r[i]; tt += x; all[X.hi[i]] += x; all[X.lo[i]] += x; }
      for (let i = 0; i < T.n; i++) tot[i] = tt - all[T.hi[i]] - all[T.lo[i]] + (T.cross[i] >= 0 ? r[T.cross[i]] : 0);
    }
    // out[i] = g * (the other side's reach not sharing a card with hand i of T).
    function foldValues(r, X, T, out, g) {
      all.fill(0);
      let tt = 0;
      const xh = X.hi, xl = X.lo, th = T.hi, tl = T.lo, cross = T.cross, nx = X.n, nt = T.n;
      for (let i = 0; i < nx; i++) { const x = r[i]; tt += x; all[xh[i]] += x; all[xl[i]] += x; }
      for (let i = 0; i < nt; i++) { const ci = cross[i]; out[i] = g * (tt - all[th[i]] - all[tl[i]] + (ci >= 0 ? r[ci] : 0)); }
    }

    // ----- the read's strategy for the opponent -----
    const round = (x) => roundChips(x, bigBlind);
    const betFrac = clamp(oppStats.betSize || 0.6, 0.33, 1);
    const qTurn = new Float64Array(O.n);
    {
      const q = rangeQuantiles(oppW, st4.ehs);
      for (let i = 0; i < O.n; i++) qTurn[i] = q[O.idx[i]];
    }
    // Quantile of each opponent hand inside reach r by river score (ties share the middle).
    function riverQuantiles(r, c) {
      const ord = O.R[c].order, score = O.R[c].score, q = new Float64Array(O.n);
      let T = 0;
      for (let j = 0; j < ord.length; j++) T += r[ord[j]];
      if (!(T > 0)) { for (let j = 0; j < ord.length; j++) q[ord[j]] = (j + 0.5) / ord.length; return q; }
      let g = 0, cumW = 0;
      while (g < ord.length) {
        let e = g, w = 0;
        const s = score[ord[g]];
        while (e < ord.length && score[ord[e]] === s) { w += r[ord[e]]; e++; }
        const mid = (cumW + w / 2) / T;
        for (let j = g; j < e; j++) q[ord[j]] = mid;
        cumW += w;
        g = e;
      }
      return q;
    }
    // River cards that make the board a straight or better: the opponent's hands that only play
    // the board call any bet (boardPlayers).
    const tieCache = new Array(52);
    function riverTies(c) {
      if (tieCache[c] !== undefined) return tieCache[c];
      const all = boardPlayers(board.concat([c]));
      let out = null;
      if (all) {
        out = new Uint8Array(O.n);
        let any = 0;
        for (let i = 0; i < O.n; i++) if (all[O.idx[i]]) { out[i] = 1; any++; }
        if (!any) out = null;
      }
      return (tieCache[c] = out);
    }
    function fixedStrategy(acts, facingFrac, vsRaise, rootRaise, q, n5, aggS, ties) {
      const st = streetStats(oppStats, n5);
      const bf = clamp(st.betFreq, 0.05, 0.9), vr = valueShare(oppStats, betFrac);
      const N = O.n, nA = acts.length, s = new Float32Array(nA * N), pr = new Float64Array(nA);
      const hasRaise = facingFrac != null && acts.some((a) => !a.isCall && a.kind !== 'fold');
      const foldQ = facingFrac == null ? 0 : aggS * foldAtSize(oppStats, facingFrac, n5);
      const rq = 1 - clamp(st.raiseFreq, 0.02, 0.3);
      for (let i = 0; i < N; i++) {
        const qi = q[i];
        if (facingFrac == null) {
          const a = sigmoid((qi - (1 - bf * vr)) / 0.035);
          const pBet = a + (1 - a) * sigmoid((bf * (1 - vr) - qi) / 0.035);
          const nBets = Math.max(1, nA - 1);
          for (let j = 0; j < nA; j++) pr[j] = acts[j].kind === 'check' ? 1 - pBet : pBet / nBets;
        } else {
          let pCont;
          if (rootRaise) pCont = sigmoid((qi - 0.9 * (1 - vr)) / 0.04);
          else if (vsRaise) pCont = qi >= 1 - bf * vr ? 1 : qi < bf * (1 - vr) ? 0.1 : 0.5;
          else pCont = sigmoid((qi - foldQ) / 0.04);
          if (ties && ties[i]) pCont = 1;
          const pRaise = sigmoid((qi - rq) / 0.03);
          for (let j = 0; j < nA; j++) {
            const a = acts[j];
            if (a.kind === 'fold') pr[j] = 1 - pCont;
            else if (a.isCall) pr[j] = pCont * (hasRaise ? 1 - pRaise : 1);
            else pr[j] = pCont * pRaise;
          }
        }
        let t = 0;
        for (let j = 0; j < nA; j++) t += pr[j];
        for (let j = 0; j < nA; j++) s[j * N + i] = t > 0 ? pr[j] / t : 1 / nA;
      }
      return s;
    }
    const aggAlways = cfg.aggScale || 1, aggIfBet = cfg.aggScaleIfAgg || 1;

    // ----- tree -----
    const maxIn = (pl) => (pl === 0 ? stack : Math.max(0, stack - toCall));
    // Hero's sizes (fractions of the pot). At most 3 bets or 2 raises, so a node has at most 4 actions.
    const turnBets = (cfg.turnBets || [0.33, 0.66, 1]).slice(0, 3), riverBets = (cfg.riverBets || [0.5, 1]).slice(0, 3);
    const raiseFracs = (cfg.raiseFracs || [1]).slice(0, 2);
    let nodes = 0;
    function makeNode(n5, card, player, hIn, oIn, facing, raisesLeft, lastToAct, vsRaise, fr, oppAgg, q, nb = 0) {
      nodes++;
      const potNow = P0 + hIn + oIn;
      const myIn = player === 0 ? hIn : oIn;
      const left = maxIn(player) - myIn;
      const acts = [], kids = [];
      const add = (a, k) => { if (!acts.some((x) => x.kind === a.kind && Math.abs(x.amount - a.amount) < 1e-9)) { acts.push(a); kids.push(k); } };
      const after = (amt) => (player === 0 ? [hIn + amt, oIn] : [hIn, oIn + amt]);
      // A call or check that ends the street: river cards next, or a showdown.
      const close = (h, o, frc, agg) => {
        if (n5 === 5) return { term: 'show', card, hIn: h, oIn: o, nb };
        if (h >= maxIn(0) - 1e-9 || o >= maxIn(1) - 1e-9) return { term: 'allin', hIn: h, oIn: o, nb };
        return { chance: true, hIn: h, oIn: o, fr: frc, oppAgg: agg, subs: new Array(52), nb };
      };
      if (facing > 0) {
        add({ kind: 'fold', amount: 0 }, { term: 'fold', winner: 1 - player, hIn, oIn, card });
        const c = Math.min(facing, left);
        const [h2, o2] = after(c);
        add({ kind: c >= left - 1e-9 ? 'allin' : 'call', amount: c, isCall: true }, (frc) => close(h2, o2, frc, oppAgg));
        if (raisesLeft > 0 && left > facing + 1e-9) {
          for (const rf of (player === 0 ? raiseFracs : [1])) {
            const r = Math.min(left, round(facing + rf * (potNow + facing)));
            const [h3, o3] = after(r);
            add({ kind: r >= left - 1e-9 ? 'allin' : 'raise', amount: r, frac: (r - facing) / (potNow + facing) },
              (frc) => makeNode(n5, card, 1 - player, h3, o3, r - facing, raisesLeft - 1, true, true, frc, oppAgg || player === 1, q, nb + 1));
          }
        }
      } else {
        add({ kind: 'check', amount: 0 }, (frc) => (lastToAct ? close(hIn, oIn, frc, oppAgg) : makeNode(n5, card, 1 - player, hIn, oIn, 0, raisesLeft, true, false, frc, oppAgg, q, nb)));
        const fracs = player === 0 ? (n5 === 4 ? turnBets : riverBets) : [betFrac];
        for (const f of fracs) {
          const b = Math.min(left, round(f * potNow));
          if (b <= 0) continue;
          const [h2, o2] = after(b);
          add({ kind: b >= left - 1e-9 ? 'allin' : 'bet', amount: b, frac: b / potNow },
            (frc) => makeNode(n5, card, 1 - player, h2, o2, b, raisesLeft, true, false, frc, oppAgg || player === 1, q, nb + 1));
        }
      }
      const N = sides[player].n;
      const n = { player, acts, hIn, oIn, n5, card, t: 0 };
      n.regret = new Float32Array(acts.length * N);
      n.sum = new Float32Array(acts.length * N);
      if (player === 1) {
        const aggS = n5 === 4 ? aggAlways : (oppAgg ? aggIfBet : aggAlways);
        // Hero raising the bet the opponent made before this decision: their range is their betting range.
        const rootRaise = !!vsRaise && n5 === 4 && toCall > 0 && oIn === 0;
        n.fixed = fixedStrategy(acts, facing > 0 ? facing / (potNow - facing) : null, !!vsRaise, rootRaise, q, n5, aggS, n5 === 5 ? riverTies(card) : null);
        // Reach under the read's strategy, so river subgames know the read's range there.
        n.kids = kids.map((k, j) => {
          if (typeof k !== 'function') return k;
          const f2 = new Float64Array(N);
          for (let i = 0; i < N; i++) f2[i] = fr[i] * n.fixed[j * N + i];
          return k(f2);
        });
      } else n.kids = kids.map((k) => (typeof k === 'function' ? k(fr) : k));
      return n;
    }
    function riverRoot(ch, c) {
      const q = riverQuantiles(ch.fr, c);
      return makeNode(5, c, heroIP ? 1 : 0, ch.hIn, ch.oIn, 0, 1, false, false, ch.fr, ch.oppAgg, q, ch.nb);
    }
    const fr0 = Float64Array.from(O.w);
    const root = toCall > 0
      ? makeNode(4, -1, 0, 0, 0, toCall, 1, true, false, fr0, false, qTurn, 1)
      : makeNode(4, -1, 0, 0, 0, 0, 1, !heroFirst, false, fr0, false, qTurn);

    // ----- Discounted CFR with chance-sampled river cards -----
    const pools = [];
    const pool = (d) => {
      if (pools[d]) return pools[d];
      const r2f = new Float64Array(4 * NMAX), valf = new Float64Array(4 * NMAX);
      return (pools[d] = {
        s: new Float64Array(4 * NMAX), tmp: new Float64Array(NMAX), r2f, valf,
        r2: [0, 1, 2, 3].map((a) => r2f.subarray(a * NMAX, (a + 1) * NMAX)),
        vals: [0, 1, 2, 3].map((a) => valf.subarray(a * NMAX, (a + 1) * NMAX)),
        mH: new Float64Array(H.n), mO: new Float64Array(O.n),
      });
    };
    let sample = rivers, scale = 1 / 44;
    function terminal(n, trav, rH, rO, out) {
      const T = sides[trav], X = sides[1 - trav], r = trav === 0 ? rO : rH;
      const myIn = trav === 0 ? n.hIn : n.oIn;
      if (n.term === 'fold') {
        const heroGain = n.winner === 0 ? P0 + n.oIn : -n.hIn;
        foldValues(r, X, T, out, trav === 0 ? heroGain : P0 - heroGain);
        return;
      }
      const potF = P0 + n.hIn + n.oIn;
      out.fill(0, 0, T.n);
      if (multi) {
        const kap = kapAt(n.nb || 0);
        if (n.term === 'show') { showMulti(r, X, T, n.card, out, 1, potF, myIn, kap, trav); return; }
        for (let k = 0; k < sample.length; k++) showMulti(r, X, T, sample[k], out, scale, potF, myIn, kap, trav);
        return;
      }
      if (n.term === 'show') { showAdd(r, X, T, n.card, out, 1, potF, myIn); return; }
      for (let k = 0; k < sample.length; k++) showAdd(r, X, T, sample[k], out, scale, potF, myIn);
    }
    // Multiway (cfg.multi): the opponent is the field's strongest hand, and hero's share at a
    // showdown is scaled by kappa (hero's share against every live opponent over the share
    // against that hand) to the power rho^bets: each bet or raise on the way leaves only a
    // part of the other players in. The rest of the pot goes to the field.
    function kapAt(nb) {
      if (kapCache[nb]) return kapCache[nb];
      const e = Math.pow(multi.rho, nb), out = new Float64Array(H.n);
      for (let i = 0; i < H.n; i++) out[i] = Math.pow(clamp(multi.kappa[H.idx[i]] || 1, 0.05, 1.05), e);
      return (kapCache[nb] = out);
    }
    function showMulti(r, X, T, c, out, sc, potF, myIn, kap, trav) {
      if (trav === 0) {
        mtmp.fill(0, 0, T.n);
        showAdd(r, X, T, c, mtmp, 1, 1, 0);
        for (let i = 0; i < T.n; i++) out[i] += sc * potF * kap[i] * mtmp[i];
        showAdd(r, X, T, c, out, sc, 0, myIn);
        return;
      }
      for (let i = 0; i < X.n; i++) { mrA[i] = r[i] * kap[i]; mrB[i] = r[i] * (1 - kap[i]); }
      showAdd(mrA, X, T, c, out, sc, potF, 0);
      showAdd(mrB, X, T, c, out, sc, 0, -potF);
      showAdd(r, X, T, c, out, sc, 0, myIn);
    }
    function cfr(n, trav, rH, rO, avg, d, out) {
      if (n.term) { terminal(n, trav, rH, rO, out); return; }
      const T = sides[trav];
      const P = pool(d);
      if (n.chance) {
        out.fill(0, 0, T.n);
        for (const c of sample) {
          const vH = H.R[c].valid, vO = O.R[c].valid, mH = P.mH, mO = P.mO;
          for (let i = 0; i < H.n; i++) mH[i] = vH[i] ? rH[i] : 0;
          for (let i = 0; i < O.n; i++) mO[i] = vO[i] ? rO[i] : 0;
          if (!n.subs[c]) n.subs[c] = riverRoot(n, c);
          cfr(n.subs[c], trav, mH, mO, avg, d + 1, P.tmp);
          const vd = T.R[c].valid, tmp = P.tmp;
          for (let i = 0; i < T.n; i++) if (vd[i]) out[i] += scale * tmp[i];
        }
        return;
      }
      const nA = n.acts.length, N = sides[n.player].n, s = P.s, R2 = P.r2f, V = P.valf, M = NMAX;
      const reg = n.regret, sum = n.sum, fx = n.fixed;
      const base = n.player === 0 ? rH : rO;
      if (avg) {
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += sum[a * N + i];
          for (let a = 0; a < nA; a++) { const x = t > 0 ? sum[a * N + i] / t : 1 / nA; s[a * N + i] = x; R2[a * M + i] = base[i] * x; }
        }
      } else {
        const mix = n.player === 1, q1 = 1 - p, u = 1 / nA;
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) { const r = reg[a * N + i]; if (r > 0) t += r; }
          const inv = t > 0 ? 1 / t : 0;
          for (let a = 0; a < nA; a++) {
            const r = reg[a * N + i];
            let x = t > 0 ? (r > 0 ? r * inv : 0) : u;
            if (mix) x = p * fx[a * N + i] + q1 * x;
            s[a * N + i] = x;
            R2[a * M + i] = base[i] * x;
          }
        }
      }
      for (let a = 0; a < nA; a++) {
        if (n.player === 0) cfr(n.kids[a], trav, P.r2[a], rO, avg, d + 1, P.vals[a]);
        else cfr(n.kids[a], trav, rH, P.r2[a], avg, d + 1, P.vals[a]);
      }
      const NT = T.n;
      if (n.player !== trav) {
        for (let i = 0; i < NT; i++) { let v = 0; for (let a = 0; a < nA; a++) v += V[a * M + i]; out[i] = v; }
        return;
      }
      if (avg) {
        for (let i = 0; i < NT; i++) { let v = 0; for (let a = 0; a < nA; a++) v += s[a * N + i] * V[a * M + i]; out[i] = v; }
        if (d === 0) n.vals = P.vals.slice(0, nA).map((x) => Float64Array.from(x.subarray(0, NT)));
        return;
      }
      n.t++;
      const tt = n.t, pos = Math.pow(tt, 1.5) / (Math.pow(tt, 1.5) + 1), w = Math.pow(tt / (tt + 1), 2);
      for (let i = 0; i < NT; i++) {
        let v = 0;
        for (let a = 0; a < nA; a++) v += s[a * N + i] * V[a * M + i];
        out[i] = v;
        const b = base[i];
        for (let a = 0; a < nA; a++) {
          const j = a * N + i, r = reg[j];
          reg[j] = (r > 0 ? r * pos : r * 0.5) + V[a * M + i] - v;
          sum[j] = sum[j] * w + b * s[j];
        }
      }
    }

    const K = Math.min(rivers.length, cfg.riverSamples || 6);
    const rng = mulberry32((cfg.seed >>> 0) || 0x51ed270b);
    const iterations = cfg.iterations || TURN_ITERATIONS;
    const deadline = cfg.timeMs ? Date.now() + cfg.timeMs : Infinity;
    const outH = new Float64Array(H.n), outO = new Float64Array(O.n);
    let ran = 0;
    const deck = rivers.slice();
    for (let it = 1; it <= iterations; it++) {
      for (let i = 0; i < K; i++) { const j = i + Math.floor(rng() * (deck.length - i)); const x = deck[i]; deck[i] = deck[j]; deck[j] = x; }
      sample = deck.slice(0, K);
      scale = (rivers.length / K) / 44;
      cfr(root, 0, H.w, O.w, false, 0, outH);
      cfr(root, 1, H.w, O.w, false, 0, outO);
      ran = it;
      if (Date.now() > deadline) break;
    }
    // Final pass with average strategies over every river card.
    sample = rivers;
    scale = 1 / 44;
    cfr(root, 0, H.w, O.w, true, 0, outH);
    totals(O.w, O, H);
    const norm = tot[h0] > 0 ? tot[h0] : 1;
    let t = 0;
    for (let a = 0; a < root.acts.length; a++) t += root.sum[a * H.n + h0];
    return {
      iterations: ran, combos: [H.n, O.n], nodes,
      actions: root.acts.map((a, j) => ({
        kind: a.kind, amount: a.amount, frac: a.frac,
        freq: t > 0 ? root.sum[j * H.n + h0] / t : 1 / root.acts.length,
        ev: root.vals[j][h0] / norm,
      })),
    };
  }

  // ---------- Flop solver (computer only) ----------
  /*
   * The flop and the turn in one Discounted CFR, with the river checked down (no river
   * betting: the leaves after the turn's betting are showdowns averaged over sampled river
   * cards). Turn cards are chance-sampled per iteration (turn subgames built lazily, one per
   * line and card), river cards too. Hero and the opponent are indexed separately and pruned,
   * like the turn solver. Multiway (cfg.multi): the opponent is the field's hand with the most
   * flop equity and hero's showdown share is scaled by kappa^(rho^bets), as in turnSolve.
   */
  const FLOP_ITERATIONS = 400;
  function flopSolve(cfg) {
    const { board, heroCombo, heroW, oppW, oppStats, p, pot: P0, toCall, stack, heroFirst, heroIP, bigBlind } = cfg;
    const st3 = cfg.strengths3;
    const onBoard = new Uint8Array(52);
    board.forEach((c) => { onBoard[c] = 1; });
    const possible = (k) => !onBoard[COMBO_HI[k]] && !onBoard[COMBO_LO[k]];
    const turns = [];
    for (let c = 0; c < 52; c++) if (!onBoard[c]) turns.push(c);
    const buf = new Int32Array(7);
    for (let j = 0; j < 3; j++) buf[j] = board[j];

    function side(W, keepFrac, must) {
      let mx = 0;
      for (let k = 0; k < NUM_COMBOS; k++) if (possible(k) && W[k] > mx) mx = W[k];
      if (!(mx > 0)) return null;
      const idx = [];
      for (let k = 0; k < NUM_COMBOS; k++) if (possible(k) && (k === must || W[k] > keepFrac * mx)) idx.push(k);
      const n = idx.length, S = { idx, n, hi: new Uint8Array(n), lo: new Uint8Array(n), w: new Float64Array(n), local: new Int32Array(NUM_COMBOS).fill(-1), R: new Array(52 * 52), V: new Array(52) };
      idx.forEach((k, i) => { S.hi[i] = COMBO_HI[k]; S.lo[i] = COMBO_LO[k]; S.w[i] = Math.max(0, W[k]); S.local[k] = i; });
      for (const t of turns) {
        const v = new Uint8Array(n);
        for (let i = 0; i < n; i++) v[i] = S.hi[i] !== t && S.lo[i] !== t ? 1 : 0;
        S.V[t] = v;
      }
      return S;
    }
    const H = side(heroW, cfg.heroPrune != null ? cfg.heroPrune : 0.03, heroCombo), O = side(oppW, cfg.oppPrune != null ? cfg.oppPrune : 0.015, -1);
    if (!H || !O) return null;
    const h0 = H.local[heroCombo];
    if (h0 < 0) return null;
    let meanH = 0;
    for (let i = 0; i < H.n; i++) meanH += H.w[i];
    meanH /= H.n;
    H.w[h0] = Math.max(H.w[h0], 0.25 * meanH, 1e-6);
    H.cross = Int32Array.from(H.idx, (k) => O.local[k]);
    O.cross = Int32Array.from(O.idx, (k) => H.local[k]);
    const NMAX = Math.max(H.n, O.n);
    const sides = [H, O];
    const multi = cfg.multi && cfg.multi.kappa ? cfg.multi : null;
    const kapCache = {};
    // River betting at the end of the turn's lines (cfg.riverBet = bet as a share of the pot; off
    // when unset): instead of a plain check-down, the hand that is ahead bets with probability
    // b (by its river strength in its range) and the other calls with probability c, so strong
    // hands and made draws get paid. b and c per combo and board come from scoresFor.
    const RB = cfg.riverBet > 0 ? { beta: cfg.riverBet } : null;
    if (RB) {
      H.foldR = RB.beta / (1 + RB.beta);
      H.betCut = 0.6;
      O.foldR = clamp(foldAtSize(oppStats, RB.beta, 5), 0.05, 0.9);
      O.betCut = 1 - clamp(streetStats(oppStats, 5).betFreq, 0.15, 0.6);
    }
    const mtmp = multi ? new Float64Array(NMAX) : null, mrA = multi ? new Float64Array(H.n) : null, mrB = multi ? new Float64Array(H.n) : null;

    // Scores and showdown order on the board flop + t + r, for both sides (built when first needed).
    function scoresFor(S, key, t, r) {
      const n = S.n, score = new Int32Array(n), valid = new Uint8Array(n), list = [];
      for (let i = 0; i < n; i++) {
        const a = S.hi[i], b = S.lo[i];
        if (a === t || b === t || a === r || b === r) continue;
        score[i] = scoreHole(a, b);
        valid[i] = 1;
        list.push(i);
      }
      list.sort((x, y) => score[x] - score[y]);
      const R = { score, valid, order: Int32Array.from(list) };
      if (RB) {
        // Call and bet probabilities by strength in the side's range on this board (ties share).
        const c = new Float32Array(n), bt = new Float32Array(n);
        let W = 0;
        for (const i of list) W += S.w[i];
        let g = 0, cumW = 0;
        while (g < list.length) {
          let e = g, w = 0;
          const s0 = score[list[g]];
          while (e < list.length && score[list[e]] === s0) { w += S.w[list[e]]; e++; }
          const q = W > 0 ? (cumW + w / 2) / W : (g + e) / 2 / list.length;
          const cc = sigmoid((q - S.foldR) / 0.06), bb = sigmoid((q - S.betCut) / 0.06);
          for (let j = g; j < e; j++) { c[list[j]] = cc; bt[list[j]] = bb; }
          cumW += w;
          g = e;
        }
        R.c = c;
        R.b = bt;
      }
      S.R[key] = R;
    }
    function pairKey(t, r) {
      const key = t * 52 + r;
      if (!H.R[key]) {
        buf[3] = t; buf[4] = r;
        setBoard(buf, 5);
        scoresFor(H, key, t, r);
        scoresFor(O, key, t, r);
      }
      return key;
    }

    const tot = new Float64Array(NMAX);
    const cum = new Float64Array(52), grp = new Float64Array(52), all = new Float64Array(52);
    function showAdd(r, X, T, key, out, sc, potF, myIn) {
      const RX = X.R[key], RT = T.R[key];
      const oo = RX.order, os = RX.score, xv = RX.valid, to = RT.order, ts = RT.score;
      const xh = X.hi, xl = X.lo, th = T.hi, tl = T.lo, cross = T.cross;
      const no = oo.length, nt = to.length;
      cum.fill(0); all.fill(0);
      let tt = 0;
      for (let j = 0; j < no; j++) { const i = oo[j], x = r[i]; tt += x; all[xh[i]] += x; all[xl[i]] += x; }
      let a = 0, b = 0, cT = 0;
      while (b < nt) {
        const s = ts[to[b]];
        while (a < no && os[oo[a]] < s) { const i = oo[a], x = r[i]; cT += x; cum[xh[i]] += x; cum[xl[i]] += x; a++; }
        let a2 = a, gT = 0;
        while (a2 < no && os[oo[a2]] === s) { const i = oo[a2], x = r[i]; gT += x; grp[xh[i]] += x; grp[xl[i]] += x; a2++; }
        while (b < nt && ts[to[b]] === s) {
          const i = to[b], h = th[i], l = tl[i], ci = cross[i], same = ci >= 0 && xv[ci] ? r[ci] : 0;
          out[i] += sc * (potF * ((cT - cum[h] - cum[l]) + (gT - grp[h] - grp[l] + same) / 2) - myIn * (tt - all[h] - all[l] + same));
          b++;
        }
        for (let j = a; j < a2; j++) { const i = oo[j]; grp[xh[i]] = 0; grp[xl[i]] = 0; }
      }
    }
    // River bets of size B (see RB) for traverser T: when ahead it bets with its b and X calls with
    // X's c; when behind X bets with X's b and T calls with its c. win/lose scale the two parts
    // (wk: per-combo factor on the win part, for multiway).
    const cumC = new Float64Array(52), cumB = new Float64Array(52), grpB = new Float64Array(52), allB = new Float64Array(52);
    function riverExtra(r, X, T, key, out, sc, win, lose, wk) {
      const RX = X.R[key], RT = T.R[key];
      const oo = RX.order, os = RX.score, to = RT.order, ts = RT.score;
      const xc = RX.c, xb = RX.b, tc = RT.c, tb = RT.b;
      const xh = X.hi, xl = X.lo, th = T.hi, tl = T.lo;
      const no = oo.length, nt = to.length;
      cumC.fill(0); cumB.fill(0); allB.fill(0);
      let tB = 0;
      for (let j = 0; j < no; j++) { const i = oo[j], x = r[i] * xb[i]; tB += x; allB[xh[i]] += x; allB[xl[i]] += x; }
      let a = 0, b = 0, cC = 0, cB = 0;
      while (b < nt) {
        const s0 = ts[to[b]];
        while (a < no && os[oo[a]] < s0) {
          const i = oo[a], x = r[i], y = x * xc[i], z = x * xb[i];
          cC += y; cumC[xh[i]] += y; cumC[xl[i]] += y;
          cB += z; cumB[xh[i]] += z; cumB[xl[i]] += z;
          a++;
        }
        let a2 = a, gB = 0;
        while (a2 < no && os[oo[a2]] === s0) { const i = oo[a2], z = r[i] * xb[i]; gB += z; grpB[xh[i]] += z; grpB[xl[i]] += z; a2++; }
        while (b < nt && ts[to[b]] === s0) {
          const i = to[b], h = th[i], l = tl[i];
          const below = cC - cumC[h] - cumC[l];
          const above = tB - allB[h] - allB[l] - (cB - cumB[h] - cumB[l]) - (gB - grpB[h] - grpB[l]);
          out[i] += sc * ((wk ? win * wk[i] : win) * tb[i] * below - lose * tc[i] * above);
          b++;
        }
        for (let j = a; j < a2; j++) { const i = oo[j]; grpB[xh[i]] = 0; grpB[xl[i]] = 0; }
      }
    }
    function riverBets(r, X, T, key, out, sc, B, kap, trav) {
      if (!kap) { riverExtra(r, X, T, key, out, sc, B, B, null); return; }
      // Multiway: hero only wins the bet when it also beats the others (kap); the field loses
      // it to hero only then.
      if (trav === 0) { riverExtra(r, X, T, key, out, sc, B, B, kap); return; }
      for (let i = 0; i < X.n; i++) mrA[i] = r[i] * kap[i];
      riverExtra(r, X, T, key, out, sc, B, 0, null);
      riverExtra(mrA, X, T, key, out, sc, 0, B, null);
    }
    function kapAt(nb) {
      if (kapCache[nb]) return kapCache[nb];
      const e = Math.pow(multi.rho, nb), out = new Float64Array(H.n);
      for (let i = 0; i < H.n; i++) out[i] = Math.pow(clamp(multi.kappa[H.idx[i]] || 1, 0.05, 1.05), e);
      return (kapCache[nb] = out);
    }
    function show(r, X, T, key, out, sc, potF, myIn, kap, trav) {
      if (!kap) { showAdd(r, X, T, key, out, sc, potF, myIn); return; }
      if (trav === 0) {
        mtmp.fill(0, 0, T.n);
        showAdd(r, X, T, key, mtmp, 1, 1, 0);
        for (let i = 0; i < T.n; i++) out[i] += sc * potF * kap[i] * mtmp[i];
        showAdd(r, X, T, key, out, sc, 0, myIn);
        return;
      }
      for (let i = 0; i < X.n; i++) { mrA[i] = r[i] * kap[i]; mrB[i] = r[i] * (1 - kap[i]); }
      showAdd(mrA, X, T, key, out, sc, potF, 0);
      showAdd(mrB, X, T, key, out, sc, 0, -potF);
      showAdd(r, X, T, key, out, sc, 0, myIn);
    }
    function totals(r, X, T) {
      all.fill(0);
      let tt = 0;
      for (let i = 0; i < X.n; i++) { const x = r[i]; tt += x; all[X.hi[i]] += x; all[X.lo[i]] += x; }
      for (let i = 0; i < T.n; i++) tot[i] = tt - all[T.hi[i]] - all[T.lo[i]] + (T.cross[i] >= 0 ? r[T.cross[i]] : 0);
    }
    function foldValues(r, X, T, out, g) {
      all.fill(0);
      let tt = 0;
      const xh = X.hi, xl = X.lo, th = T.hi, tl = T.lo, cross = T.cross, nx = X.n, nt = T.n;
      for (let i = 0; i < nx; i++) { const x = r[i]; tt += x; all[xh[i]] += x; all[xl[i]] += x; }
      for (let i = 0; i < nt; i++) { const ci = cross[i]; out[i] = g * (tt - all[th[i]] - all[tl[i]] + (ci >= 0 ? r[ci] : 0)); }
    }

    // ----- the read's strategy for the opponent -----
    const round = (x) => roundChips(x, bigBlind);
    const betFrac = clamp(oppStats.betSize || 0.6, 0.33, 1);
    const qFlop = new Float64Array(O.n);
    {
      const q = rangeQuantiles(oppW, st3.ehs);
      for (let i = 0; i < O.n; i++) qFlop[i] = q[O.idx[i]];
    }
    // The opponent's hand strength on a turn card: its average showdown rank (among their
    // hands) over a fixed set of river cards, so draws count. Quantiles inside reach fr.
    const tStrength = new Array(52);
    function turnStrength(t) {
      if (tStrength[t]) return tStrength[t];
      const s = new Float64Array(O.n), rv = turns.filter((c) => c !== t), step = Math.max(1, Math.floor(rv.length / 12));
      let m = 0;
      for (let j = (t * 7) % step; j < rv.length; j += step) {
        const key = pairKey(t, rv[j]), ord = O.R[key].order, len = ord.length;
        for (let g = 0; g < len; g++) s[ord[g]] += (g + 0.5) / len;
        m++;
      }
      for (let i = 0; i < O.n; i++) s[i] /= Math.max(1, m);
      return (tStrength[t] = s);
    }
    function turnQuantiles(fr, t) {
      const st = turnStrength(t), v = O.V[t], ids = [], q = new Float64Array(O.n);
      let T = 0;
      for (let i = 0; i < O.n; i++) if (v[i]) { ids.push(i); T += fr[i]; }
      ids.sort((a, b) => st[a] - st[b]);
      if (!(T > 0)) { ids.forEach((i, j) => { q[i] = (j + 0.5) / ids.length; }); return q; }
      let c = 0;
      for (const i of ids) { q[i] = (c + fr[i] / 2) / T; c += fr[i]; }
      return q;
    }
    function fixedStrategy(acts, facingFrac, vsRaise, rootRaise, q, n5, aggS) {
      const st = streetStats(oppStats, n5);
      const bf = clamp(st.betFreq, 0.05, 0.9), vr = valueShare(oppStats, betFrac);
      const N = O.n, nA = acts.length, s = new Float32Array(nA * N), pr = new Float64Array(nA);
      const hasRaise = facingFrac != null && acts.some((a) => !a.isCall && a.kind !== 'fold');
      const foldQ = facingFrac == null ? 0 : aggS * foldAtSize(oppStats, facingFrac, n5);
      const rq = 1 - clamp(st.raiseFreq, 0.02, 0.3);
      for (let i = 0; i < N; i++) {
        const qi = q[i];
        if (facingFrac == null) {
          const a = sigmoid((qi - (1 - bf * vr)) / 0.035);
          const pBet = a + (1 - a) * sigmoid((bf * (1 - vr) - qi) / 0.035);
          const nBets = Math.max(1, nA - 1);
          for (let j = 0; j < nA; j++) pr[j] = acts[j].kind === 'check' ? 1 - pBet : pBet / nBets;
        } else {
          let pCont;
          if (rootRaise) pCont = sigmoid((qi - 0.9 * (1 - vr)) / 0.04);
          else if (vsRaise) pCont = qi >= 1 - bf * vr ? 1 : qi < bf * (1 - vr) ? 0.1 : 0.5;
          else pCont = sigmoid((qi - foldQ) / 0.04);
          const pRaise = sigmoid((qi - rq) / 0.03);
          for (let j = 0; j < nA; j++) {
            const a = acts[j];
            if (a.kind === 'fold') pr[j] = 1 - pCont;
            else if (a.isCall) pr[j] = pCont * (hasRaise ? 1 - pRaise : 1);
            else pr[j] = pCont * pRaise;
          }
        }
        let t = 0;
        for (let j = 0; j < nA; j++) t += pr[j];
        for (let j = 0; j < nA; j++) s[j * N + i] = t > 0 ? pr[j] / t : 1 / nA;
      }
      return s;
    }
    const aggAlways = cfg.aggScale || 1, aggIfBet = cfg.aggScaleIfAgg || 1;

    // ----- tree -----
    const maxIn = (pl) => (pl === 0 ? stack : Math.max(0, stack - toCall));
    const flopBets = (cfg.flopBets || [0.33, 0.75]).slice(0, 3), turnBets = (cfg.turnBets || [0.5, 1]).slice(0, 3);
    let nodes = 0;
    function makeNode(n5, card, player, hIn, oIn, facing, raisesLeft, lastToAct, vsRaise, fr, oppAgg, q, nb) {
      nodes++;
      const potNow = P0 + hIn + oIn;
      const myIn = player === 0 ? hIn : oIn;
      const left = maxIn(player) - myIn;
      const acts = [], kids = [];
      const add = (a, k) => { if (!acts.some((x) => x.kind === a.kind && Math.abs(x.amount - a.amount) < 1e-9)) { acts.push(a); kids.push(k); } };
      const after = (amt) => (player === 0 ? [hIn + amt, oIn] : [hIn, oIn + amt]);
      const close = (h, o, frc, agg, nb2) => {
        if (n5 === 4) return { term: 'show', card, hIn: h, oIn: o, nb: nb2 };
        if (h >= maxIn(0) - 1e-9 || o >= maxIn(1) - 1e-9) return { term: 'allin', hIn: h, oIn: o, nb: nb2 };
        return { chance: true, hIn: h, oIn: o, fr: frc, oppAgg: agg, subs: new Array(52), nb: nb2 };
      };
      if (facing > 0) {
        add({ kind: 'fold', amount: 0 }, { term: 'fold', winner: 1 - player, hIn, oIn });
        const c = Math.min(facing, left);
        const [h2, o2] = after(c);
        add({ kind: c >= left - 1e-9 ? 'allin' : 'call', amount: c, isCall: true }, (frc) => close(h2, o2, frc, oppAgg, nb));
        if (raisesLeft > 0 && left > facing + 1e-9) {
          const r = Math.min(left, round(facing + (potNow + facing)));
          const [h3, o3] = after(r);
          add({ kind: r >= left - 1e-9 ? 'allin' : 'raise', amount: r, frac: (r - facing) / (potNow + facing) },
            (frc) => makeNode(n5, card, 1 - player, h3, o3, r - facing, raisesLeft - 1, true, true, frc, oppAgg || player === 1, q, nb + 1));
        }
      } else {
        add({ kind: 'check', amount: 0 }, (frc) => (lastToAct ? close(hIn, oIn, frc, oppAgg, nb) : makeNode(n5, card, 1 - player, hIn, oIn, 0, raisesLeft, true, false, frc, oppAgg, q, nb)));
        const fracs = player === 0 ? (n5 === 3 ? flopBets : turnBets) : [betFrac];
        for (const f of fracs) {
          const b = Math.min(left, round(f * potNow));
          if (b <= 0) continue;
          const [h2, o2] = after(b);
          add({ kind: b >= left - 1e-9 ? 'allin' : 'bet', amount: b, frac: b / potNow },
            (frc) => makeNode(n5, card, 1 - player, h2, o2, b, raisesLeft, true, false, frc, oppAgg || player === 1, q, nb + 1));
        }
      }
      const N = sides[player].n;
      const n = { player, acts, hIn, oIn, n5, card, t: 0 };
      n.regret = new Float32Array(acts.length * N);
      n.sum = new Float32Array(acts.length * N);
      if (player === 1) {
        const aggS = n5 === 3 ? aggAlways : (oppAgg ? aggIfBet : aggAlways);
        const rootRaise = !!vsRaise && n5 === 3 && toCall > 0 && oIn === 0;
        n.fixed = fixedStrategy(acts, facing > 0 ? facing / (potNow - facing) : null, !!vsRaise, rootRaise, q, n5, aggS);
        n.kids = kids.map((k, j) => {
          if (typeof k !== 'function') return k;
          const f2 = new Float64Array(N);
          for (let i = 0; i < N; i++) f2[i] = fr[i] * n.fixed[j * N + i];
          return k(f2);
        });
      } else n.kids = kids.map((k) => (typeof k === 'function' ? k(fr) : k));
      return n;
    }
    function turnRoot(ch, t) {
      const q = turnQuantiles(ch.fr, t);
      return makeNode(4, t, heroIP ? 1 : 0, ch.hIn, ch.oIn, 0, 1, false, false, ch.fr, ch.oppAgg, q, ch.nb);
    }
    const fr0 = Float64Array.from(O.w);
    const root = toCall > 0
      ? makeNode(3, -1, 0, 0, 0, toCall, 1, true, false, fr0, false, qFlop, 1)
      : makeNode(3, -1, 0, 0, 0, 0, 1, !heroFirst, false, fr0, false, qFlop, 0);

    // ----- Discounted CFR with chance-sampled turn and river cards -----
    const pools = [];
    const pool = (d) => {
      if (pools[d]) return pools[d];
      const r2f = new Float64Array(4 * NMAX), valf = new Float64Array(4 * NMAX);
      return (pools[d] = {
        s: new Float64Array(4 * NMAX), tmp: new Float64Array(NMAX), r2f, valf,
        r2: [0, 1, 2, 3].map((a) => r2f.subarray(a * NMAX, (a + 1) * NMAX)),
        vals: [0, 1, 2, 3].map((a) => valf.subarray(a * NMAX, (a + 1) * NMAX)),
        mH: new Float64Array(H.n), mO: new Float64Array(O.n),
      });
    };
    // Training samples a few turn and river cards per iteration (disjoint, so every river differs
    // from every turn card); the final pass uses every turn card and finalR[t] rivers for each.
    let sampleT = turns, sampleR = turns, scaleT = 1 / 45, scaleR = 1 / 44, finalR = null;
    const riversFor = (t) => (finalR ? finalR[t] : sampleR);
    function terminal(n, trav, rH, rO, out) {
      const T = sides[trav], X = sides[1 - trav], r = trav === 0 ? rO : rH;
      const myIn = trav === 0 ? n.hIn : n.oIn;
      if (n.term === 'fold') {
        const heroGain = n.winner === 0 ? P0 + n.oIn : -n.hIn;
        foldValues(r, X, T, out, trav === 0 ? heroGain : P0 - heroGain);
        return;
      }
      const potF = P0 + n.hIn + n.oIn;
      const kap = multi ? kapAt(n.nb || 0) : null;
      out.fill(0, 0, T.n);
      if (n.term === 'show') {
        const L = RB ? Math.min(maxIn(0) - n.hIn, maxIn(1) - n.oIn) : 0;
        const B = L > 0 ? Math.min(L, RB.beta * potF) : 0;
        const kap2 = B > 0 && multi ? kapAt((n.nb || 0) + 1) : null;
        for (const rc of riversFor(n.card)) {
          const key = pairKey(n.card, rc);
          show(r, X, T, key, out, scaleR, potF, myIn, kap, trav);
          if (B > 0) riverBets(r, X, T, key, out, scaleR, B, kap2, trav);
        }
        return;
      }
      // All-in on the flop: both cards to come.
      for (const t of sampleT) for (const rc of riversFor(t)) show(r, X, T, pairKey(t, rc), out, scaleT * scaleR, potF, myIn, kap, trav);
    }
    function cfr(n, trav, rH, rO, avg, d, out) {
      if (n.term) { terminal(n, trav, rH, rO, out); return; }
      const T = sides[trav];
      const P = pool(d);
      if (n.chance) {
        out.fill(0, 0, T.n);
        for (const t of sampleT) {
          const vH = H.V[t], vO = O.V[t], mH = P.mH, mO = P.mO;
          for (let i = 0; i < H.n; i++) mH[i] = vH[i] ? rH[i] : 0;
          for (let i = 0; i < O.n; i++) mO[i] = vO[i] ? rO[i] : 0;
          if (!n.subs[t]) n.subs[t] = turnRoot(n, t);
          cfr(n.subs[t], trav, mH, mO, avg, d + 1, P.tmp);
          const vd = T.V[t], tmp = P.tmp;
          for (let i = 0; i < T.n; i++) if (vd[i]) out[i] += scaleT * tmp[i];
        }
        return;
      }
      const nA = n.acts.length, N = sides[n.player].n, s = P.s, R2 = P.r2f, V = P.valf, M = NMAX;
      const reg = n.regret, sum = n.sum, fx = n.fixed;
      const base = n.player === 0 ? rH : rO;
      if (avg) {
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += sum[a * N + i];
          for (let a = 0; a < nA; a++) { const x = t > 0 ? sum[a * N + i] / t : 1 / nA; s[a * N + i] = x; R2[a * M + i] = base[i] * x; }
        }
      } else {
        const mix = n.player === 1, q1 = 1 - p, u = 1 / nA;
        for (let i = 0; i < N; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) { const r = reg[a * N + i]; if (r > 0) t += r; }
          const inv = t > 0 ? 1 / t : 0;
          for (let a = 0; a < nA; a++) {
            const r = reg[a * N + i];
            let x = t > 0 ? (r > 0 ? r * inv : 0) : u;
            if (mix) x = p * fx[a * N + i] + q1 * x;
            s[a * N + i] = x;
            R2[a * M + i] = base[i] * x;
          }
        }
      }
      for (let a = 0; a < nA; a++) {
        if (n.player === 0) cfr(n.kids[a], trav, P.r2[a], rO, avg, d + 1, P.vals[a]);
        else cfr(n.kids[a], trav, rH, P.r2[a], avg, d + 1, P.vals[a]);
      }
      const NT = T.n;
      if (n.player !== trav) {
        for (let i = 0; i < NT; i++) { let v = 0; for (let a = 0; a < nA; a++) v += V[a * M + i]; out[i] = v; }
        return;
      }
      if (avg) {
        for (let i = 0; i < NT; i++) { let v = 0; for (let a = 0; a < nA; a++) v += s[a * N + i] * V[a * M + i]; out[i] = v; }
        if (d === 0) n.vals = P.vals.slice(0, nA).map((x) => Float64Array.from(x.subarray(0, NT)));
        return;
      }
      n.t++;
      const tt = n.t, pos = Math.pow(tt, 1.5) / (Math.pow(tt, 1.5) + 1), w = Math.pow(tt / (tt + 1), 2);
      for (let i = 0; i < NT; i++) {
        let v = 0;
        for (let a = 0; a < nA; a++) v += s[a * N + i] * V[a * M + i];
        out[i] = v;
        const b = base[i];
        for (let a = 0; a < nA; a++) {
          const j = a * N + i, r = reg[j];
          reg[j] = (r > 0 ? r * pos : r * 0.5) + V[a * M + i] - v;
          sum[j] = sum[j] * w + b * s[j];
        }
      }
    }

    const KT = Math.min(turns.length - 1, cfg.turnSamples || 3), KR = Math.min(turns.length - KT, cfg.riverSamples || 4);
    const rng = mulberry32((cfg.seed >>> 0) || 0x2f6b9e41);
    const iterations = cfg.iterations || FLOP_ITERATIONS;
    const deadline = cfg.timeMs ? Date.now() + cfg.timeMs : Infinity;
    const outH = new Float64Array(H.n), outO = new Float64Array(O.n);
    const deck = turns.slice();
    const shuffle = (k) => { for (let i = 0; i < k; i++) { const j = i + Math.floor(rng() * (deck.length - i)); const x = deck[i]; deck[i] = deck[j]; deck[j] = x; } };
    let ran = 0;
    for (let it = 1; it <= iterations; it++) {
      shuffle(KT + KR);
      sampleT = deck.slice(0, KT);
      sampleR = deck.slice(KT, KT + KR);
      scaleT = (turns.length / KT) / 45;
      scaleR = ((turns.length - 1) / KR) / 44;
      cfr(root, 0, H.w, O.w, false, 0, outH);
      cfr(root, 1, H.w, O.w, false, 0, outO);
      ran = it;
      if (Date.now() > deadline) break;
    }
    // Final pass with average strategies: every turn card, KF river cards for each.
    const KF = Math.min(turns.length - 2, cfg.finalRivers || 10);
    shuffle(KF + 1);
    finalR = new Array(52);
    for (const t of turns) finalR[t] = deck.slice(0, KF + 1).filter((c) => c !== t).slice(0, KF);
    sampleT = turns;
    scaleT = 1 / 45;
    scaleR = ((turns.length - 1) / KF) / 44;
    cfr(root, 0, H.w, O.w, true, 0, outH);
    totals(O.w, O, H);
    const norm = tot[h0] > 0 ? tot[h0] : 1;
    let t = 0;
    for (let a = 0; a < root.acts.length; a++) t += root.sum[a * H.n + h0];
    return {
      iterations: ran, combos: [H.n, O.n], nodes,
      actions: root.acts.map((a, j) => ({
        kind: a.kind, amount: a.amount, frac: a.frac,
        freq: t > 0 ? root.sum[j * H.n + h0] / t : 1 / root.acts.length,
        ev: root.vals[j][h0] / norm,
      })),
    };
  }

  // ---------- Preflop solver ----------
  /*
   * Preflop spots get a range-vs-range solve over the 169 starting-hand classes with
   * Discounted CFR, like the river solver. The tree has hero's sizes at the root, then
   * pot-size raises and all-ins (up to four raises in all). Leaves are folds, all-ins (all-in
   * equity from the table above) and calls that see a flop, where each side's equity is
   * scaled by how well its hand plays (position, suitedness, connectedness, pairs; less with
   * short stacks) and the pot is split by those realized shares. The opponent plays the
   * read's strategy with weight p and an adaptive one with the rest. When several players
   * are still to act behind an open, they are solved as one "field" whose hand is the
   * strongest of theirs (it folds only when all of them would).
   */
  const PREFLOP_ITERATIONS = 300;
  let PF_COMPAT = null;
  // Number of (combo of class a, combo of class b) pairs that don't share a card.
  function preflopCompat() {
    if (PF_COMPAT) return PF_COMPAT;
    const C = new Float64Array(169 * 169);
    for (let x = 0; x < NUM_COMBOS; x++) {
      const x1 = COMBO_HI[x], x2 = COMBO_LO[x], row = COMBO_CLASS[x] * 169;
      for (let y = 0; y < NUM_COMBOS; y++) {
        const y1 = COMBO_HI[y], y2 = COMBO_LO[y];
        if (x1 === y1 || x1 === y2 || x2 === y1 || x2 === y2) continue;
        C[row + COMBO_CLASS[y]]++;
      }
    }
    PF_COMPAT = C;
    return C;
  }
  // Ranks of each class and how many of its combos hold one given card of a rank, for
  // blocker-aware totals in O(169): mass[a] = |a| * (T - P[r1] - P[r2] + w[a]).
  const CLASS_R1 = new Uint8Array(169), CLASS_R2 = new Uint8Array(169), CLASS_PER_CARD = new Uint8Array(169);
  for (let c = 0; c < 169; c++) {
    const row = Math.floor(c / 13), col = c % 13;
    CLASS_R1[c] = 12 - Math.min(row, col); CLASS_R2[c] = 12 - Math.max(row, col);
    CLASS_PER_CARD[c] = row === col ? 3 : row < col ? 1 : 3;
  }
  const PF_P = new Float64Array(13);
  function classMass(r, out, g) {
    PF_P.fill(0);
    let T = 0;
    for (let b = 0; b < 169; b++) {
      const w = r[b];
      if (w === 0) continue;
      T += CLASS_COMBO_COUNT[b] * w;
      const m = CLASS_PER_CARD[b] * w;
      PF_P[CLASS_R1[b]] += m;
      if (CLASS_R2[b] !== CLASS_R1[b]) PF_P[CLASS_R2[b]] += m;
    }
    for (let a = 0; a < 169; a++) out[a] = g * CLASS_COMBO_COUNT[a] * (T - PF_P[CLASS_R1[a]] - PF_P[CLASS_R2[a]] + r[a]);
    return out;
  }
  let PF_MEQ = null;
  // How well each class plays after the flop, before position and stack depth.
  const CLASS_PLAY = (() => {
    const out = new Float64Array(169);
    for (let c = 0; c < 169; c++) {
      const row = Math.floor(c / 13), col = c % 13;
      const pair = row === col, suited = row < col, gap = Math.abs(row - col);
      let play = 0;
      if (suited) play += 0.04;
      if (pair) play += 0.02;
      else if (gap <= 2) play += 0.02;
      else if (gap >= 4 && !suited) play -= 0.04;
      out[c] = play;
    }
    return out;
  })();
  function classQuantiles(w) {
    const order = Array.from({ length: 169 }, (_, c) => c).sort((a, b) => CLASS_STRENGTH[a] - CLASS_STRENGTH[b]);
    let tot = 0;
    for (let c = 0; c < 169; c++) tot += w[c] * CLASS_COMBO_COUNT[c];
    const q = new Float64Array(169);
    let cum = 0;
    for (const c of order) {
      const m = w[c] * CLASS_COMBO_COUNT[c];
      q[c] = tot > 0 ? (cum + m / 2) / tot : CLASS_STRENGTH[c];
      cum += m;
    }
    return q;
  }
  // The field's hand when several players are still to act: the strongest hand among the
  // players who continue (player i continues with the top conts[i] of their range), or, when
  // nobody would, the strongest hand overall. As class weights, by preflop order.
  function fieldMax(ws, conts) {
    const order = Array.from({ length: 169 }, (_, c) => c).sort((a, b) => CLASS_STRENGTH[a] - CLASS_STRENGTH[b]);
    const tots = ws.map((w) => { let t = 0; for (let c = 0; c < 169; c++) t += w[c] * CLASS_COMBO_COUNT[c]; return t || 1; });
    const cums = ws.map(() => 0);
    const keep = ws.map((w, i) => 1 - clamp(conts ? conts[i] : 1, 0, 1));
    const foldAll = keep.reduce((a, x) => a * x, 1);
    const out = new Float64Array(169);
    let prev = 0;
    for (const c of order) {
      let all = 1, cont = 1;
      for (let i = 0; i < ws.length; i++) {
        cums[i] += ws[i][c] * CLASS_COMBO_COUNT[c];
        const F = Math.min(1, cums[i] / tots[i]);
        all *= F; cont *= Math.max(F, keep[i]);
      }
      const cdf = all < foldAll ? all : cont;
      out[c] = Math.max(0, cdf - prev) / CLASS_COMBO_COUNT[c];
      prev = Math.max(prev, cdf);
    }
    return out;
  }
  function classWeights(W) {
    const cw = new Float64Array(169);
    for (let k = 0; k < NUM_COMBOS; k++) if (W[k] > cw[COMBO_CLASS[k]]) cw[COMBO_CLASS[k]] = W[k];
    return cw;
  }

  // Multiway inputs for preflopSolve: K opponents, how many are in at the flop after hero's call
  // (kCall) or first raise (kRaise(amount)), and kappa per hero class: hero's K-way pot share at
  // showdown over hero's share against the field's strongest hand (the hand the solver plays
  // against). Both come from the same sampled boards and opponent hands, so the ratio is steady.
  function preflopMulti(opps, scenarios, raisesSc, capE, toCall, samples, seed) {
    const NC = 169, K = opps.length;
    const rng = mulberry32((seed ^ 0x3c6ef372) >>> 0);
    const cdfs = opps.map((o) => {
      const c = new Float64Array(NUM_COMBOS);
      let t = 0;
      for (let k = 0; k < NUM_COMBOS; k++) { t += Math.max(0, o.W[k]); c[k] = t; }
      return t > 0 ? c : null;
    });
    const pick = (c) => {
      const u = rng() * c[NUM_COMBOS - 1];
      let lo = 0, hi = NUM_COMBOS - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < u) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const byClass = Array.from({ length: NC }, () => []);
    for (let k = 0; k < NUM_COMBOS; k++) byClass[COMBO_CLASS[k]].push(k);
    const multi = new Float64Array(NC), vsMax = new Float64Array(NC);
    const used = new Uint8Array(52), buf = new Int32Array(7), oScore = new Int32Array(K), oHand = new Int32Array(K);
    let got = 0;
    for (let it = 0; it < samples * 4 && got < samples; it++) {
      used.fill(0);
      let ok = cdfs.every(Boolean);
      for (let i = 0; i < K && ok; i++) {
        const k = pick(cdfs[i]);
        if (used[COMBO_HI[k]] || used[COMBO_LO[k]]) { ok = false; break; }
        used[COMBO_HI[k]] = used[COMBO_LO[k]] = 1;
        oHand[i] = k;
      }
      if (!ok) continue;
      for (let j = 0; j < 5; j++) {
        let c;
        do { c = Math.floor(rng() * 52); } while (used[c]);
        used[c] = 2;
        buf[j] = c;
      }
      let best = -1, top = 0;
      for (let i = 0; i < K; i++) {
        buf[5] = COMBO_HI[oHand[i]]; buf[6] = COMBO_LO[oHand[i]];
        oScore[i] = evaluate(buf, 7);
        if (oScore[i] > best) best = oScore[i];
        if (CLASS_STRENGTH[COMBO_CLASS[oHand[i]]] > CLASS_STRENGTH[COMBO_CLASS[oHand[top]]]) top = i;
      }
      let ties = 0;
      for (let i = 0; i < K; i++) if (oScore[i] === best) ties++;
      got++;
      for (let a = 0; a < NC; a++) {
        const list = byClass[a];
        let k = -1;
        for (let t = 0, start = Math.floor(rng() * list.length); t < list.length; t++) {
          const x = list[(start + t) % list.length];
          if (!used[COMBO_HI[x]] && !used[COMBO_LO[x]]) { k = x; break; }
        }
        if (k < 0) continue;
        buf[5] = COMBO_HI[k]; buf[6] = COMBO_LO[k];
        const h = evaluate(buf, 7);
        multi[a] += h > best ? 1 : h === best ? 1 / (ties + 1) : 0;
        vsMax[a] += h > oScore[top] ? 1 : h === oScore[top] ? 0.5 : 0;
      }
    }
    if (got < 20) return null;
    const kappa = new Float64Array(NC);
    for (let a = 0; a < NC; a++) kappa[a] = clamp((multi[a] + 0.5) / (vsMax[a] + 0.5), 0.15, 1.05);
    const passive = scenarios.find((s) => s.kind !== 'fold' && s.amount <= toCall + 1e-9);
    let kCall = 0;
    opps.forEach((o, i) => { kCall += o.pending && passive ? clamp(passive.opp[i].cont, 0, 1) : 1; });
    const kRaise = (amt) => {
      const sc = raisesSc.find((s) => Math.abs(capE(s.amount) - amt) < 1e-9);
      if (!sc) return 1;
      let sum = 0, none = 1;
      for (const r of sc.opp) { const c = clamp(r.cont, 0, 1); sum += c; none *= 1 - c; }
      return none < 1 ? Math.max(1, sum / (1 - none)) : 1;
    };
    return { K, kappa, kCall: Math.max(1, kCall), kRaise, samples: got };
  }

  function preflopSolve(cfg) {
    const { heroW, oppW, heroClass, pot: P0, toCall, stack: E, bigBlind, heroIP, rootActs, option, p } = cfg;
    const NC = 169;
    const EQ = preflopEquityTable(), M = preflopCompat();
    // Compatible-pair counts times all-in equity, and below times realized share.
    if (!PF_MEQ) { PF_MEQ = new Float32Array(NC * NC); for (let j = 0; j < NC * NC; j++) PF_MEQ[j] = M[j] * EQ[j]; }
    const MEQ = PF_MEQ;
    const qO = classQuantiles(oppW);
    const oMax = Math.max(0, E - toCall);
    const round = (x) => roundChips(x, bigBlind);

    // Realized pot shares at a flop with stack-to-pot ratio spr (cached by depth).
    const shareCache = {};
    function shares(spr) {
      const t = clamp(spr / 4, 0.15, 1), deep = spr > 10 ? 1.4 : 1;
      const key = Math.round(t * 20) + (deep > 1 ? 'd' : '');
      if (shareCache[key]) return shareCache[key];
      const R = (c, pos) => 1 + t * (0.92 + 0.16 * (CLASS_STRENGTH[c] - 0.5) + deep * CLASS_PLAY[c] + 0.06 * pos - 1);
      const Rh = new Float64Array(NC), Rv = new Float64Array(NC);
      for (let c = 0; c < NC; c++) { Rh[c] = R(c, heroIP ? 1 : -1); Rv[c] = R(c, heroIP ? -1 : 1); }
      const S = new Float32Array(NC * NC);
      for (let a = 0; a < NC; a++) {
        for (let b = 0; b < NC; b++) {
          const e = EQ[a * NC + b], x = e * Rh[a], y = (1 - e) * Rv[b];
          S[a * NC + b] = M[a * NC + b] * (x + y > 0 ? x / (x + y) : e);
        }
      }
      return (shareCache[key] = S);
    }

    // ----- tree -----
    // The read's strategy at a villain node: continue with the top `cont` of the range they
    // can have here ([lo, hi] in their root-range quantiles), raise with the top `raise`.
    function villainFixed(acts, lo, hi, cont, raise, shortStack) {
      const s = new Float64Array(acts.length * NC);
      const span = Math.max(1e-6, hi - lo), w = Math.max(0.008, 0.03 * span);
      const foldEdge = lo + (1 - cont) * span, raiseEdge = hi - Math.min(raise, cont) * span;
      const iF = acts.findIndex((a) => a.kind === 'fold');
      const iC = acts.findIndex((a) => a.isCall || a.kind === 'check');
      const iR = acts.findIndex((a) => a.kind === 'raise');
      const iA = acts.findIndex((a) => a.kind === 'allin' && !a.isCall);
      for (let b = 0; b < NC; b++) {
        const q = qO[b];
        const pC = iF < 0 || cont >= 0.999 ? 1 : sigmoid((q - foldEdge) / w);
        const pR = raise > 0 && (iR >= 0 || iA >= 0) ? sigmoid((q - raiseEdge) / w) : 0;
        const pr = new Float64Array(acts.length);
        if (iF >= 0) pr[iF] = 1 - pC;
        pr[iC] = pC * (1 - pR);
        if (iR >= 0 && iA >= 0) { const sa = shortStack ? 0.85 : 0.15; pr[iA] = pC * pR * sa; pr[iR] = pC * pR * (1 - sa); }
        else if (iR >= 0) pr[iR] = pC * pR;
        else if (iA >= 0) pr[iA] = pC * pR;
        let t = 0;
        for (let j = 0; j < acts.length; j++) t += pr[j];
        for (let j = 0; j < acts.length; j++) s[j * NC + b] = t > 0 ? pr[j] / t : 1 / acts.length;
      }
      return { s, foldEdge, raiseEdge };
    }

    let terminals = 0;
    // Multiway (cfg.multi): the field is one player whose hand is its strongest one. At a leaf
    // where k of the K opponents are in, the field's chips count k times and hero's share is
    // scaled by kappa^((k - 1) / (K - 1)) (kappa = hero's K-way equity over the equity against
    // the field's strongest hand).
    const multi = cfg.multi && cfg.multi.K > 1 ? cfg.multi : null;
    const kapCache = {};
    function kapFor(k) {
      if (!multi || k <= 1 + 1e-6) return null;
      const key = Math.round(k * 20);
      if (kapCache[key]) return kapCache[key];
      const e = Math.min(1, (k - 1) / (multi.K - 1)), out = new Float64Array(NC);
      for (let a = 0; a < NC; a++) out[a] = Math.pow(multi.kappa[a], e);
      return (kapCache[key] = out);
    }
    function leaf(h, o, k) {
      terminals++;
      const m = multi && k > 1 ? k : 1;
      const allIn = h >= E - 1e-9 || o >= oMax - 1e-9;
      const potF = P0 + h + m * o;
      const n = allIn ? { term: 'show', hIn: h, oIn: o } : { term: 'flop', hIn: h, oIn: o, S: shares((E - h) / potF) };
      if (m > 1) { n.m = m; n.kap = kapFor(k); }
      return n;
    }
    function node(player, hIn, oIn, raises, lo, hi, vRaised, depth) {
      const potNow = P0 + hIn + oIn;
      const facing = player === 0 ? toCall + oIn - hIn : hIn - toCall - oIn;
      const myIn = player === 0 ? hIn : oIn;
      const maxAdd = Math.max(0, (player === 0 ? E : oMax) - myIn);
      const acts = [], kids = [];
      const put = (amt) => (player === 0 ? [hIn + amt, oIn] : [hIn, oIn + amt]);
      const add = (a, k) => { if (!acts.some((x) => x.kind === a.kind && Math.abs(x.amount - a.amount) < 1e-9)) { acts.push(a); kids.push(k); } };
      const isRoot = depth === 0;
      // Fixed strategy parameters for villain nodes.
      let cont = 1, raise = 0;
      if (player === 1) {
        if (facing <= 0) { raise = cfg.isoShare; }
        else if (depth === 1 && cfg.rootResp) {
          const r = cfg.rootResp(hIn);
          cont = r.cont; raise = r.raise;
        } else {
          const mdf = (potNow - facing) / potNow;
          const rule = continueRule({ stats: cfg.deepStats, pending: false, actions: { pre: vRaised ? 'raise' : 'call' } }, { street: 0, bigBlind }, mdf, { amount: hIn });
          cont = rule.cont; raise = Math.min(rule.reraise, rule.cont);
        }
      }
      const raiseAmts = [];
      if (raises > 0 && maxAdd > facing + 1e-9) {
        if (isRoot) {
          for (const a of rootActs) if (a.amount > facing + 1e-9) raiseAmts.push(Math.min(a.amount, maxAdd));
        } else {
          const r = round(facing + (potNow + facing));
          if (r < 0.45 * maxAdd) raiseAmts.push(r);
          raiseAmts.push(maxAdd);
        }
      }
      const shortStack = !isRoot && raiseAmts.length === 1;
      // Players in at a leaf below this node: all of them after hero's call or check (or the
      // option checked back), the expected callers after hero's first raise, one deeper.
      const kLeaf = !multi ? 1 : depth === 0 ? multi.kCall : depth === 1 && player === 1 ? (facing > 0 ? multi.kRaise(hIn) : multi.kCall) : 1;
      const childRange = (kind) => {
        if (player === 0) return [lo, hi];
        const span = hi - lo, foldEdge = lo + (1 - cont) * span, raiseEdge = hi - Math.min(raise, cont) * span;
        if (kind === 'raise') return [raiseEdge, hi];
        return [facing > 0 ? foldEdge : lo, Math.max(facing > 0 ? foldEdge : lo, raiseEdge)];
      };
      if (facing > 0) {
        add({ kind: 'fold', amount: 0 }, { term: 'fold', loser: player, hIn, oIn });
        const c = Math.min(facing, maxAdd);
        const [h2, o2] = put(c);
        const callKind = c >= maxAdd - 1e-9 ? 'allin' : 'call';
        const callLeaf = isRoot && option && c < maxAdd - 1e-9
          ? () => { const [l2, h2r] = childRange('call'); return node(1, h2, o2, raises, l2, h2r, vRaised, depth + 1); }
          : () => leaf(h2, o2, kLeaf);
        add({ kind: callKind, amount: c, isCall: true }, callLeaf);
      } else {
        add({ kind: 'check', amount: 0 }, () => leaf(hIn, oIn, kLeaf));
      }
      for (const amt of raiseAmts) {
        const [h3, o3] = put(amt);
        const kind = amt >= maxAdd - 1e-9 ? 'allin' : 'raise';
        const [l3, hi3] = childRange('raise');
        add({ kind, amount: amt }, () => node(1 - player, h3, o3, raises - 1, l3, hi3, vRaised || player === 1, depth + 1));
      }
      if (isRoot && cfg.noLimp) {
        const j = acts.findIndex((a) => a.kind === 'call');
        if (j >= 0 && acts.length > 2) { acts.splice(j, 1); kids.splice(j, 1); }
      }
      const n = { player, acts, hIn, oIn };
      n.kids = kids.map((k) => (typeof k === 'function' ? k() : k));
      n.regret = new Float64Array(acts.length * NC);
      n.sum = new Float64Array(acts.length * NC);
      if (player === 1) n.fixed = villainFixed(acts, lo, hi, cont, raise, shortStack).s;
      return n;
    }
    const root = node(0, 0, 0, cfg.raises || 4, 0, 1, cfg.villainRaised, 0);

    // ----- Discounted CFR over classes -----
    const acc = new Float64Array(NC), tot = new Float64Array(NC), live = new Int32Array(NC), lw = new Float64Array(NC);
    const mass = (r, v, g) => classMass(r, v, g);
    // With the WebAssembly kernels, each leaf matrix is copied into the kernel memory once per
    // solve, row-padded to 170 (XP) and transposed (XT), and the leaves' products run there.
    // The tree's buffers move there too (rows of 170, the padding stays zero), and the CFR
    // node loops use the same kernels as the river solver.
    let KK = kernels();
    const NP = 170;
    let kLive = null, kW = null, kOut = null, kH = null, kO = null, kTot = null, kc = null;
    const kMat = new Map();
    if (KK) {
      const mats = [MEQ, ...Object.values(shareCache)];
      const B = arenaBytes;
      let bytes = mats.length * 2 * B(NP * NP, 4) + B(NP, 4) + 5 * B(NP, 8) + 2 * B(NC, 8) + 2 * B(NC, 4) + B(13, 8);
      (function size(n) {
        for (const k of n.kids) {
          if (k.term) { bytes += B(NP, 8); continue; }
          const nA = k.acts.length;
          bytes += 4 * B(nA * NP, 8) + B(NP, 8) + nA * B(NP, 8);
          size(k);
        }
      })({ kids: [root] });
      if (!arenaBegin(bytes)) KK = null;
    }
    if (KK) {
      const mats = [MEQ, ...Object.values(shareCache)];
      for (const X of mats) {
        const XP = arenaF32(NP * NP), XT = arenaF32(NP * NP);
        for (let a = 0; a < NC; a++) for (let b = 0; b < NC; b++) { const x = X[a * NC + b]; XP[a * NP + b] = x; XT[b * NP + a] = x; }
        kMat.set(X, { xp: XP.byteOffset, xt: XT.byteOffset });
      }
      kLive = arenaI32(NP); kW = arenaF64(NP); kOut = arenaF64(NP); kTot = arenaF64(NP);
      kH = arenaF64(NP); kH.set(heroW); kO = arenaF64(NP); kO.set(oppW);
      const cnt = arenaF64(NC), per = arenaF64(NC), r1 = arenaI32(NC), r2 = arenaI32(NC);
      cnt.set(CLASS_COMBO_COUNT); per.set(CLASS_PER_CARD); r1.set(CLASS_R1); r2.set(CLASS_R2);
      kc = { cnt: cnt.byteOffset, per: per.byteOffset, r1: r1.byteOffset, r2: r2.byteOffset, PP: arenaF64(13).byteOffset };
      (function move(n) {
        for (const k of n.kids) {
          if (k.term) { k.v = arenaF64(NP); continue; }
          const nA = k.acts.length;
          k.regret = arenaF64(nA * NP); k.sum = arenaF64(nA * NP); k.buf = arenaF64(nA * NP);
          k.pFixed = arenaF64(nA * NP);
          if (k.fixed) for (let j = 0; j < nA * NC; j++) k.pFixed[Math.floor(j / NC) * NP + (j % NC)] = p * k.fixed[j];
          k.v = arenaF64(NP);
          k.r2 = k.acts.map(() => arenaF64(NP));
          move(k);
        }
      })({ kids: [root] });
    }
    function terminalK(n, trav, rH, rO) {
      const k = KK.k, v = n.v, T = kTot;
      const mass = (r, out, g) => k.pfMass(r.byteOffset, out.byteOffset, g, kc.cnt, kc.per, kc.r1, kc.r2, kc.PP);
      if (n.term === 'fold') {
        const heroGain = n.loser === 0 ? -n.hIn : P0 + n.oIn;
        mass(trav === 0 ? rO : rH, v, trav === 0 ? heroGain : P0 - heroGain);
        return v;
      }
      const oChips = n.m ? n.m * n.oIn : n.oIn;
      const potF = P0 + n.hIn + oChips;
      // Multiway leaves run in JS (the kernel memory's vectors index like the JS ones).
      if (n.kap) return multiTerminal(n, trav, rH, rO, v, potF, oChips, n.term === 'show' ? MEQ : n.S);
      const m = kMat.get(n.term === 'show' ? MEQ : n.S);
      if (trav === 0) {
        mass(rO, T, 1);
        const nz = k.pfLive(rO.byteOffset, kLive.byteOffset, kW.byteOffset);
        k.pfRowsT(m.xt, kLive.byteOffset, kW.byteOffset, nz, kOut.byteOffset);
        for (let a = 0; a < NC; a++) v[a] = potF * kOut[a] - n.hIn * T[a];
      } else {
        mass(rH, T, 1);
        const nz = k.pfLive(rH.byteOffset, kLive.byteOffset, kW.byteOffset);
        k.pfAcc(m.xp, kLive.byteOffset, kW.byteOffset, nz, kOut.byteOffset);
        for (let b = 0; b < NC; b++) v[b] = potF * (T[b] - kOut[b]) - n.oIn * T[b];
      }
      return v;
    }
    function terminal(n, trav, rH, rO) {
      const v = n.v || (n.v = new Float64Array(NC));
      if (n.term === 'fold') {
        const heroGain = n.loser === 0 ? -n.hIn : P0 + n.oIn;
        mass(trav === 0 ? rO : rH, v, trav === 0 ? heroGain : P0 - heroGain);
        return v;
      }
      const oChips = n.m ? n.m * n.oIn : n.oIn;
      const potF = P0 + n.hIn + oChips;
      const X = n.term === 'show' ? MEQ : n.S;
      if (n.kap) return multiTerminal(n, trav, rH, rO, v, potF, oChips, X);
      if (trav === 0) {
        classMass(rO, tot, 1);
        // Only the opponent's classes that still reach this leaf.
        let mx = 0, nz = 0;
        for (let b = 0; b < NC; b++) if (rO[b] > mx) mx = rO[b];
        for (let b = 0; b < NC; b++) if (rO[b] > 1e-7 * mx) { live[nz] = b; lw[nz] = rO[b]; nz++; }
        // Four rows at a time: each row keeps its own running sum in the same order, so the
        // results are the same, but the four additions don't wait on each other.
        let a = 0;
        for (; a + 3 < NC; a += 4) {
          let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
          const r0 = a * NC, r1 = r0 + NC, r2 = r1 + NC, r3 = r2 + NC;
          for (let j = 0; j < nz; j++) {
            const b = live[j], w = lw[j];
            s0 += X[r0 + b] * w; s1 += X[r1 + b] * w; s2 += X[r2 + b] * w; s3 += X[r3 + b] * w;
          }
          v[a] = potF * s0 - n.hIn * tot[a];
          v[a + 1] = potF * s1 - n.hIn * tot[a + 1];
          v[a + 2] = potF * s2 - n.hIn * tot[a + 2];
          v[a + 3] = potF * s3 - n.hIn * tot[a + 3];
        }
        for (; a < NC; a++) {
          let s2 = 0;
          const row = a * NC;
          for (let j = 0; j < nz; j++) s2 += X[row + live[j]] * lw[j];
          v[a] = potF * s2 - n.hIn * tot[a];
        }
      } else {
        classMass(rH, tot, 1);
        acc.fill(0);
        let mx = 0, nz = 0;
        for (let a = 0; a < NC; a++) if (rH[a] > mx) mx = rH[a];
        for (let a = 0; a < NC; a++) if (rH[a] > 1e-7 * mx) live[nz++] = a;
        // Four hero classes per pass over acc (added in the same order as one at a time).
        let j = 0;
        for (; j + 3 < nz; j += 4) {
          const a0 = live[j], a1 = live[j + 1], a2 = live[j + 2], a3 = live[j + 3];
          const p0 = rH[a0], p1 = rH[a1], p2 = rH[a2], p3 = rH[a3];
          const r0 = a0 * NC, r1 = a1 * NC, r2 = a2 * NC, r3 = a3 * NC;
          for (let b = 0; b < NC; b++) acc[b] = acc[b] + p0 * X[r0 + b] + p1 * X[r1 + b] + p2 * X[r2 + b] + p3 * X[r3 + b];
        }
        for (; j < nz; j++) {
          const a = live[j], ph = rH[a], row = a * NC;
          for (let b = 0; b < NC; b++) acc[b] += ph * X[row + b];
        }
        for (let b = 0; b < NC; b++) v[b] = potF * (tot[b] - acc[b]) - n.oIn * tot[b];
      }
      return v;
    }
    // A multiway leaf: hero's share of each pair is scaled by kap[hero class].
    function multiTerminal(n, trav, rH, rO, v, potF, oChips, X) {
      const kap = n.kap;
      if (trav === 0) {
        classMass(rO, tot, 1);
        for (let a = 0; a < NC; a++) {
          let s2 = 0;
          const row = a * NC;
          for (let b = 0; b < NC; b++) if (rO[b] > 0) s2 += X[row + b] * rO[b];
          v[a] = potF * kap[a] * s2 - n.hIn * tot[a];
        }
      } else {
        classMass(rH, tot, 1);
        acc.fill(0);
        for (let a = 0; a < NC; a++) {
          const ph = rH[a] * kap[a];
          if (!(ph > 0)) continue;
          const row = a * NC;
          for (let b = 0; b < NC; b++) acc[b] += ph * X[row + b];
        }
        for (let b = 0; b < NC; b++) v[b] = potF * (tot[b] - acc[b]) - oChips * tot[b];
      }
      return v;
    }
    let iter = 0;
    function cfr(n, trav, rH, rO, avg) {
      if (n.term) return terminal(n, trav, rH, rO);
      const nA = n.acts.length;
      if (!n.buf) { n.buf = new Float64Array(nA * NC); n.v = new Float64Array(NC); n.r2 = n.acts.map(() => new Float64Array(NC)); }
      const s = n.buf;
      if (avg) {
        for (let i = 0; i < NC; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += n.sum[a * NC + i];
          for (let a = 0; a < nA; a++) s[a * NC + i] = t > 0 ? n.sum[a * NC + i] / t : 1 / nA;
        }
      } else {
        for (let i = 0; i < NC; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) { const r = n.regret[a * NC + i]; if (r > 0) t += r; }
          for (let a = 0; a < nA; a++) { const r = n.regret[a * NC + i]; s[a * NC + i] = t > 0 ? (r > 0 ? r / t : 0) : 1 / nA; }
        }
        if (n.player === 1) for (let j = 0; j < nA * NC; j++) s[j] = p * n.fixed[j] + (1 - p) * s[j];
      }
      const v = n.v;
      v.fill(0);
      const own = n.player === trav;
      const vals = own ? [] : null;
      const base = n.player === 0 ? rH : rO;
      for (let a = 0; a < nA; a++) {
        const r2 = n.r2[a];
        for (let i = 0; i < NC; i++) r2[i] = base[i] * s[a * NC + i];
        const va = n.player === 0 ? cfr(n.kids[a], trav, r2, rO, avg) : cfr(n.kids[a], trav, rH, r2, avg);
        if (own) { vals.push(avg ? Float64Array.from(va) : va); for (let i = 0; i < NC; i++) v[i] += s[a * NC + i] * va[i]; }
        else for (let i = 0; i < NC; i++) v[i] += va[i];
      }
      if (own && !avg) {
        const pos = Math.pow(iter, 1.5) / (Math.pow(iter, 1.5) + 1);
        const w = Math.pow(iter / (iter + 1), 2);
        for (let a = 0; a < nA; a++) {
          for (let i = 0; i < NC; i++) {
            const j = a * NC + i;
            const r = n.regret[j];
            n.regret[j] = (r > 0 ? r * pos : 0) + vals[a][i] - v[i];
            n.sum[j] = n.sum[j] * w + base[i] * s[j];
          }
        }
      }
      if (own && avg) n.vals = vals;
      return v;
    }
    // The same CFR on the kernel memory (rows of NP).
    function cfrK(n, trav, rH, rO, avg) {
      if (n.term) return terminalK(n, trav, rH, rO);
      const k = KK.k, nA = n.acts.length, s = n.buf, so = s.byteOffset, row = 8 * NP;
      if (avg) {
        for (let i = 0; i < NC; i++) {
          let t = 0;
          for (let a = 0; a < nA; a++) t += n.sum[a * NP + i];
          for (let a = 0; a < nA; a++) s[a * NP + i] = t > 0 ? n.sum[a * NP + i] / t : 1 / nA;
        }
      } else k.strategyDiv(n.regret.byteOffset, so, nA, NP, n.player === 1 ? n.pFixed.byteOffset : 0, 1 - p, 1 / nA);
      const v = n.v;
      v.fill(0);
      const own = n.player === trav;
      const vals = own ? [] : null;
      const base = n.player === 0 ? rH : rO;
      for (let a = 0; a < nA; a++) {
        const r2 = n.r2[a];
        k.mul(r2.byteOffset, base.byteOffset, so + a * row, NP);
        const va = n.player === 0 ? cfrK(n.kids[a], trav, r2, rO, avg) : cfrK(n.kids[a], trav, rH, r2, avg);
        if (own) { vals.push(avg ? Float64Array.from(va.subarray(0, NC)) : va); k.addMul(v.byteOffset, so + a * row, va.byteOffset, NP); }
        else k.addTo(v.byteOffset, va.byteOffset, NP);
      }
      if (own && !avg) {
        const pos = Math.pow(iter, 1.5) / (Math.pow(iter, 1.5) + 1);
        const w = Math.pow(iter / (iter + 1), 2);
        const ro = n.regret.byteOffset, sm = n.sum.byteOffset;
        for (let a = 0; a < nA; a++) k.regretRiver(ro + a * row, sm + a * row, vals[a].byteOffset, v.byteOffset, base.byteOffset, so + a * row, NP, pos, w);
      }
      if (own && avg) n.vals = vals;
      return v;
    }
    const iterations = cfg.iterations || PREFLOP_ITERATIONS;
    const deadline = cfg.timeMs ? Date.now() + cfg.timeMs : Infinity;
    let ran = 0;
    const run = KK ? cfrK : cfr, rH0 = KK ? kH : heroW, rO0 = KK ? kO : oppW;
    for (iter = 1; iter <= iterations; iter++) {
      run(root, 0, rH0, rO0, false);
      run(root, 1, rH0, rO0, false);
      ran = iter;
      if (Date.now() > deadline) break;
    }
    run(root, 0, rH0, rO0, true);
    // Back to plain arrays of NC per action (the kernel memory is reused by the next solve).
    if (KK) {
      const nA = root.acts.length, sum = new Float64Array(nA * NC);
      for (let a = 0; a < nA; a++) for (let i = 0; i < NC; i++) sum[a * NC + i] = root.sum[a * NP + i];
      root.sum = sum;
    }
    const norm = new Float64Array(NC);
    mass(oppW, norm, 1);
    const h0 = heroClass;
    let t = 0;
    for (let a = 0; a < root.acts.length; a++) t += root.sum[a * NC + h0];
    return {
      iterations: ran, terminals,
      actions: root.acts.map((a, j) => ({
        kind: a.kind, amount: a.amount,
        freq: t > 0 ? root.sum[j * NC + h0] / t : 1 / root.acts.length,
        ev: norm[h0] > 0 ? root.vals[j][h0] / norm[h0] : 0,
      })),
      // Hero's strategy over the whole range at the root (for tests and the log).
      range: (j) => Array.from({ length: NC }, (_, c) => { let tt = 0; for (let a = 0; a < root.acts.length; a++) tt += root.sum[a * NC + c]; return tt > 0 ? root.sum[j * NC + c] / tt : 0; }),
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
      const ctx = {
        multiway: input.opponents.length >= 2,
        reraised: street > 0 && /^\dbet$/.test((o.actions && o.actions.pre) || ''),
      };
      const stats = computeStats(o.tally, tableStyle, input.pool, ctx);
      // Heads-up fold rates for the lookahead once everyone else has folded (playOut).
      const statsHU = ctx.multiway ? computeStats(o.tally, tableStyle, input.pool, Object.assign({}, ctx, { multiway: false })) : null;
      const actions = Object.assign({ pre: 'call', flop: '', turn: '', river: '' }, o.actions || {});
      const currentAction = actions[streetName] || '';
      const pending = street === 0 ? (actions.pre || 'pending') === 'pending' : !currentAction;
      const W = buildRange(stats, actions, strengths, dead, o.sizes, o.pfAggressor, o.position);
      const qCont = rangeQuantiles(W, current.ehs);
      const displayW = street === 0 && pending ? buildRange(stats, { pre: 'call' }, strengths, dead, null, null, o.position) : W;
      const aggressor = street === 0
        ? PRE_RAISED.test(actions.pre || '')
        : currentAction === 'bet' || currentAction === 'betcall' || currentAction === 'raise' || currentAction === 'checkraise';
      return {
        name: o.name, stats, statsHU, type: classifyPlayer(stats), actions, pending, aggressor,
        // They bet or raised on some street after the flop: from here on their range is strong.
        aggroLine: street > 0 && ['flop', 'turn', 'river'].some((n) => /bet|raise/.test(actions[n] || '')),
        W, sampler: buildSampler(W), qCont, grid: rangeGrid(displayW, dead),
      };
    });

    // Hero's story: if hero's line this hand looks strong (as a typical player's range would
    // with the same actions), opponents fold a little more to hero's bets, and less after a
    // weak-looking line.
    let credibility = 0;
    if (street > 0 && input.heroActions) {
      const hW = buildRange(computeStats({}, HERO_STYLE), input.heroActions, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true);
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
        // An open (nobody has raised yet): the raise-to size, for learned responses to opens.
        const openTo = street === 0 && toCall <= bigBlind + 1e-9 ? sc.amount + bigBlind - toCall : 0;
        const learned = i === bigBlindSeat && openTo ? vsOpenRead(o.stats, openTo / bigBlind) : null;
        if (learned) {
          rule = { cont: learned.cont, nut: 0.965, reraise: learned.threeBet, add: sc.amount - bigBlind };
        } else if (i === bigBlindSeat) {
          const big = clamp((sc.amount / bigBlind - 4) / 4, 0, 1);
          const cont = clamp(Math.max(o.stats.vpip * 1.6 * Math.sqrt((2.5 * bigBlind) / sc.amount), big * (o.stats.callBig != null ? o.stats.callBig : 0.25)), 0.05, 0.9);
          rule = { cont, nut: 0.965, reraise: clamp(o.stats.pfr * 0.4, 0.02, 0.12) / Math.max(cont, 0.05), add: sc.amount - bigBlind };
        } else {
          const mdf = o.pending ? pot / (pot + sc.amount) : (pot + toCall) / (pot + sc.amount);
          rule = continueRule(o, ctx, mdf, { amount: sc.amount, raiseOverAggressor: toCall > 0 && o.aggressor, openTo });
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
        const st = Object.assign({}, opps[i].statsHU || opps[i].stats, VARIANTS[v]);
        st.foldShift = (VARIANTS[v].foldShift || 0) + (opps[i].stats.foldShift || 0);
        plans[key] = makePlan({ stats: st, sampler: opps[i].sampler },
          { street, dead, current, runouts, seed: (seed ^ (0x5bd1e995 + i * 7919)) >>> 0, samples: input.planSamples, aggro: opps[i].aggroLine });
      }
      return plans[key];
    }

    // Hero and opponent i are alone with `P` in the pot and hero has put in `heroIn` with
    // this decision. Bet the remaining streets with both strategies and return hero's gain.
    // Either side can raise once per street; hero only bluffs the river.
    function playOut(i, P, heroIn, share, rng, startCur, v, from) {
      const plan = planFor(i, v);
      const oc = oppCombo[i];
      let left = stack - heroIn, extra = 0;
      for (let s = from != null ? from : startCur ? street : street + 1; s <= 5; s++) {
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

    // Two or more opponents left. Each street is a betting round in seat order (hero first
    // out of position, last in position): the first player whose plan says bet does so, then
    // everyone else calls, folds or raises (one raise per street). Opponents raise for value
    // from the top of their range; hero raises with a near-lock and calls when its estimated
    // chance against every live range beats the price. When hero checked and opponents are
    // still to act, the current street is played first, so checking isn't a free card.
    // Once a single opponent is left, the heads-up playout (with river bluffs) takes over.
    const multiAlive = new Uint8Array(opps.length);
    const multiState = new Uint8Array(opps.length); // 0 checked/unknown, 1 bet, 2 called, 3 raised
    const multiPut = new Float64Array(opps.length);
    const HERO = -1;
    function heroEq(list, s, sh, v) {
      let eq = 1;
      for (const i of list) {
        if (!multiAlive[i]) continue;
        const t = planFor(i, v)[s];
        const st = multiState[i];
        eq *= st === 3 ? t.eqVsRaise(sh) : st === 1 ? t.eqVsBet(sh) : st === 2 ? t.eqVsCall(sh) : t.eqAll(sh);
      }
      return eq;
    }
    function playOutMulti(list, P, heroIn, heroScore, rng, v, startCur) {
      let left = stack - heroIn, extra = 0;
      multiAlive.fill(0);
      for (const i of list) multiAlive[i] = 1;
      const aliveCount = () => { let n = 0; for (const i of list) n += multiAlive[i]; return n; };
      const lastAlive = () => { for (const i of list) if (multiAlive[i]) return i; return -1; };
      for (let s = startCur ? street : street + 1; s <= 5; s++) {
        if (left <= 0) break;
        if (aliveCount() === 1) {
          const i = lastAlive();
          const share = heroScore > oppScore[i] ? 1 : heroScore === oppScore[i] ? 0.5 : 0;
          return playOut(i, P, heroIn + extra, share, rng, false, v, s);
        }
        const sh = strengthAt(s, heroCombo);
        multiState.fill(0);
        // Seat order for this street. On the current street hero has already checked, so only the
        // opponents still to act can open, and the rest respond after a bet.
        let order;
        if (s === street) {
          order = [];
          for (const i of list) if (opps[i].pending) order.push(i);
          order.push(HERO);
          for (const i of list) if (!opps[i].pending) order.push(i);
        } else order = inPosition ? list.concat([HERO]) : [HERO].concat(list);
        const opensFrom = s === street ? order.indexOf(HERO) : order.length; // hero can't open after checking
        let bettor = -2, B = 0, at = -1;
        for (let k = 0; k < order.length && bettor === -2; k++) {
          const a = order[k];
          if (a === HERO) {
            if (k >= opensFrom) continue;
            let value = true;
            for (const i of list) if (multiAlive[i] && sh < planFor(i, v)[s].valueCut) { value = false; break; }
            if (value) { bettor = HERO; B = Math.min(left, roundChips(HERO_BET * P, bigBlind)); at = k; }
          } else if (multiAlive[a]) {
            const t = planFor(a, v)[s], so = strengthAt(s, oppCombo[a]);
            if (so >= t.vCut || (so < t.airCut && rng() < t.pBluff / Math.max(1, aliveCount() - 1))) {
              bettor = a; B = Math.min(left, roundChips(t.betFrac * P, bigBlind)); at = k;
            }
          }
        }
        if (bettor === -2) continue;
        multiPut.fill(0);
        let heroPut = 0;
        const heroAdd = (x) => { P += x; extra += x; left -= x; heroPut += x; };
        if (bettor === HERO) heroAdd(B); else { multiState[bettor] = 1; multiPut[bettor] = B; P += B; }
        let raiser = -2, R = 0;
        // Everyone after the bettor, wrapping round, responds to the bet (or to a raise made
        // in the meantime). Then anyone who acted before the raiser answers the raise.
        for (let pass = 0; pass < 2; pass++) {
          const from = pass === 0 ? at : order.indexOf(raiser);
          if (pass === 1 && raiser === -2) break;
          for (let k = 1; k < order.length; k++) {
            const a = order[(from + k) % order.length];
            const target = raiser === -2 ? B : R;
            if (a === HERO) {
              if (a === raiser || heroPut >= target) continue;
              const eq = heroEq(list, s, sh, v);
              if (raiser === -2 && eq >= 0.8 && left > B) {
                R = Math.min(left + heroPut, roundChips(B + (P + B), bigBlind));
                raiser = HERO; heroAdd(R - heroPut);
                continue;
              }
              const need = Math.min(left, target - heroPut);
              if (eq < need / (P + need)) return -heroIn - extra;
              heroAdd(need);
            } else if (multiAlive[a] && a !== raiser && multiPut[a] < target) {
              const t = planFor(a, v)[s], so = strengthAt(s, oppCombo[a]);
              if (raiser === -2 && so >= t.rCut && left > B) {
                R = Math.min(left + heroPut, roundChips(B + (P + B), bigBlind));
                raiser = a; multiState[a] = 3; P += R - multiPut[a]; multiPut[a] = R;
              } else if (raiser === -2 ? so >= t.callCut(B / Math.max(1, P - B)) : so >= t.raiseCallCut) {
                P += target - multiPut[a]; multiPut[a] = target; if (multiState[a] !== 1) multiState[a] = 2;
              } else multiAlive[a] = 0;
            }
          }
        }
        if (aliveCount() === 0) return P - heroIn - extra;
      }
      let best = heroScore, n = 1, heroBest = true;
      for (const i of list) {
        if (!multiAlive[i]) continue;
        if (oppScore[i] > best) { best = oppScore[i]; n = 1; heroBest = false; }
        else if (oppScore[i] === best) n++;
      }
      return (heroBest ? P / n : 0) - heroIn - extra;
    }

    // River boards that are a straight or better: hands that play the board never fold to a bet.
    const ties = street === 5 ? boardPlayers(board) : null;
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
          if (rule.cont >= 0.999 || (ties && ties[oppCombo[i]])) oppIn[i] = 1;
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
            const startCur = sc.kind === 'check' && list.some((i) => opps[i].pending);
            gain = playOutMulti(list, finalPot, sc.amount, hs, rng, 0, startCur);
            for (let v = 1; v < VARIANTS.length; v++) varGain[v] = playOutMulti(list, finalPot, sc.amount, hs, rng, v, startCur);
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
    // (Parallel runs can hand in solves done by the workers instead: input.solvedMerge.)
    let solved = mergeSolved(input.solvedMerge);
    if (solved) target = Math.min(target, 6000);
    if (!solved && street === 5 && opps.length === 1 && input.riverSolver !== false && stack > 0) {
      const o = opps[0], oi = input.opponents[0];
      const heroStats = computeStats({}, HERO_STYLE);
      const heroActs = Object.assign({ pre: 'call', flop: 'call', turn: 'call' }, input.heroActions || {});
      solved = riverSolve({
        board, heroCombo, strengths: strengths[5], bigBlind,
        heroW: buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true),
        oppW: buildRange(o.stats, o.actions, strengths, board, oi.sizes, oi.pfAggressor, oi.position),
        oppStats: Object.assign({}, o.stats, { foldShift: 0 }), p: o.stats.exploitWeight,
        aggScale: o.aggroLine ? clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1) : 1,
        pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
        heroFirst: toCall <= 0 && o.pending,
        iterations: input.riverIterations,
      });
      // The Monte Carlo then only feeds the equity readout, so it can be shorter.
      if (solved) target = Math.min(target, 6000);
    }
    // Computer mode, heads-up turn: solve the turn and the river together.
    if (!solved && street === 4 && opps.length === 1 && input.turnSolver === true && stack > 0) {
      const o = opps[0], oi = input.opponents[0];
      const heroStats = computeStats({}, HERO_STYLE);
      const heroActs = Object.assign({ pre: 'call', flop: 'call' }, input.heroActions || {});
      const aggS = clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1);
      const ts = turnSolve({
        board, heroCombo, strengths4: strengths[4], bigBlind,
        heroW: buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true),
        oppW: buildRange(o.stats, o.actions, strengths, board, oi.sizes, oi.pfAggressor, oi.position),
        oppStats: Object.assign({}, o.stats, { foldShift: 0 }), p: o.stats.exploitWeight,
        aggScale: o.aggroLine ? aggS : 1, aggScaleIfAgg: aggS,
        pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
        heroFirst: toCall <= 0 && o.pending, heroIP: inPosition,
        iterations: input.turnIterations, timeMs: input.turnTimeMs, riverSamples: input.turnRiverSamples, seed,
        turnBets: input.turnBets, riverBets: input.turnRiverBets, raiseFracs: input.turnRaises,
      });
      if (ts) { solved = Object.assign(ts, { kind: 'turn' }); target = Math.min(target, 6000); }
    }
    // Computer mode, multiway turn (2-4 opponents, no side pots): the turn solver against the
    // field as one opponent whose hand is the live hand with the most turn equity, sampled
    // jointly. Hero's showdown share is scaled by kappa (turnFieldKappa) because the other
    // players can still win on the river.
    if (!solved && street === 4 && opps.length >= 2 && opps.length <= 4 && !sidePots && input.turnSolver === true && stack > 0) {
      const heroStats = computeStats({}, HERO_STYLE);
      const heroActs = Object.assign({ pre: 'call', flop: 'call' }, input.heroActions || {});
      const heroW = buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true);
      const field = turnField(opps, heroW, board, dead, strengths[4].ehs, input.turnFieldSamples || 1500, seed);
      if (field) {
        const agg = opps.findIndex((o) => o.aggressor);
        let pick = agg;
        if (pick < 0) { pick = 0; for (let i = 1; i < opps.length; i++) if (opps[i].stats.foldToBet < opps[pick].stats.foldToBet) pick = i; }
        const o = opps[pick];
        const aggS = clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1);
        const ts = turnSolve({
          board, heroCombo, strengths4: strengths[4], bigBlind, heroW, oppW: field.W,
          oppStats: fieldStats(opps.map((x) => x.stats), o.stats), p: Math.min(...opps.map((x) => x.stats.exploitWeight)),
          aggScale: opps.some((x) => x.aggroLine) ? aggS : 1, aggScaleIfAgg: aggS,
          pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
          heroFirst: toCall <= 0 && opps.some((x) => x.pending), heroIP: inPosition,
          iterations: input.turnIterations, timeMs: input.turnTimeMs, riverSamples: input.turnRiverSamples, seed,
          turnBets: input.turnBets, riverBets: input.turnRiverBets, raiseFracs: input.turnRaises,
          multi: { kappa: field.kappa, K: opps.length, rho: input.turnFieldRho != null ? input.turnFieldRho : 0.4 },
        });
        if (ts) { solved = Object.assign(ts, { kind: 'turn', field: opps.length, multiway: opps.length }); target = Math.min(target, 6000); }
      }
    }
    // Computer mode, flop (input.flopSolver === true): the flop and the turn in one solve with the
    // river checked down, heads-up or against the field (2-4 opponents, no side pots) like the
    // multiway turn.
    if (!solved && street === 3 && opps.length >= 1 && opps.length <= 4 && !(opps.length > 1 && sidePots) && input.flopSolver === true && stack > 0) {
      const heroStats = computeStats({}, HERO_STYLE);
      const heroActs = Object.assign({ pre: 'call' }, input.heroActions || {});
      const heroW = buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true);
      let oppW, oppStats, o, p, multi = null, ok = true;
      if (opps.length === 1) {
        o = opps[0];
        const oi = input.opponents[0];
        oppW = buildRange(o.stats, o.actions, strengths, board, oi.sizes, oi.pfAggressor, oi.position);
        oppStats = Object.assign({}, o.stats, { foldShift: 0 });
        p = o.stats.exploitWeight;
      } else {
        const field = turnField(opps, heroW, board, dead, strengths[3].ehs, input.flopFieldSamples || 1500, seed);
        if (!field) ok = false;
        else {
          const agg = opps.findIndex((x) => x.aggressor);
          let pick = agg;
          if (pick < 0) { pick = 0; for (let i = 1; i < opps.length; i++) if (opps[i].stats.foldToBet < opps[pick].stats.foldToBet) pick = i; }
          o = opps[pick];
          oppW = field.W;
          oppStats = fieldStats(opps.map((x) => x.stats), o.stats);
          p = Math.min(...opps.map((x) => x.stats.exploitWeight));
          multi = { kappa: field.kappa, K: opps.length, rho: input.flopFieldRho != null ? input.flopFieldRho : 0.4 };
        }
      }
      if (ok) {
        const aggS = clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1);
        const fs = flopSolve({
          board, heroCombo, strengths3: strengths[3], bigBlind, heroW, oppW, oppStats, p,
          aggScale: opps.some((x) => x.aggroLine) ? aggS : 1, aggScaleIfAgg: aggS,
          pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
          heroFirst: toCall <= 0 && opps.some((x) => x.pending), heroIP: inPosition,
          iterations: input.flopIterations, timeMs: input.flopTimeMs, turnSamples: input.flopTurnSamples,
          riverSamples: input.flopRiverSamples, seed, flopBets: input.flopBets, turnBets: input.flopTurnBets, multi,
          riverBet: input.flopRiverBet,
        });
        if (fs) {
          solved = Object.assign(fs, { kind: 'flop' }, opps.length > 1 ? { field: opps.length, multiway: opps.length } : {});
          target = Math.min(target, 6000);
        }
      }
    }
    // Multiway river: solve against the field as one opponent. Its range is the strongest of
    // the live opponents' hands, sampled jointly from their ranges (so card removal is right),
    // and it plays like the aggressor if there is one, otherwise like the stickiest caller.
    // Overcalls from the weaker players are ignored, so value bets come out slightly cautious.
    if (!solved && street === 5 && opps.length >= 2 && opps.length <= 5 && !sidePots && input.riverSolver !== false && stack > 0) {
      const W = new Float64Array(NUM_COMBOS);
      const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
      const used = new Uint8Array(52);
      const hsR = strengths[5].hs;
      let got = 0;
      for (let it = 0; it < 6000; it++) {
        used.fill(0);
        for (const c of dead) used[c] = 1;
        let best = -1, bestS = -1, ok = true;
        for (let i = 0; i < opps.length && ok; i++) {
          let k = -1;
          for (let tries = 0; tries < 40; tries++) {
            const cand = sampleCombo(opps[i].sampler, rng());
            if (!used[COMBO_HI[cand]] && !used[COMBO_LO[cand]]) { k = cand; break; }
          }
          if (k < 0) { ok = false; break; }
          used[COMBO_HI[k]] = used[COMBO_LO[k]] = 1;
          if (hsR[k] > bestS) { bestS = hsR[k]; best = k; }
        }
        if (ok && best >= 0) { W[best]++; got++; }
      }
      if (got > 500) {
        const agg = opps.findIndex((o) => o.aggressor);
        let pick = agg;
        if (pick < 0) { pick = 0; for (let i = 1; i < opps.length; i++) if (opps[i].stats.foldToBet < opps[pick].stats.foldToBet) pick = i; }
        const o = opps[pick];
        const heroStats = computeStats({}, HERO_STYLE);
        const heroActs = Object.assign({ pre: 'call', flop: 'call', turn: 'call' }, input.heroActions || {});
        solved = riverSolve({
          board, heroCombo, strengths: strengths[5], bigBlind,
          heroW: buildRange(heroStats, heroActs, strengths, board, input.heroSizes, input.heroPfAggressor, input.heroPosition, true),
          oppW: W,
          oppStats: fieldStats(opps.map((x) => x.stats), o.stats),
          overcall: (frac) => {
            let sum = 0, none = 1;
            for (const x of opps) { const c = 1 - foldAtSize(Object.assign({}, x.stats, { foldShift: 0 }), frac, 5); sum += c; none *= 1 - c; }
            return none < 1 ? Math.max(1, sum / (1 - none)) : 1;
          },
          p: Math.min(...opps.map((x) => x.stats.exploitWeight)),
          aggScale: opps.some((x) => x.aggroLine) ? clamp(o.stats.foldAfterAgg / Math.max(0.05, o.stats.foldToBet), 0.15, 1) : 1,
          pot, toCall, stack: isFinite(stack) ? stack : 100 * bigBlind + pot,
          heroFirst: toCall <= 0 && opps.some((x) => x.pending),
          iterations: input.riverIterations,
        });
        if (solved) { solved.multiway = opps.length; target = Math.min(target, 6000); }
      }
    }

    // Preflop: solve hero's range against the opponent's (or, for an open with several
    // players still to act, against the field) instead of the Monte Carlo's one-decision model.
    const fieldOpen = opps.length >= 2 && opps.length <= 8 && opps.every((o) => o.pending) && toCall > 0 && toCall <= bigBlind + 1e-9;
    // Other multiway spots (limpers, a raise with callers, players behind) are solved against
    // the field too, with multiway equity (preflopMulti); input.preflopMultiway === false keeps
    // them on the Monte Carlo.
    const fieldOther = opps.length >= 2 && opps.length <= 8 && !fieldOpen && input.preflopMultiway !== false;
    if (!solved && street === 0 && input.preflopSolver !== false && stack > 0 && (opps.length === 1 || fieldOpen || fieldOther)) {
      const E = isFinite(stack) ? stack : 100 * bigBlind + pot;
      const field = opps.length > 1;
      const heroPre = (input.heroActions && input.heroActions.pre) || 'pending';
      const heroCw = classWeights(preflopRange(computeStats({}, HERO_STYLE), heroPre === 'check' ? 'pending' : heroPre));
      const hc = COMBO_CLASS[heroCombo];
      heroCw[hc] = Math.max(heroCw[hc], 0.05);
      const oppCws = opps.map((o) => classWeights(o.W));
      const capE = (x) => Math.min(x, E);
      const raisesSc = scenarios.filter((s) => s.kind !== 'fold' && s.amount > toCall + 1e-9);
      const mid = raisesSc.find((s) => s.sizeLabel === 'pot-size raise') || raisesSc[0];
      const oppCw = field ? fieldMax(oppCws, mid ? mid.opp.map((r) => r.cont) : null) : oppCws[0];
      const rootResp = (amt) => {
        const sc = raisesSc.find((s) => Math.abs(capE(s.amount) - amt) < 1e-9);
        let fold = 1, noRaise = 1;
        opps.forEach((o, i) => {
          const r = sc ? sc.opp[i] : continueRule(o, ctx, (pot + toCall) / (pot + amt), { amount: amt });
          const c = clamp(r.cont, 0, 1);
          const learned = o.pending && toCall <= bigBlind + 1e-9 ? vsOpenRead(o.stats, (amt + bigBlind - toCall) / bigBlind) : null;
          const rr = learned ? learned.threeBet : o.pending ? clamp(o.stats.threeBet != null ? o.stats.threeBet : o.stats.pfr * 0.4, 0.02, 0.25) : clamp(r.reraise || 0, 0, c);
          fold *= 1 - c;
          noRaise *= 1 - Math.min(rr, c);
        });
        return { cont: 1 - fold, raise: 1 - noRaise };
      };
      let deep = opps.find((o) => o.aggressor) || opps[0];
      if (!deep.aggressor) for (const o of opps) if (o.stats.vpip > deep.stats.vpip) deep = o;
      // Raise wars: any re-raise label ('3bet', '4bet', ...) leaves two more raises in the tree.
      const pres = opps.map((o) => o.actions.pre || 'pending');
      const reraised = pres.some((x) => /bet/.test(x));
      const vRaised = pres.some((x) => /bet|raise/.test(x));
      const raises = /bet|raise/.test(heroPre) || reraised ? 2 : (!field || fieldOther) && vRaised ? 3 : 4;
      const pendingOpps = opps.filter((o) => o.pending);
      const multi = fieldOther ? preflopMulti(opps, scenarios, raisesSc, capE, toCall, input.preflopMultiSamples || (input.power ? 1500 : 400), seed) : null;
      const pf = preflopSolve({
        heroW: heroCw, oppW: oppCw, heroClass: hc, pot, toCall, stack: E, bigBlind, heroIP: inPosition,
        rootActs: raisesSc.map((s) => ({ amount: capE(s.amount) })),
        option: field ? fieldOther && pendingOpps.length > 0 && toCall > 0 : opps[0].pending && toCall > 0,
        isoShare: 1 - (field && fieldOther ? pendingOpps : opps).reduce((a, o) => a * (1 - clamp(o.stats.pfr * 0.8, 0.03, 0.3)), 1),
        rootResp, deepStats: deep.stats, villainRaised: (!field || fieldOther) && vRaised,
        raises, noLimp: fieldOpen, multi,
        p: Math.min(...opps.map((o) => o.stats.exploitWeight)),
        iterations: input.preflopIterations, timeMs: input.preflopTimeMs,
      });
      if (pf) {
        // Name each action as the matching option in the list.
        pf.actions = pf.actions.map((a) => {
          let sc = null;
          if (a.kind === 'fold') sc = scenarios.find((s) => s.kind === 'fold');
          else if (a.kind === 'check' || (a.kind === 'call') || (a.kind === 'allin' && a.amount <= toCall + 1e-9)) sc = scenarios.find((s) => s.amount <= toCall + 1e-9 && s.kind !== 'fold');
          else sc = raisesSc.find((s) => Math.abs(capE(s.amount) - a.amount) < 1e-9);
          return sc ? Object.assign({}, a, { kind: sc.kind, amount: sc.amount, label: sc.label, sizeLabel: sc.sizeLabel || '' }) : a;
        });
        solved = Object.assign(pf, { kind: 'preflop', field: field ? opps.length : 0, multiway: multi ? opps.length : 0 });
        target = Math.min(target, 6000);
      }
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
        label: a.label || (a.kind === 'allin' ? (a.amount <= toCall + 1e-9 ? 'Call all-in' : 'All-in') : name[a.kind]),
        sizeLabel: a.sizeLabel != null ? a.sizeLabel : a.frac && a.kind !== 'allin'
          ? (a.kind === 'raise' ? (a.frac < 0.8 ? 'small raise' : a.frac > 1.25 ? 'big raise' : 'pot-size raise') : Math.round(a.frac * 100) + '% pot') : '',
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
        solver: solved ? { kind: solved.kind || 'river', iterations: solved.iterations, runs: solved.runs || 1, exploitWeight: opps[0].stats.exploitWeight, field: solved.field || solved.multiway || 0 } : null,
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

    // Parallel runs: workers return their Monte Carlo tallies with partial(), and one final
    // analysis with input.merge adds them up (and runs the solvers) instead of sampling itself.
    const ACC = ['n', 'gainSum', 'gainSq', 'foldAll', 'showdowns', 'shareSum', 'wins', 'ties', 'reraised', 'looked'];
    const ARR = ['vsWins', 'vsTies', 'vsCount', 'oppFolds', 'varSum'];
    function partial() {
      return scenarios.map((sc) => {
        const o = { kind: sc.kind, amount: sc.amount };
        for (const k of ACC) o[k] = sc[k] || 0;
        for (const k of ARR) o[k] = sc[k] ? Array.from(sc[k]) : [];
        return o;
      });
    }
    if (Array.isArray(input.merge)) {
      for (const part of input.merge) {
        for (const ps of part) {
          const sc = scenarios.find((x) => x.kind === ps.kind && Math.abs(x.amount - ps.amount) < 1e-9);
          if (!sc || sc.kind === 'fold') continue;
          for (const k of ACC) sc[k] += ps[k] || 0;
          for (const k of ARR) if (sc[k]) for (let i = 0; i < sc[k].length && i < ps[k].length; i++) sc[k][i] += ps[k][i];
        }
        done += part.length ? Math.max(...part.map((x) => x.n || 0)) : 0;
      }
      target = 0;
    }

    const solvedOut = () => (solved ? { kind: solved.kind, iterations: solved.iterations, field: solved.field || solved.multiway || 0, actions: solved.actions.map((a) => Object.assign({}, a)) } : null);
    return { step, result, partial, solvedOut, target, scenarios };
  }

  // Average the solves of several workers (same spot, different random river cards).
  function mergeSolved(list) {
    const got = (list || []).filter((x) => x && x.actions && x.actions.length);
    if (!got.length) return null;
    const acts = got[0].actions.map((a) => Object.assign({}, a, { freq: 0, ev: 0 }));
    let n = 0, its = 0;
    for (const g of got) {
      if (g.actions.length !== acts.length || g.actions.some((a, j) => a.kind !== acts[j].kind || Math.abs(a.amount - acts[j].amount) > 1e-9)) continue;
      g.actions.forEach((a, j) => { acts[j].freq += a.freq; acts[j].ev += a.ev; });
      n++; its += g.iterations || 0;
    }
    acts.forEach((a) => { a.freq /= n; a.ev /= n; });
    return { kind: got[0].kind, iterations: its, runs: n, field: got[0].field || got[0].multiway || 0, actions: acts };
  }

  // Which solver will decide this spot (keep in step with createAnalysis): 'preflop', 'flop' and
  // 'turn' (computer mode only), 'river' or null (Monte Carlo). The offscreen pool uses it to size
  // the Monte Carlo, which only feeds the equity readout when a solver decides.
  function solvableSpot(input) {
    const street = (input.board || []).length, opps = input.opponents || [], n = opps.length;
    if (!n || (input.stack != null && !(input.stack > 0))) return null;
    if (street === 0) {
      const bb = input.bigBlind > 0 ? +input.bigBlind : 1, toCall = +input.toCall || 0;
      const allPending = opps.every((o) => ((o.actions && o.actions.pre) || 'pending') === 'pending');
      if (input.preflopSolver === false) return null;
      return n === 1 || (n <= 8 && ((allPending && toCall > 0 && toCall <= bb + 1e-9) || input.preflopMultiway !== false)) ? 'preflop' : null;
    }
    if (street === 3) {
      if (input.flopSolver !== true) return null;
      const stack = input.stack > 0 ? +input.stack : Infinity;
      const sidePots = input.heroCommitted != null && opps.every((o) => o.committed != null) && opps.some((o) => o.stack != null && o.stack < stack);
      return n === 1 || (n <= 4 && !sidePots) ? 'flop' : null;
    }
    if (street === 4) {
      const stack = input.stack > 0 ? +input.stack : Infinity;
      const sidePots = input.heroCommitted != null && opps.every((o) => o.committed != null) && opps.some((o) => o.stack != null && o.stack < stack);
      return n === 1 || (n <= 4 && !sidePots) ? 'turn' : null;
    }
    if (street === 5) {
      const stack = input.stack > 0 ? +input.stack : Infinity;
      const sidePots = input.heroCommitted != null && opps.every((o) => o.committed != null) && opps.some((o) => o.stack != null && o.stack < stack);
      return n === 1 || (n <= 5 && !sidePots) ? 'river' : null;
    }
    return null;
  }

  function roundChips(x, bb) {
    const unit = bb >= 1 ? Math.max(1, Math.round(bb / 2)) : bb / 2;
    return Math.max(unit, Math.round(x / unit) * unit);
  }

  function analyzeSync(input) {
    const a = createAnalysis(input);
    while (a.step(5000) < 1);
    return input.partial ? { partial: a.partial(), solved: a.solvedOut() } : a.result();
  }

  const api = {
    RANKS, SUITS, CATEGORY_NAMES, CLASS_NAMES, CLASS_COMBO_COUNT, PREFLOP_ORDER, PLAYER_TYPES, TABLE_PRIORS,
    parseCard, cardToString, evaluate, describeScore, describeHero,
    computeStats, classifyPlayer, preflopRange, boardStrength, buildRange, applyAction, rangeGrid,
    foldAtSize, valueShare, classifyShows, handPercentile, readSummary, scoreShow,
    READ_PRIORS, readPrior, FIT_VERSION, NOISES, TILTS, tallyCells, fitFamily, poolTally, predictAction, makePredictor, modelFold,
    createAnalysis, analyzeSync, solvableSpot, comboIndex: (a, b) => COMBO_INDEX[a * 52 + b],
    // WebAssembly kernels: useKernels(false) forces the JS loops (same results); kernelsActive() tells which run.
    useKernels: (on) => { wkEnabled = on !== false; }, kernelsActive: () => !!kernels(),
    // For tests.
    _pf: { classMass, preflopCompat, preflopEquityTable, fieldMax, preflopMulti, classIndex: (n) => CLASS_NAMES.indexOf(n), fieldStats, foldAtSize, computeStats },
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
  const MAX_SHOWS = 80;
  const MAX_HISTORY = 150;
  // Raw events: kept for the newest RAW_KEEP hands only (about 10 KB a hand).
  const RAW_KEEP = 100, RAW_MAX_EVENTS = 400, RAW_MAX_EVENT = 4000;
  // Each hand a player is dealt into shrinks their older counts by 1%, so the last
  // hundred or so hands carry most of the weight and reads follow players who change.
  const DECAY = 0.997;
  function decayTally(t, f) {
    const d = f != null ? f : DECAY;
    for (const k of Object.keys(t)) {
      if (k === 'shows') continue;
      if (typeof t[k] === 'number') t[k] *= d;
      else if (t[k] && typeof t[k] === 'object') decayTally(t[k], d);
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
      // Facing a big preflop raise or shove (8+ big blinds to them): times faced, and how often they called or re-raised.
      pfBigOpp: 0, pfBigCall: 0,
      // Limping (calling the big blind first in), folding to a 3-bet after raising.
      // Re-raising again (4-bet or more) after raising and facing a re-raise; opportunities are f3betOpp.
      limpOpp: 0, limp: 0, f3betOpp: 0, f3bet: 0, pf4bet: 0,
      // Donk bets (leading the flop into the preflop raiser) and check-raises (any street after the flop).
      donkOpp: 0, donk: 0, xrOpp: 0, xr: 0,
      // Pots won after a showdown and without one (from stack changes between hands).
      wonSD: 0, wonNoSD: 0,
      // Facing a bet after they had already bet or raised earlier in the hand: times, and folds.
      aggVsN: 0, aggVsFold: 0,
      // Think time per action kind: count and total seconds (capped at 60 per action).
      tt: { check: { n: 0, sum: 0 }, bet: { n: 0, sum: 0 }, call: { n: 0, sum: 0 }, raise: { n: 0, sum: 0 }, fold: { n: 0, sum: 0 } },
      // Continuation bets: preflop raiser's first flop decision, and how others react to it.
      cbetOpp: 0, cbet: 0, vsCbet: 0, foldCbet: 0,
      // Per-street action counts (the flat counts above are all streets together).
      st: { flop: streetTally(), turn: streetTally(), river: streetTally() },
      // The part of `st` from multiway spots (three or more players still in at the decision), and
      // the part counted before multiway spots were told apart (reads saved by older versions).
      stMw: { flop: streetTally(), turn: streetTally(), river: streetTally() },
      stOld: { flop: streetTally(), turn: streetTally(), river: streetTally() },
      // Reaction to a bet by its size (fraction of the pot before the bet): <45%, 45-85%, >85%.
      vs: { small: facingTally(), medium: facingTally(), large: facingTally() },
      // Response to a single open raise preflop by its raise-to size: <=2.5bb, <=3.5bb, more ('raise' = 3-bet).
      vsOpen: { small: facingTally(), medium: facingTally(), large: facingTally() },
      // Their own bet sizes postflop, as fractions of the pot.
      betSize: { n: 0, sum: 0 },
      // Read accuracy on every action: decisions scored, and the summed surprise (-log of the
      // predicted chance of what they did) under their read and under an average player's.
      pred: { n: 0, read: 0, pop: 0 },
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
    if (t.st && !t.stMw) t.stOld = JSON.parse(JSON.stringify(t.st));
    for (const k of Object.keys(b)) {
      if (t[k] == null) t[k] = b[k];
      else if (k === 'st' || k === 'stMw' || k === 'stOld' || k === 'vs' || k === 'pos' || k === 'tt' || k === 'vsOpen' || k === 'pred') for (const j of Object.keys(b[k])) if (!t[k][j]) t[k][j] = b[k][j];
    }
    return t;
  }
  // Read accuracy over a player's shown hands. A fit's `top` is the share of our predicted
  // range that ranked above the hand they showed (low = we expected hands like it); `hits` counts
  // shown hands that sat in the likelier half of our range, so a calibrated read hits about half.
  function accuracySummary(t) {
    const folded = (x) => x.folded || Object.values(x.actions || {}).some((a) => a === 'fold');
    const fits = (t.shows || []).filter((x) => x && !folded(x)).map((x) => x.fit).filter((f) => f && f.top != null);
    if (!fits.length) return null;
    const hits = fits.filter((f) => f.top < 0.5).length;
    const avg = (k) => Math.round((fits.reduce((a, f) => a + (f[k] || 0), 0) / fits.length) * 100) / 100;
    return { n: fits.length, hits, hitRate: Math.round((hits / fits.length) * 100) / 100, avgTop: avg('top'), avgLr: avg('lr') };
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
        if (known && known.tally) decayTally(upgradeTally(known.tally), this.decay);
        players[p.id] = {
          id: p.id, auth: p.authUserId, name: p.name, pos: p.posType,
          stageBet: 0, total: 0, folded: false, allin: false,
          seq: { pre: [], flop: [], turn: [], river: [] },
          pfCat: null, acted: false, faced3: false, cbetSeen: false,
          agg: [], sizes: {}, shown: [], start: +p.stack || 0, ms: [],
        };
      }
      this.hand = {
        players, street: 0, started: false, board: [], heroUids: [], heroCards: {}, uidPos: {},
        pfRaiser: null, flopBet: false,
        currentBet: 0, preRaises: 0, dealerPos: null, bigBlind: s.bigBlind || null,
        finished: false, log: [], raw: this.pendingRaw || [], turnAt: {}, t0: this.rawStart || Date.now(),
      };
      this.pendingRaw = null;
      this.emit('hand', this.hand);
    }

    handle(ev, data, snap) {
      if (snap) this.snap = snap;
      if (ev === 'game:stage_began' && data && data.stageType === 'set_blinds') this.rawStart = Date.now();
      this.recordRaw(ev, data, snap);
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
          if (h) h.turnAt[data.playerID] = Date.now();
          if (h && !h.finished) {
            const left = data.turnTimeDurationMS > 0 ? data.turnTimeDurationMS - (data.turnTimeElapsedMS || 0) : null;
            this.emit('turn', { playerID: data.playerID, isHero: data.playerID === this.heroId(), timeLeftMs: left });
          }
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
      // Three or more players still in when they act.
      const multiway = Object.values(h.players).filter((x) => !x.folded).length >= 3;
      h.currentBetBefore = h.currentBet;
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
      if (r && street > 0) {
        const d = facing > 0
          ? (kind === 'fold' || kind === 'call' || kind === 'raise') && { kind: 'face', n: street, out: kind, frac: facing / Math.max(1, potBefore - facing), aggLine: p.agg.length > 0, mw: multiway, reraised: /^\dbet$/.test(PatioTracker.preAction(p)) }
          : (kind === 'check' || kind === 'bet') && { kind: 'open', n: street, out: kind, cbet: street === 3 && h.pfRaiser === p.id && !p.cbetSeen && !h.flopBet, mw: multiway };
        if (d) this.scorePrediction(r.tally, Object.assign(d, { pos: this.posGroup(p.id) }));
      }
      if (r) this.extraStats(p, r.tally, kind, facing, key);
      if (street === 0) {
        if (r && !p.faced3 && h.preRaises === 1 && kind !== 'check') {
          p.faced3 = true;
          r.tally.pf3betOpp++;
          if (kind === '3bet') r.tally.pf3bet++;
          // Response to an open by size, for players who had not acted yet (limpers facing a raise
          // keep most of their limping range, and the solver asks only about players still to act).
          const toBB = h.bigBlind > 0 && p.seq.pre.length === 1 ? (p.stageBet - added + facing) / h.bigBlind : 0;
          const vo = toBB > 0 && r.tally.vsOpen && r.tally.vsOpen[toBB <= 2.5 ? 'small' : toBB <= 3.5 ? 'medium' : 'large'];
          const k2 = kind === '3bet' ? 'raise' : kind;
          if (vo && vo[k2] != null) vo[k2]++;
        }
        const bb = h.bigBlind || 0;
        if (r && bb > 0 && p.stageBet - added + facing >= 8 * bb && facing > 0 && !p.facedBig && kind !== 'check') {
          p.facedBig = true;
          r.tally.pfBigOpp++;
          if (kind !== 'fold') r.tally.pfBigCall++;
        }
        if (kind === 'raise' || kind === '3bet') {
          h.preRaises++; h.pfRaiser = p.id;
          // Which raise this was (1 = open, 2 = 3-bet, 3 = 4-bet, ...) and how big compared with the
          // raise before it: friends often min-reraise back and forth, which says less than a real 4-bet.
          const inc = p.stageBet - (h.currentBetBefore || 0);
          const prevInc = h.lastRaiseInc || bb || inc;
          p.preTop = h.preRaises;
          p.sizes.pre = prevInc > 0 ? Math.round((inc / prevInc) * 100) / 100 : 1;
          h.lastRaiseInc = inc;
        }
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
          if (multiway && key && t.stMw && t.stMw[key] && t.stMw[key][kind] != null) t.stMw[key][kind]++;
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
          const g = this.posGroup(p.id);
          this.scorePrediction(r.tally, { kind: 'pf', out: { pfFold: 'fold', pfCall: 'call', pfRaise: 'raise' }[p.pfCat || 'pfFold'], pos: g });
          r.tally[p.pfCat || 'pfFold']++;
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
      this.rescoreStale(this.rescoreLimit != null ? this.rescoreLimit : 6);
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
        raw: h.raw,
        players: Object.values(h.players).map((p) => ({
          name: p.name, hero: p.id === heroId, position: this.posGroup(p.id), folded: p.folded, stack: p.start,
          put: p.total, actions: p.seq, shown: p.shown, fit: p.fit, accuracy: p.accuracy,
          pred: p.id === heroId ? undefined : predSummary(this.db.players[p.auth] && this.db.players[p.auth].tally),
        })),
      };
      h.logEntry = entry;
      const list = this.db.history || (this.db.history = []);
      list.push(entry);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      const keep = this.rawKeep != null ? this.rawKeep : RAW_KEEP;
      for (let i = 0; i < list.length - keep; i++) delete list[i].raw;
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
      if (h.turnAt[p.id]) { e.ms = Date.now() - h.turnAt[p.id]; delete h.turnAt[p.id]; }
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
      // How far hero's bet or raise was from the advised size (1 = as advised; a min-raise against
      // "raise to 7x" shows as about 0.3). `followed` only checks the kind of action.
      if (adv.amount > 0 && added > 0 && group(adv.kind) === 'aggr' && group(kind) === 'aggr') adv.sizeRatio = r2(added / adv.amount);
    }

    // Read accuracy: before an action is counted, how likely the read made it, and how likely an
    // average player's read did. `predictor(tally, d)` (set by the UI from the engine) returns
    // [read probabilities, average-player probabilities] for the decision d.
    scorePrediction(t, d) {
      if (!this.predictor || !t.pred) return;
      try {
        const [read, pop] = this.predictor(t, d);
        const pr = (x) => { let s = 0; for (const v of Object.values(x)) s += Math.max(0, v); return Math.max(1e-3, (x[d.out] || 0) / (s || 1)); };
        t.pred.n++;
        t.pred.read += -Math.log(pr(read));
        t.pred.pop += -Math.log(pr(pop));
      } catch (e) { /* scoring is optional */ }
    }

    // Every known opponent's counts added up (not their shows): the engine blends this table's
    // own averages into the prior for players it has barely seen.
    poolTally() {
      const add = (src, out) => {
        for (const k of Object.keys(src || {})) {
          if (k === 'shows' || k === 'pred') continue;
          const v = src[k];
          if (typeof v === 'number') out[k] = (out[k] || 0) + v;
          else if (v && typeof v === 'object' && !Array.isArray(v)) add(v, out[k] || (out[k] = {}));
        }
        return out;
      };
      const out = {};
      for (const r of Object.values(this.db.players)) if (r && r.tally) add(r.tally, out);
      return out;
    }

    // Shows scored by an older engine (or not at all) are scored again a few at a time after each
    // hand, so learned tilts and noise use the current range model. `fitVersion` is set by the UI.
    rescoreStale(limit) {
      if (!this.scorer || this.fitVersion == null) return 0;
      let done = 0;
      for (const r of Object.values(this.db.players)) {
        const shows = (r.tally && r.tally.shows) || [];
        for (const sh of shows) {
          if (done >= limit) return done;
          if (!sh || sh.folded || (sh.fit && sh.fit.v === this.fitVersion) || sh.rescored === this.fitVersion) continue;
          sh.rescored = this.fitVersion;
          done++;
          try {
            const others = Object.assign({}, r.tally, { shows: shows.filter((x) => x !== sh) });
            const fit = this.scorer(sh, others);
            if (fit) sh.fit = fit;
          } catch (e) { /* keep the old fit */ }
        }
      }
      return done;
    }

    // More tendencies, counted before this action updates the hand state:
    // limps, fold to 3-bet, donk bets, check-raises, and how long they take for each kind of action.
    extraStats(p, t, kind, facing, key) {
      const h = this.hand;
      const last = h.log[h.log.length - 1];
      if (last && last.ms != null && last.who === p.name) {
        const tt = t.tt[kind === '3bet' ? 'raise' : kind];
        if (tt) { tt.n++; tt.sum += Math.min(60, last.ms / 1000); }
        p.ms.push({ st: key, act: kind, ms: last.ms });
      }
      if (h.street === 0) {
        if (p.seq.pre.length === 1 && h.preRaises === 0 && kind !== 'check') { t.limpOpp++; if (kind === 'call') t.limp++; }
        if (h.preRaises >= 2 && facing > 0 && !p.faced3bet && p.seq.pre.slice(0, -1).some((k) => k === 'raise' || k === '3bet')) {
          p.faced3bet = true; t.f3betOpp++; if (kind === 'fold') t.f3bet++; else if (kind === 'raise' || kind === '3bet') t.pf4bet++;
        }
        return;
      }
      if (h.street === 3 && h.pfRaiser != null && h.pfRaiser !== p.id && !h.flopBet && !p.donkSeen) {
        const raiser = h.players[h.pfRaiser];
        if (raiser && !raiser.folded && raiser.seq.flop.length === 0) { p.donkSeen = true; t.donkOpp++; if (kind === 'bet') t.donk++; }
      }
      if (facing > 0 && p.agg.length > 0 && (kind === 'fold' || kind === 'call' || kind === 'raise')) { t.aggVsN++; if (kind === 'fold') t.aggVsFold++; }
      const seqSt = p.seq[key] || [];
      if (facing > 0 && seqSt.slice(0, -1).includes('check') && !(p.xrSeen || (p.xrSeen = {}))[key]) {
        p.xrSeen[key] = true; t.xrOpp++; if (kind === 'raise') t.xr++;
      }
    }

    // Raw recorder: every game event of the hand with its time and the stacks, so any stat can be
    // computed later and real hands can be replayed through new solver versions. Snapshots are kept
    // only where stacks matter, and very large payloads are cut, to fit phone storage.
    recordRaw(ev, data, snap) {
      if (ev === 'hook:attached' || ev === 'hook:snapshot') return;
      const isNewHand = ev === 'game:stage_began' && data && data.stageType === 'set_blinds';
      const h = this.hand;
      let list;
      if (isNewHand) list = this.pendingRaw = [];
      else if (h) list = h.raw;
      else return;
      let d = null;
      try {
        const txt = JSON.stringify(data === undefined ? null : data);
        d = txt && txt.length > RAW_MAX_EVENT ? { cut: txt.length } : JSON.parse(txt);
      } catch (e) { d = { unserializable: true }; }
      const t0 = isNewHand ? this.rawStart : h.t0;
      const rec = { t: Date.now() - (t0 || Date.now()), ev, d };
      if (snap && (isNewHand || ev === 'game:player_turn_started' || ev === 'game:game_ended' || ev === 'game:stage_began')) {
        rec.s = (snap.players || []).map((x) => [x.id, x.name, x.stack, x.posType, x.playState]);
        if (isNewHand) rec.bb = snap.bigBlind;
      }
      // Past the cap, keep only the events the tracker itself uses, so chatty extras can't push them out.
      if (list.length >= RAW_MAX_EVENTS && !/^(game:(stage_began|dealer_updated|small_blind_paid|big_blind_paid|cards?_dealt?_to_|update_card_data|player_turn|game_ended)|player:game:action_taken)/.test(ev)) return;
      list.push(rec);
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
      const live = Object.values(prev.players).filter((p) => !p.folded).length;
      for (const p of Object.values(prev.players)) {
        if (p.id === this.heroId() || !(net[p.name] > 0)) continue;
        const r = this.record(p.auth, p.name);
        if (r) { if (live >= 2) r.tally.wonSD++; else r.tally.wonNoSD++; }
      }
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
        if (r.solver) { a.solve = r.solver.kind; if (r.solver.kind === 'river') a.riverSolve = true; }
        if (r.quick) a.quick = true;
        if (fmt && r.ranked) a.options = r.ranked.slice(0, 5).map((sc) => ({ a: fmt(sc), ev: r2(sc.ev || 0) }));
        if (r.opponents) a.reads = r.opponents.map((o) => ({
          name: o.name, type: o.type && o.type.label, hands: Math.round(o.stats.hands || 0),
          bluff: o.bluffChance != null ? r2(o.bluffChance) : undefined,
          trust: o.stats.exploitWeight != null ? r2(o.stats.exploitWeight) : undefined,
          accuracy: o.stats.accuracy ? { n: o.stats.accuracy.n, hits: o.stats.accuracy.hits, vsGuess: r2(o.stats.accuracy.vsGuess) } : undefined,
          strengthBias: o.stats.strengthBias ? r2(o.stats.strengthBias) : undefined,
          callBig: o.stats.callBig != null ? r2(o.stats.callBig) : undefined,
          act: o.stats.predAccuracy ? { n: Math.round(o.stats.predAccuracy.n), gain: r2(o.stats.predAccuracy.gain) } : undefined,
          noise: o.stats.rangeNoise != null ? r2(o.stats.rangeNoise) : undefined,
          tilt: o.stats.tiltAgg != null ? [r2(o.stats.tiltAgg), r2(o.stats.tiltPas)] : undefined,
          certainty: o.stats.certainty != null ? r2(o.stats.certainty) : undefined,
        }));
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
      const actions = { pre: PatioTracker.preAction(p) };
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = PatioTracker.streetAction(p.seq[k], n);
      if (actions.pre === 'pending') actions.pre = 'call';
      const show = {
        cards: p.shown.slice(), board: h.board.slice(), agg: p.agg.slice(),
        actions, sizes: Object.assign({}, p.sizes), ms: p.ms.slice(), pfAggressor: h.pfRaiser === p.id, position: this.posGroup(p.id),
      };
      // How well the range we would have put them on matches what they showed.
      // Folded hands are kept (bets before the fold were bluffs) but not scored against a range.
      if (p.folded) show.folded = true;
      else if (this.scorer) { try { show.fit = this.scorer(show, r.tally); } catch (e) { /* scoring is optional */ } }
      r.tally.shows.push(show);
      // Hand log: how well this read fit, and the player's running accuracy.
      if (show.fit) {
        p.fit = show.fit;
        p.accuracy = accuracySummary(r.tally);
        const lp = h.logEntry && h.logEntry.players.find((x) => x.name === p.name && !x.hero);
        if (lp) { lp.fit = p.fit; lp.accuracy = p.accuracy; }
      }
      if (r.tally.shows.length > MAX_SHOWS) r.tally.shows.splice(0, r.tally.shows.length - MAX_SHOWS);
      this.emit('save', this.db);
    }

    // A player's preflop line for the solver: like streetAction, but a re-raise once the pot already
    // had two raises is a '4bet', and three or more a '5bet'.
    static preAction(p) {
      const a = PatioTracker.streetAction(p.seq.pre, 0);
      if ((a === '3bet' || a === 'raise') && p.preTop >= 3) return p.preTop >= 4 ? '5bet' : '4bet';
      return a;
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
      // Bet, then called a raise (multiway): their range is what continues against a raise.
      if (seq.includes('bet')) return seq.includes('call') ? 'betcall' : 'bet';
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
        const a = { pre: PatioTracker.preAction(o) };
        for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (street >= n) a[k] = PatioTracker.streetAction(o.seq[k], n);
        if (street > 0 && a.pre === 'pending') a.pre = 'call';
        return a;
      };
      const opponents = opps.map((o) => {
        const r = this.record(o.auth, o.name);
        const actions = { pre: PatioTracker.preAction(o) };
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
          // Every known opponent's counts added up, for the engine's table prior.
          pool: this.poolTally(),
          iterations: opponents.length > 2 ? 16000 : 24000,
          // Fresh seed each decision, so close spots get mixed rather than always the same advice.
          seed: (Math.random() * 4294967296) >>> 0,
        },
        heroStageBet: hero.stageBet,
        heroCards, board: h.board.slice(),
      };
    }
  }

  // Read accuracy on actions: { n, gain } where gain is how much less surprised (nats per action)
  // their read was than an average player's read; null with no actions scored yet.
  function predSummary(t) {
    const p = t && t.pred;
    if (!p || !(p.n >= 1)) return null;
    return { n: Math.round(p.n), gain: Math.round(((p.pop - p.read) / p.n) * 1000) / 1000, surprise: Math.round((p.read / p.n) * 1000) / 1000 };
  }
  PatioTracker.predSummary = predSummary;
  PatioTracker.blankTally = blankTally;
  PatioTracker.DECAY = DECAY;
  PatioTracker.accuracySummary = accuracySummary;
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
  // The page's localStorage is shared with the game, so if it fills up, raw hand events are
  // dropped (oldest first) before the reads are ever lost.
  function save(k, v) {
    for (var tries = 0; tries < 6; tries++) {
      try { localStorage.setItem(k, JSON.stringify(v)); return; } catch (e) {
        var hist = v && v.history;
        if (!hist) return;
        var withRaw = hist.filter(function (x) { return x.raw; });
        if (!withRaw.length) return;
        withRaw.slice(0, Math.ceil(withRaw.length / 2)).forEach(function (x) { delete x.raw; });
      }
    }
  }

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
  tracker.rawKeep = 60; // phone storage is shared with the game; export the hand log after each session
  tracker.scorer = function (show, tally) { return PokerEngine.scoreShow(show, tally, ui.tableStyle, tracker.poolTally()); };
  tracker.predictor = PokerEngine.makePredictor(function () { return ui.tableStyle; }, function () { return tracker.poolTally(); });
  tracker.fitVersion = PokerEngine.FIT_VERSION;
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
      var st = PokerEngine.computeStats(Object.assign(PatioTracker.blankTally(), r ? r.tally : {}), ui.tableStyle, tracker.poolTally());
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
      if (r.solver) kv.push([{ preflop: 'Preflop solve', turn: 'Turn + river solve', river: 'River solve' }[r.solver.kind] || 'Solve', r.solver.field ? 'Your range vs the field' : 'Your range vs theirs']);
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
    // Other table events go to the tracker only for the hand log's raw recorder.
    sock.onAny(function (ev, data) {
      if (WANTED[ev] || (ev === 'chat_message' ? !!(data && data.msgType === 'game_log') : /^(game:|player:game:|admin:game:)/.test(ev))) onEvent(ev, data);
    });
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
