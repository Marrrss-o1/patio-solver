// No-limit hold'em hand engine for the simulators: 2-6 seats, side pots, the same socket events
// the real table sends (so the real tracker and solver can sit in a seat), a hand-log entry in
// the tracker's export format, and AIVAT-style luck correction for one measured seat.
//
// Seats are { policy(view) -> [{ t, to?, p }] } (bots whose action probabilities are known) or
// { act(view) -> { t, to? } } (hero agents). t is 'fold' | 'check' | 'call' | 'raise'; `to` is the
// total bet this street after a raise.
//
// AIVAT (Burch et al. 2018), as used here: every chance event (board cards) and every decision of
// a bot whose probabilities are known adds a correction V(what happened) - E[V(what could have
// happened)], where V is the measured seat's expected result if the hand were checked down from
// that state, computed with every hole card known. Each correction has zero mean, so the corrected
// result `adj` is an unbiased estimate of the true result `net`, with much of the card and bot
// luck removed. Hero's own decisions are not corrected (hero's strategy is not known in closed form).
'use strict';
const E = require('../../src/engine.js');

const STREET_NAMES = [['pre_flop', 0], ['flop', 3], ['turn', 4], ['river', 5]];
const STREET_KEY = { 0: 'pre', 3: 'flop', 4: 'turn', 5: 'river' };
const RANKS = '23456789TJQKA', SUITN = ['clubs', 'diamonds', 'hearts', 'spades'];
const cardData = (c, uid) => ({ uniqueID: uid, suite: SUITN[c & 3], value: RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2] });

// ---------- random numbers ----------
function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function mix(h, k) {
  h = Math.imul(h ^ (k >>> 0), 0x85ebca6b) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
// A uniform number fixed by its keys: the same decision in two runs (A/B) gets the same draw.
function keyed(...ks) { let h = 0x1234567; for (const k of ks) h = mix(h, k); return h / 4294967296; }
function shuffled(seed) {
  const r = rng32(seed);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  return deck;
}

// ---------- positions (same rule as the tracker's posGroup) ----------
function seatOrderFrom(btn, n) { const o = []; for (let k = 1; k <= n; k++) o.push((btn + k) % n); return o; }
function posGroup(seat, btn, n) {
  const order = seatOrderFrom(btn, n);
  const i = order.indexOf(seat);
  if (i === n - 1) return 'late';
  if (n === 2 || i < 2) return 'blinds';
  if (n >= 5 && i === n - 2) return 'late';
  return 'early';
}

// ---------- settling ----------
// Chips each seat gets back from the pot, given what everyone put in, who folded and the scores.
function payouts(put, folded, scores, out) {
  const n = put.length;
  out.fill(0);
  let prev = 0;
  for (;;) {
    let lv = Infinity;
    for (let i = 0; i < n; i++) if (put[i] > prev && put[i] < lv) lv = put[i];
    if (lv === Infinity) break;
    let amount = 0, top = -1, nw = 0, first = -1;
    for (let i = 0; i < n; i++) {
      if (put[i] >= lv) { amount += lv - prev; if (first < 0) first = i; }
      if (put[i] >= lv && !folded[i]) { if (scores[i] > top) { top = scores[i]; nw = 1; } else if (scores[i] === top) nw++; }
    }
    if (nw === 0) out[first] += amount;
    else for (let i = 0; i < n; i++) if (put[i] >= lv && !folded[i] && scores[i] === top) out[i] += amount / nw;
    prev = lv;
  }
  return out;
}

// ---------- AIVAT value function ----------
// V(state) = measured seat's expected chips back minus chips put in, over all remaining boards,
// if nobody acted again. `pending` decides what happens to bets not yet called:
//   'refund' - they come back (the bet changes nothing yet),
//   'call'   - everyone facing a bet calls it (capped by their stack),
//   'best'   - as 'call', except the measured seat folds when calling would lose with every card known.
class ValueFn {
  constructor(g, hero, opts) {
    this.g = g; this.hero = hero;
    this.pending = opts.pending || 'call';
    this.pfSamples = opts.pfSamples || 2000;
    this.future = opts.future != null ? opts.future : 0.8;
    this.cap = opts.cap != null ? opts.cap : 1.5;
    this.cache = new Map();
    this.buf = new Int32Array(7);
    this.out = new Float64Array(g.n);
    this.put = new Float64Array(g.n);
    this.scores = new Int32Array(g.n);
  }
  // Score of every live seat for every remaining board (exact on the flop and later, sampled preflop).
  runouts(nb, folded) {
    const g = this.g;
    let mask = 0; for (let i = 0; i < g.n; i++) if (!folded[i]) mask |= 1 << i;
    const key = nb * 64 + mask;
    let r = this.cache.get(key);
    if (r) return r;
    const dead = new Uint8Array(52);
    for (const h of g.hands) { dead[h[0]] = 1; dead[h[1]] = 1; }
    const board = g.boardAll.slice(0, nb);
    for (const c of board) dead[c] = 1;
    const rest = []; for (let c = 0; c < 52; c++) if (!dead[c]) rest.push(c);
    const boards = [];
    if (nb === 5) boards.push(board);
    else if (nb === 4) for (const c of rest) boards.push(board.concat([c]));
    else if (nb === 3) for (let a = 0; a < rest.length; a++) for (let b = a + 1; b < rest.length; b++) boards.push(board.concat([rest[a], rest[b]]));
    else {
      // Preflop: a fixed random sample of boards (its own stream, independent of the real board).
      const rr = rng32(g.vseed);
      for (let s = 0; s < this.pfSamples; s++) {
        const pick = [];
        while (pick.length < 5) { const c = rest[Math.floor(rr() * rest.length)]; if (!pick.includes(c)) pick.push(c); }
        boards.push(pick);
      }
    }
    const live = []; for (let i = 0; i < g.n; i++) if (!folded[i]) live.push(i);
    const sc = new Int32Array(boards.length * g.n);
    const buf = this.buf;
    for (let b = 0; b < boards.length; b++) {
      for (let k = 0; k < 5; k++) buf[k] = boards[b][k];
      for (const i of live) { buf[5] = g.hands[i][0]; buf[6] = g.hands[i][1]; sc[b * g.n + i] = E.evaluate(buf, 7); }
    }
    r = { n: boards.length, sc, live };
    this.cache.set(key, r);
    return r;
  }
  // Expected net for the measured seat with these contributions.
  ev(nb, put, folded) {
    const h = this.hero, g = this.g;
    if (folded[h]) return -put[h];
    let liveN = 0; for (let i = 0; i < g.n; i++) if (!folded[i]) liveN++;
    if (liveN === 1) { let tot = 0; for (let i = 0; i < g.n; i++) tot += put[i]; return tot - put[h]; }
    const r = this.runouts(nb, folded);
    const out = this.out, scores = this.scores;
    let sum = 0;
    for (let b = 0; b < r.n; b++) {
      for (const i of r.live) scores[i] = r.sc[b * g.n + i];
      payouts(put, folded, scores, out);
      sum += out[h];
    }
    return sum / r.n - put[h];
  }
  // V of a state given as { put, bet, stack, folded, cur } on a board of nb cards.
  value(nb, st) {
    const g = this.g, h = this.hero;
    if (st.folded[h]) return -st.put[h];
    const put = this.put;
    for (let i = 0; i < g.n; i++) put[i] = st.put[i];
    if (this.pending === 'refund') return this.ev(nb, put, st.folded);
    for (let i = 0; i < g.n; i++) if (!st.folded[i] && st.bet[i] < st.cur) put[i] += Math.min(st.cur - st.bet[i], st.stack[i]);
    const vCall = this.ev(nb, put, st.folded);
    if (this.pending === 'best' && st.bet[h] < st.cur && st.stack[h] > 0) return Math.max(-st.put[h], vCall);
    return vCall;
  }
}

// ---------- the hand ----------
// cfg: { n, btn, hands, boardAll, stacks, sb, bb, seats, hero, emit(ev, data, snapFn), seed, aivat: { pending, pfSamples } | null,
//        names, ids, log: true to build a hand-log entry,
//        watchers: [{ seat, onEvent(ev, data, snapFn) }] for other seats with their own tracker (solver opponents):
//        each gets the events as that seat's overlay would, with its own hole cards and itself as hero }
function playHand(cfg) {
  const n = cfg.n, bb = cfg.bb, sb = cfg.sb;
  const g = {
    n, btn: cfg.btn, hands: cfg.hands, boardAll: cfg.boardAll, board: [], bb, sb,
    stack: cfg.stacks.slice(), start: cfg.stacks.slice(), bet: new Array(n).fill(0), put: new Array(n).fill(0),
    folded: new Array(n).fill(false), cur: 0, lastRaise: bb, raises: 0, street: 0, callsNow: 0, foldsNow: 0, pfAgg: -1, limpers: 0, limped: new Array(n).fill(false),
    seq: Array.from({ length: n }, () => ({ pre: [], flop: [], turn: [], river: [] })), nAct: 0,
    vseed: (cfg.seed ^ 0x5bd1e995) >>> 0, lastAgg: -1, potAtStreet: 0,
  };
  const hero = cfg.hero == null ? 0 : cfg.hero;
  const emit = cfg.emit || null;
  const names = cfg.names || g.hands.map((_, i) => 'P' + i);
  const sbP = n === 2 ? g.btn : (g.btn + 1) % n, bbP = n === 2 ? (g.btn + 1) % n : (g.btn + 2) % n;
  const live = () => { const o = []; for (let i = 0; i < n; i++) if (!g.folded[i]) o.push(i); return o; };
  const snapFor = (me) => ({ tableType: 'private', heroAuthId: 'P' + me, bigBlind: bb, players: g.hands.map((_, i) => (
    { id: i + 1, authUserId: 'P' + i, name: names[i], stack: g.stack[i], posType: 's' + (i + 1), playState: g.folded[i] ? 'folded' : 'playing' })) });
  // Everyone listening: hero's overlay, then any other seats' (each sees the table as its own hero).
  const listeners = (emit ? [{ seat: hero, fn: emit }] : []).concat((cfg.watchers || []).map((w) => ({ seat: w.seat, fn: w.onEvent })));
  const evTo = (l, e, d) => l.fn(e, d, () => snapFor(l.seat));
  const ev = (e, d) => { for (const l of listeners) evTo(l, e, d); };
  const pos = g.hands.map((_, i) => posGroup(i, g.btn, n));
  g.pos = pos;
  const vf = cfg.aivat ? new ValueFn(g, hero, cfg.aivat) : null;
  const corr = { chance: 0, action: 0 };
  const log = cfg.log ? [] : null;
  let flopInfo = null;

  ev('game:stage_began', { stageType: 'set_blinds' });
  ev('game:dealer_updated', { dealerSeatPos: 's' + (g.btn + 1) });
  const pay = (p, a) => { a = Math.min(a, g.stack[p]); g.stack[p] -= a; g.bet[p] += a; g.put[p] += a; return a; };
  const sbAmt = pay(sbP, sb); ev('game:small_blind_paid', { amount: sbAmt, playerId: sbP + 1 });
  if (log) log.push({ st: 'pre', who: names[sbP], hero: sbP === hero, act: 'sb', amt: sbAmt });
  const bbAmt = pay(bbP, bb); ev('game:big_blind_paid', { amount: bbAmt, playerId: bbP + 1 });
  if (log) log.push({ st: 'pre', who: names[bbP], hero: bbP === hero, act: 'bb', amt: bbAmt });
  g.cur = bb;
  const uidBase = cfg.uidBase || 0;
  const uids = g.hands.map((_, i) => [uidBase + 2 * i + 1, uidBase + 2 * i + 2]);
  ev('game:cards_dealt_to_player', g.hands.flatMap((_, i) => [{ playerPos: 's' + (i + 1), cardData: { uniqueID: uids[i][0] } }, { playerPos: 's' + (i + 1), cardData: { uniqueID: uids[i][1] } }]));
  for (const l of listeners) {
    evTo(l, 'game:update_card_data', { cardData: cardData(g.hands[l.seat][0], uids[l.seat][0]) });
    evTo(l, 'game:update_card_data', { cardData: cardData(g.hands[l.seat][1], uids[l.seat][1]) });
  }
  let uidN = uidBase + 2 * n + 10;

  // Applies a normalized action. Returns the tracker-style kind.
  function normalize(i, a) {
    const toCall = g.cur - g.bet[i];
    let t = a.t;
    if (t === 'check' && toCall > 0) t = 'fold';
    if ((t === 'call' || t === 'fold') && toCall <= 0) t = 'check';
    if (t === 'call') return { t, add: Math.min(toCall, g.stack[i]) };
    if (t === 'raise') {
      const maxTo = g.bet[i] + g.stack[i];
      let others = 0;
      for (let j = 0; j < n; j++) if (j !== i && !g.folded[j]) others = Math.max(others, g.bet[j] + g.stack[j]);
      let to = Math.round(a.to);
      to = Math.max(to, g.cur + g.lastRaise);
      to = Math.min(to, maxTo, Math.max(g.cur, others));
      if (to <= g.cur) return toCall > 0 ? { t: 'call', add: Math.min(toCall, g.stack[i]) } : { t: 'check', add: 0 };
      return { t: 'raise', add: to - g.bet[i], to };
    }
    return { t, add: 0 };
  }
  // State after action `na` by seat i, for the value function.
  function after(i, na) {
    const put = g.put.slice(), bet = g.bet.slice(), stack = g.stack.slice(), folded = g.folded.slice();
    let cur = g.cur;
    if (na.t === 'fold') folded[i] = true;
    else { put[i] += na.add; bet[i] += na.add; stack[i] -= na.add; if (bet[i] > cur) cur = bet[i]; }
    return { put, bet, stack, folded, cur };
  }
  const stateNow = () => ({ put: g.put, bet: g.bet, stack: g.stack, folded: g.folded, cur: g.cur });

  function view(i) {
    const lv = live();
    return {
      seat: i, n, hand: g.hands[i], board: g.board, street: g.board.length, bb, sb,
      pot: g.put.reduce((a, b) => a + b, 0), toCall: Math.max(0, g.cur - g.bet[i]), cur: g.cur, myBet: g.bet[i], stack: g.stack[i],
      put: g.put[i], lastRaise: g.lastRaise, raises: g.raises, nLive: lv.length, nOpp: lv.length - 1, pos: pos[i], btn: g.btn,
      isBtn: i === g.btn, pfAgg: g.pfAgg, lastAgg: g.lastAgg, limpers: g.limpers, limped: g.limped[i], seq: g.seq[i], potAtStreet: g.potAtStreet,
      // How many live players act after this seat on this street (0 = last to act).
      behind: (() => { const order = seatOrderFrom(g.btn, n).filter((j) => !g.folded[j]); return order.length - 1 - order.indexOf(i); })(),
      // Facing a bet: who has called it, who has folded to it, and how many still have to answer it after this seat.
      callsNow: g.callsNow, foldsNow: g.foldsNow,
      toAnswer: lv.filter((j) => j !== i && g.bet[j] < g.cur && g.stack[j] > 0).length,
      maxOppStack: Math.max(0, ...lv.filter((j) => j !== i).map((j) => g.stack[j] + g.bet[j] - g.bet[i])),
      rk: cfg.seed, nAct: g.nAct,
    };
  }

  for (const [name, nb] of STREET_NAMES) {
    if (nb > 0) {
      g.bet.fill(0); g.cur = 0; g.raises = 0; g.lastRaise = bb; g.lastAgg = -1; g.callsNow = 0; g.foldsNow = 0;
      const prevNb = g.board.length;
      const heroLive = vf && !g.folded[hero] && live().length > 1;
      const vBefore = heroLive ? vf.value(prevNb, stateNow()) : 0;
      // Measurement (cfg.flopinfo): the state when the flop comes, for calibrating the preflop solver's flop leaves.
      if (cfg.flopinfo && nb === 3 && heroLive) {
        const lvp = live(), order = seatOrderFrom(g.btn, n).filter((j) => !g.folded[j]);
        let eff = 0; for (const i of lvp) if (i !== hero) eff = Math.max(eff, Math.min(g.stack[i], g.stack[hero]));
        flopInfo = { k: lvp.length, h: g.hands[hero].slice(), o: lvp.filter((i) => i !== hero).map((i) => g.hands[i].slice()),
          ip: order[order.length - 1] === hero ? 1 : 0, pot: g.put.reduce((a, b) => a + b, 0), put: g.put[hero], eff, vPre: vBefore, cb: corr.chance + corr.action };
      }
      ev('game:stage_began', { stageType: name });
      const add = g.boardAll.slice(g.board.length, nb);
      g.board = g.boardAll.slice(0, nb);
      g.street = nb;
      g.potAtStreet = g.put.reduce((a, b) => a + b, 0);
      ev('game:cards_deal_to_stack', add.map((c) => ({ emitData: { stackID: 'community_stack', cardData: cardData(c, uidN++) } })));
      if (heroLive) {
        // A card that moves hero's equity also moves the money still to go in: scale the change by
        // 1 + future * min(stack behind / pot, cap). The scale is fixed before the card falls, so the
        // correction still has zero mean. (future 0.8, cap 1.5: tuned on bot-vs-bot runs, ~20% less variance.)
        const dv = vf.value(nb, stateNow()) - vBefore;
        let eff = 0; for (let i = 0; i < n; i++) if (i !== hero && !g.folded[i]) eff = Math.max(eff, Math.min(g.stack[i], g.stack[hero]));
        corr.chance += dv * (1 + vf.future * Math.min(eff / Math.max(1, g.potAtStreet), vf.cap));
        if (cfg.parts) (corr.parts || (corr.parts = [])).push([Math.round(dv * 1000) / 1000, g.potAtStreet, eff, nb]);
      }
    } else ev('game:stage_began', { stageType: name });
    if (live().length < 2) break;
    const canAct = live().filter((i) => g.stack[i] > 0);
    if (canAct.length < 2 && live().every((i) => g.bet[i] >= g.cur || g.stack[i] === 0)) continue;
    let actor = nb === 0 ? (n === 2 ? sbP : (bbP + 1) % n) : (g.btn + 1) % n;
    const acted = new Array(n).fill(false);
    for (let guard = 0; guard < 400; guard++) {
      if (live().length < 2) break;
      let pending = false;
      for (let i = 0; i < n; i++) if (!g.folded[i] && g.stack[i] > 0 && (!acted[i] || g.bet[i] < g.cur)) pending = true;
      if (!pending) break;
      if (g.folded[actor] || g.stack[actor] === 0 || (acted[actor] && g.bet[actor] >= g.cur)) { actor = (actor + 1) % n; continue; }
      const seat = cfg.seats[actor];
      ev('game:player_turn_started', { playerID: actor + 1 });
      const v = view(actor);
      let na;
      if (seat.policy) {
        // Known probabilities: merge equal outcomes, draw one, and add the AIVAT action correction.
        const dist = seat.policy(v);
        const outs = [];
        for (const d of dist) {
          if (!(d.p > 0)) continue;
          const x = normalize(actor, d);
          const same = outs.find((o) => o.t === x.t && o.add === x.add);
          if (same) same.p += d.p; else outs.push(Object.assign(x, { p: d.p }));
        }
        let tot = 0; for (const o of outs) tot += o.p;
        let u = keyed(cfg.seed, actor, g.nAct, 77) * tot, pick = outs[outs.length - 1];
        for (const o of outs) { u -= o.p; if (u < 0) { pick = o; break; } }
        na = pick;
        if (vf && !g.folded[hero] && actor !== hero && outs.length > 1) {
          let exp = 0, vPick = 0;
          for (const o of outs) { const val = vf.value(g.board.length, after(actor, o)); exp += (o.p / tot) * val; if (o === pick) vPick = val; }
          corr.action += vPick - exp;
        }
      } else {
        na = normalize(actor, seat.act(v));
      }
      // Tracker-style kind and the log entry (pot and stack before the action).
      const facing = Math.max(0, g.cur - g.bet[actor]);
      const potBefore = g.put.reduce((a, b) => a + b, 0);
      const stackBefore = g.stack[actor];
      let kind = na.t;
      if (na.t === 'raise') kind = nb === 0 ? (g.raises >= 1 ? '3bet' : 'raise') : (g.cur > 0 ? 'raise' : 'bet');
      // Socket event first, with the snapshot from before the action (onAny fires before the game updates).
      ev('player:game:action_taken', { playerID: actor + 1, actionType: na.t, makeBetValue: na.add });
      // Answers to the current bet so far: calls and folds since the last bet or raise.
      if (na.t === 'raise') { g.callsNow = 0; g.foldsNow = 0; } else if (na.t === 'call') g.callsNow++; else if (na.t === 'fold') g.foldsNow++;
      if (na.t === 'fold') g.folded[actor] = true;
      else {
        g.stack[actor] -= na.add; g.bet[actor] += na.add; g.put[actor] += na.add;
        if (na.t === 'raise') {
          g.lastRaise = Math.max(g.lastRaise, na.to - g.cur); g.cur = na.to; g.raises++; g.lastAgg = actor;
          if (nb === 0) g.pfAgg = actor;
          acted.fill(false);
        }
        if (nb === 0 && na.t === 'call' && g.raises === 0) { g.limpers++; g.limped[actor] = true; }
      }
      g.seq[actor][STREET_KEY[nb]].push(kind);
      if (log) {
        const e = { st: STREET_KEY[nb], who: names[actor], act: kind, amt: na.add, to: g.bet[actor], pot: potBefore, facing, stack: stackBefore };
        if (actor === hero) e.hero = true;
        if (potBefore > 0 && na.t === 'raise') e.potPct = Math.round(100 * Math.max(0, na.add - facing) / (potBefore + facing));
        if (na.t !== 'fold' && na.t !== 'check' && g.stack[actor] === 0) e.allin = true;
        log.push(e);
      }
      acted[actor] = true;
      g.nAct++;
      actor = (actor + 1) % n;
    }
    if (live().length < 2) break;
  }
  ev('game:stage_began', { stageType: 'showdown' });
  const lv = live();
  const scores = g.hands.map((h, i) => (g.folded[i] ? -1 : E.evaluate(h.concat(g.boardAll), 7)));
  const back = payouts(g.put, g.folded, scores, new Float64Array(n));
  const nets = g.put.map((p, i) => back[i] - p);
  const shown = g.hands.map(() => []);
  if (lv.length >= 2) {
    g.board = g.boardAll;
    for (const i of lv) {
      if (i !== hero) shown[i] = g.hands[i].map(E.cardToString);
      // Each listener sees the others' cards turned over (not its own again).
      for (const l of listeners) {
        if (l.seat === i) continue;
        evTo(l, 'game:update_card_data', { cardData: cardData(g.hands[i][0], uids[i][0]) });
        evTo(l, 'game:update_card_data', { cardData: cardData(g.hands[i][1], uids[i][1]) });
      }
    }
  }
  ev('game:game_ended', {});
  const res = { net: nets[hero], nets, chance: corr.chance, action: corr.action, adj: nets[hero] - corr.chance - corr.action, showdown: lv.length >= 2, parts: corr.parts || [] };
  if (flopInfo) res.flop = Object.assign(flopInfo, { ca: corr.chance + corr.action, net: nets[hero] });
  if (log) {
    res.entry = {
      board: g.board.map(E.cardToString), bigBlind: bb, hero: g.hands[hero].map(E.cardToString), log,
      players: g.hands.map((_, i) => ({ name: names[i], hero: i === hero, position: pos[i], folded: g.folded[i], stack: g.start[i], put: g.put[i], actions: g.seq[i], shown: shown[i] })),
      net: Object.fromEntries(names.map((nm, i) => [nm, nets[i]])),
    };
  }
  return res;
}

module.exports = { playHand, payouts, posGroup, seatOrderFrom, rng32, keyed, shuffled, ValueFn };
