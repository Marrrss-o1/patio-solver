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

  // How often a player with fold-to-bet `ftb` folds to a bet of `f` x pot, before any size-specific data.
  function modelFold(ftb, f) {
    const mdf = 1 / (1 + Math.max(0.05, f));
    const elasticity = clamp(1.7 * Math.sqrt(ftb / 0.45), 1, 2.2);
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

    const n = hands + stats.postflopActions / 2;
    stats.confidence = n < 10 ? 'guess' : n < 40 ? 'low' : n < 120 ? 'medium' : 'solid';
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
    else if (stats.vpip >= 0.45 && (stats.af >= 3 || stats.pfr >= 0.3 || stats.bluffShare >= 0.45)) key = 'maniac';
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
    if (r.threeBet != null) parts.push('3-bet ' + p(r.threeBet));
    if (r.cbet != null) parts.push('c-bet ' + p(r.cbet));
    const fs = r.foldBySize;
    if (fs && (fs.smallN || fs.largeN)) parts.push('folds to small/big bets ' + (fs.smallN ? p(fs.small) : '–') + '/' + (fs.largeN ? p(fs.large) : '–'));
    if (stats.shown && stats.shown.bets) parts.push('bluffed ' + stats.shown.bluffs + ' of ' + stats.shown.bets + ' shown bets');
    if (r.wtsd != null) parts.push('to showdown ' + p(r.wtsd));
    return parts.join(' · ');
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
    const base = modelFold(ss.foldToBet, f);
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
    return clamp(base + d, 0.02, 0.98);
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
    let P;
    if (action === 'bet') {
      P = aggressionProbs(W, st, stats.betFreq, vr);
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(0.03, P[k]);
    } else if (action === 'check') {
      P = aggressionProbs(W, st, stats.betFreq, vr);
      const slow = clamp(0.5 - 0.1 * stats.af, 0.1, 0.45);
      for (let k = 0; k < NUM_COMBOS; k++) P[k] = Math.max(slow, 1 - P[k]);
    } else if (action === 'raise') {
      P = aggressionProbs(W, st, clamp(stats.raiseFreq * 1.2, 0.04, 0.5), clamp(vr + 0.05, 0.6, 0.92));
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

  function buildRange(stats, actions, strengths, deadCards, sizes, pfAggressor) {
    let W = preflopRange(stats, actions.pre || 'pending');
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
      const betFreq = clamp(ss.betFreq, 0.05, 0.9);
      const vr = valueShare(o.stats, o.stats.betSize);
      const vCut = q(1 - betFreq * vr);
      const airCut = q(0.35);
      const pBluff = clamp((betFreq * (1 - vr)) / 0.35, 0, 0.9);
      const cum = new Float64Array(N + 1);
      for (let j = 0; j < N; j++) cum[j + 1] = cum[j] + (x[j] >= vCut ? 1 : x[j] < airCut ? pBluff : 0);
      const callCut = (f) => q(foldAtSize(o.stats, f, s));
      const c0 = lowerBound(x, callCut(HERO_BET));
      plan[s] = {
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
      const W = buildRange(stats, actions, strengths, dead, o.sizes, o.pfAggressor);
      const qCont = rangeQuantiles(W, current.ehs);
      const displayW = street === 0 && pending ? buildRange(stats, { pre: 'call' }, strengths, dead) : W;
      const aggressor = street === 0
        ? actions.pre === 'raise' || actions.pre === '3bet'
        : currentAction === 'bet' || currentAction === 'raise' || currentAction === 'checkraise';
      return {
        name: o.name, stats, type: classifyPlayer(stats), actions, pending, aggressor,
        W, sampler: buildSampler(W), qCont, grid: rangeGrid(displayW, dead),
      };
    });

    const scenarios = [];
    const cap = (x) => Math.min(x, stack);
    const fmtFrac = (f) => ({ 0.33: '⅓ pot', 0.5: '½ pot', 0.75: '¾ pot', 1: 'pot', 1.5: '1½ pot' })[f] || Math.round(f * 100) + '% pot';
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
        oppFolds: new Float64Array(opps.length), reraised: 0, looked: 0,
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
    if (street === 0) realize = 0.78 + 0.22 * heroStrength + (inPosition ? 0.06 : -0.04);
    else if (street < 5) realize = 0.88 + 0.12 * heroStrength + (inPosition ? 0.04 : -0.04);
    realize = clamp(realize, 0.6, 1);

    const seed = (input.seed >>> 0) || 0x9e3779b9;
    const runnable = scenarios.filter((s) => s.kind !== 'fold');
    const target = input.iterations || 30000;
    const cards = new Int32Array(7);
    const used = new Uint8Array(52);
    const oppCombo = new Int16Array(opps.length);
    const oppScore = new Int32Array(opps.length);
    const oppIn = new Uint8Array(opps.length);
    let done = 0;

    function strengthAt(s, k) {
      if (s === street) return current.ehs[k];
      if (s === 4) return runouts.turn(cards[5])[k];
      return street === 3 ? runouts.river(cards[5], cards[6])[k] : runouts.river(cards[6], -1)[k];
    }

    // Hero and opponent i are alone with `P` in the pot and hero has put in `heroIn` with
    // this decision. Bet the remaining streets with both strategies and return hero's gain.
    // Simplifications: no raises after this decision, and hero only bluffs the river.
    function playOut(i, P, heroIn, share, rng, startCur) {
      const plan = plans[i] || (plans[i] = makePlan(opps[i], { street, dead, current, runouts, seed: (seed ^ (0x5bd1e995 + i * 7919)) >>> 0 }));
      const oc = oppCombo[i];
      let left = stack - heroIn, extra = 0;
      for (let s = startCur ? street : street + 1; s <= 5; s++) {
        if (left <= 0) break;
        const t = plan[s];
        const sh = strengthAt(s, heroCombo), so = strengthAt(s, oc);
        const oppBets = () => so >= t.vCut || (so < t.airCut && rng() < t.pBluff);
        const heroCalls = () => {
          const B = Math.min(left, roundChips(t.betFrac * P, bigBlind));
          if (t.eqVsBet(sh) < B / (P + 2 * B)) return false;
          P += 2 * B; extra += B; left -= B;
          return true;
        };
        const heroBets = () => {
          const B = Math.min(left, roundChips(HERO_BET * P, bigBlind));
          const value = sh >= t.valueCut;
          const bluff = !value && s === 5 && t.eqVsCall(sh) < 0.2 && t.foldHero * P - (1 - t.foldHero) * B > 0.05 * P;
          if (!value && !bluff) return 'check';
          if (so < t.callCut(B / P)) return 'won';
          P += 2 * B; extra += B; left -= B;
          return 'called';
        };
        if (s === street) {
          // Hero checked; the opponent acts behind.
          if (oppBets() && !heroCalls()) return -heroIn - extra;
        } else if (inPosition) {
          if (oppBets()) { if (!heroCalls()) return -heroIn - extra; }
          else if (heroBets() === 'won') return P - heroIn - extra;
        } else {
          const r = heroBets();
          if (r === 'won') return P - heroIn - extra;
          if (r === 'check' && oppBets() && !heroCalls()) return -heroIn - extra;
        }
      }
      return share * P - heroIn - extra;
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
            finalPot += sc.opp[i].add;
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
          if (lookahead && inCount === 1 && sc.amount < stack) {
            gain = playOut(lastIn, finalPot, sc.amount, share, rng, sc.kind === 'check' && opps[lastIn].pending);
            sc.looked++;
          } else {
            gain = share * (sc.amount >= stack ? 1 : realize) * finalPot - sc.amount;
          }
          sc.showdowns++;
          sc.shareSum += share;
          if (share === 1) sc.wins++;
          else if (share > 0) sc.ties++;
        }
        sc.n++;
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

    function result() {
      for (const sc of scenarios) {
        if (sc.kind === 'fold') { sc.ev = 0; sc.se = 0; continue; }
        const n = Math.max(1, sc.n);
        sc.ev = sc.gainSum / n;
        sc.se = Math.sqrt(Math.max(0, sc.gainSq / n - sc.ev * sc.ev) / n);
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
      const runnerUp = ranked.find((sc) => aggressive(sc) !== aggressive(best) || (!aggressive(best) && sc.kind !== best.kind));
      const passive = scenarios.find((s) => s.kind === 'check' || s.kind === 'call');
      const base = scenarios.find((s) => s.kind !== 'fold');
      const margin = runnerUp ? best.ev - runnerUp.ev : Infinity;
      const closeThreshold = Math.max(0.03 * (pot + toCall), 2 * best.se, 0.25 * bigBlind);

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
        scenarios, ranked, best, runnerUp, margin, close: margin < closeThreshold,
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
    foldAtSize, valueShare, classifyShows, handPercentile, readSummary,
    createAnalysis, analyzeSync, comboIndex: (a, b) => COMBO_INDEX[a * 52 + b],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
