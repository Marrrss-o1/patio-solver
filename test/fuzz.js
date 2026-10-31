// Random spots and random hands for property tests (used by replay.test.js).
//
// randomSpot(r)      a consistent analyzeSync input: 1-5 opponents, any street, short and all-in
//                    stacks, chips already in on the street. The stack is effective, like the tracker's.
// adviceProblems(i, res)  what is wrong with an analysis: illegal or duplicate options, amounts outside
//                    0..stack, EVs that are not finite or outside what can be lost or won, bad mixes.
// randomHand(r, opts) a whole hand in the game's socket format (see docs/protocol.md): seats on the
//                    real ring (s3_v2 between s9 and s10), blinds, random legal play to showdown or a
//                    fold. Returns the messages for replay() plus, at every hero turn, the truth the
//                    tracker should report (pot, to call, chips behind, who acts after hero).
'use strict';

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = (r) => (a) => a[Math.floor(r() * a.length)];
function shuffled(r) {
  const deck = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  for (let i = 51; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

function randomSpot(r, extra) {
  const pick = pickOf(r);
  const deck = shuffled(r);
  const street = pick([0, 0, 3, 4, 5, 5]);
  const hero = deck.slice(0, 2), board = deck.slice(2, 2 + street);
  const bb = pick([2, 10]);
  const nOpp = pick([1, 1, 2, 3, 4, 5]);
  const cur = ['pre', null, null, 'flop', 'turn', 'river'][street];
  const heroStart = Math.round(bb * pick([8, 20, 50, 100, 150, 300]));
  const heroCommitted = Math.round(r() * Math.min(heroStart * 0.6, bb * 30));
  const heroBet = street === 0 ? Math.min(heroCommitted, pick([0, bb / 2, bb, bb * 3])) : Math.min(heroCommitted, pick([0, 0, bb * 2]));
  const opponents = [];
  let pot = heroCommitted, maxBet = heroBet;
  for (let i = 0; i < nOpp; i++) {
    const committed = Math.max(0, Math.round(heroCommitted + (r() - 0.4) * bb * 20));
    const stack = pick([0, Math.round(r() * bb * 10), Math.round(bb * pick([20, 60, 100, 250]))]);
    const bet = Math.min(committed, Math.round(pick([0, heroBet, heroBet + bb * pick([1, 2, 5, 20])])));
    const actions = {};
    for (const nm of ['pre', 'flop', 'turn', 'river']) {
      if (nm === cur) { actions[nm] = street === 0 ? pick(['pending', 'call', 'raise', '3bet', 'check']) : pick(['', 'check', 'bet', 'call', 'raise', 'checkcall', 'checkraise', 'betcall']); break; }
      actions[nm] = nm === 'pre' ? pick(['call', 'raise', '3bet', 'check']) : pick(['check', 'bet', 'call', 'checkcall', 'raise']);
    }
    opponents.push({ name: 'V' + i, tally: {}, actions, stack, committed, bet, heroIP: r() < 0.5, sizes: r() < 0.5 ? { [cur]: pick([0.33, 0.5, 1, 1.5]) } : {} });
    pot += committed;
    maxBet = Math.max(maxBet, bet);
  }
  const heroLeft = Math.max(0, heroStart - heroCommitted);
  const stack = Math.min(heroLeft, Math.max(...opponents.map((o) => o.stack + o.bet - heroBet)));
  const toCall = Math.min(Math.max(0, maxBet - heroBet), stack);
  if (street > 0) pot = Math.max(pot, 2 * bb);
  // Hero only gets a turn if there is a bet to answer or someone who can still bet.
  if (!(stack > 0) || (toCall <= 0 && !opponents.some((o) => o.stack > 0))) return null;
  return Object.assign({
    hero, board, pot, toCall, stack, bigBlind: bb, inPosition: r() < 0.5, heroCommitted, heroBet, opponents,
    heroActions: street > 0 ? { pre: pick(['call', 'raise']) } : {}, mix: r() < 0.5, seed: Math.floor(r() * 1e9),
    iterations: 600, riverIterations: 30, preflopIterations: 30,
  }, extra || {});
}

function adviceProblems(inp, res) {
  const out = [];
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  if (!res || !res.ranked || !res.ranked.length) return ['no options'];
  if (!res.best || !res.ranked.some((s) => s.kind === res.best.kind && near(s.amount, res.best.amount))) out.push('best is not one of the options');
  const stack = inp.stack > 0 ? inp.stack : Infinity;
  const potWin = res.potWin != null ? res.potWin : inp.pot;
  // Hero can win at most the pot plus what the opponents can put in to match hero.
  const maxWin = potWin + inp.opponents.reduce((a, o) => a + (o.stack != null ? Math.min(o.stack, stack + (inp.heroBet || 0)) : stack), 0) + 1e-6;
  const seen = new Set();
  for (const s of res.ranked) {
    const lbl = `${s.kind} ${s.amount}`;
    if (seen.has(lbl)) out.push(`${lbl} listed twice`);
    seen.add(lbl);
    if (!isFinite(s.ev)) out.push(`${lbl}: EV ${s.ev}`);
    if (s.amount < -1e-9 || s.amount > stack + 1e-9) out.push(`${lbl}: amount outside 0..${stack}`);
    if (inp.toCall > 0 && (s.kind === 'check' || s.kind === 'bet')) out.push(`${lbl}: not allowed facing a bet`);
    if (inp.toCall <= 0 && (s.kind === 'fold' || s.kind === 'call')) out.push(`${lbl}: nothing to call`);
    if (s.kind === 'call' && !near(s.amount, Math.min(inp.toCall, stack))) out.push(`${lbl}: call is not the amount to call (${inp.toCall})`);
    if (s.kind === 'raise' && s.amount < 2 * inp.toCall - 1e-9) out.push(`${lbl}: raise smaller than a min-raise (to call ${inp.toCall})`);
    if (s.kind === 'raise' && s.amount >= stack - 1e-9) out.push(`${lbl}: the whole stack is an all-in, not a raise`);
    if (s.kind === 'bet' && s.amount < Math.min(inp.bigBlind, stack) - 1e-9) out.push(`${lbl}: bet smaller than the big blind`);
    if (s.kind === 'allin' && !near(s.amount, stack)) out.push(`${lbl}: all-in is not the whole stack (${stack})`);
    if (s.ev < -stack - 1e-6) out.push(`${lbl}: EV ${s.ev.toFixed(1)} loses more than the stack`);
    if (s.ev > maxWin) out.push(`${lbl}: EV ${s.ev.toFixed(1)} wins more than is there (${maxWin.toFixed(1)})`);
    if (s.kind === 'fold' && !near(s.ev, 0)) out.push(`fold EV ${s.ev}`);
    if (s.freq != null && !(s.freq >= -1e-9 && s.freq <= 1 + 1e-9)) out.push(`${lbl}: frequency ${s.freq}`);
  }
  const fs = res.ranked.reduce((a, s) => a + (s.freq || 0), 0);
  if (fs > 1e-9 && Math.abs(fs - 1) > 1e-3) out.push(`frequencies add up to ${fs.toFixed(3)}`);
  if (!(res.equity && res.equity.share >= 0 && res.equity.share <= 1)) out.push('equity outside 0..1');
  if (!(res.potOdds >= 0 && res.potOdds < 1)) out.push(`pot odds ${res.potOdds}`);
  return out;
}

// ---------------------------------------------------------------------------
// Whole hands in the socket format.
// ---------------------------------------------------------------------------
const RING = ['s1', 's5', 's7', 's8', 's9', 's3_v2', 's10']; // clockwise at the owner's tables
const RANKS = '23456789TJQKA', SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const cardData = (c, uid) => ({ uniqueID: uid, value: RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2], suite: SUITS[c & 3] });

function randomHand(r, opts) {
  const pick = pickOf(r);
  const o = Object.assign({ players: 2 + Math.floor(r() * 5), bb: pick([2, 10]) }, opts || {});
  const n = Math.min(o.players, RING.length);
  const bb = o.bb, sb = bb / 2;
  // Seats: n of the ring, kept in ring order.
  const seats = RING.map((s, i) => [s, r()]).sort((a, b) => a[1] - b[1]).slice(0, n).map((x) => x[0]).sort((a, b) => RING.indexOf(a) - RING.indexOf(b));
  const P = seats.map((pos, i) => ({
    id: i + 1, pos, name: i === 0 ? 'Hero' : 'P' + i, auth: i === 0 ? 'H' : 'A' + i,
    stack: Math.round(bb * pick([3, 12, 40, 100, 150, 300]) * (0.6 + 0.8 * r())), put: 0, street: 0, folded: false,
  }));
  const heroIdx = Math.floor(r() * n);
  // The hero is whoever sits at heroIdx; rename so the hero is always 'Hero' / auth 'H'.
  P.forEach((p, i) => { p.name = i === heroIdx ? 'Hero' : 'P' + (i + 1); p.auth = i === heroIdx ? 'H' : 'A' + (i + 1); });
  const hero = P[heroIdx];
  const d = Math.floor(r() * n);
  const at = (k) => P[((k % n) + n) % n];
  const dealer = at(d), sbP = n === 2 ? dealer : at(d + 1), bbP = n === 2 ? at(d + 1) : at(d + 2), utg = n === 2 ? dealer : at(d + 3);
  const msgs = [], truth = [];
  const snap = () => ({ tableType: 'private', heroAuthId: 'H', bigBlind: bb,
    players: P.map((p) => ({ id: p.id, authUserId: p.auth, name: p.name, stack: p.stack, posType: p.pos, playState: p.folded ? 'folded' : 'playing' })) });
  const push = (ev, data) => msgs.push({ ev, data, snap: snap() });
  const put = (p, x) => { x = Math.min(x, p.stack); p.stack -= x; p.put += x; p.street += x; return x; };

  push('game:stage_began', { stageType: 'set_blinds' });
  push('game:dealer_updated', { dealerSeatPos: dealer.pos, dealerPlayerID: dealer.id, smallBlindSeatPos: sbP.pos, smallBlindPlayerID: sbP.id,
    bigBlindSeatPos: bbP.pos, bigBlindPlayerID: bbP.id, underTheGunSeatPos: utg.pos, underTheGunPlayerID: utg.id });
  push('game:small_blind_paid', { amount: Math.min(sb, sbP.stack), playerId: sbP.id }); put(sbP, sb);
  push('game:big_blind_paid', { amount: Math.min(bb, bbP.stack), playerId: bbP.id }); put(bbP, bb);
  const deck = shuffled(r);
  let uid = 1000;
  const dealt = [];
  for (let k = 0; k < 2; k++) for (const p of P) dealt.push({ playerPos: p.pos, cardData: { uniqueID: ++uid }, card: deck.pop() });
  push('game:cards_dealt_to_player', dealt.map((x) => ({ playerPos: x.playerPos, cardData: { uniqueID: x.cardData.uniqueID } })));
  for (const x of dealt) if (x.playerPos === hero.pos) push('game:update_card_data', { cardData: cardData(x.card, x.cardData.uniqueID), flipCard: true });
  const board = [];

  // Postflop order: first seat after the dealer; preflop: UTG first (heads-up the dealer / SB).
  const post = []; for (let k = 1; k <= n; k++) post.push(at(d + k));
  const pre = n === 2 ? [dealer, bbP] : (() => { const s = []; const u = P.indexOf(utg); for (let k = 0; k < n; k++) s.push(at(u + k)); return s; })();
  const alive = () => P.filter((p) => !p.folded);
  const canAct = () => P.filter((p) => !p.folded && p.stack > 0);
  const stages = [['pre_flop', 0], ['flop', 3], ['turn', 4], ['river', 5]];
  for (const [stage, cards] of stages) {
    if (alive().length < 2) break;
    if (cards) {
      for (const p of P) p.street = 0;
      push('game:stage_began', { stageType: stage });
      const add = [];
      while (board.length < cards) { const c = deck.pop(); board.push(c); add.push({ emitData: { stackID: 'community_stack', cardData: cardData(c, ++uid) } }); }
      push('game:cards_deal_to_stack', add);
    } else push('game:stage_began', { stageType: stage });
    const order = cards ? post : pre;
    let current = Math.max(...P.map((p) => p.street)), lastInc = bb;
    // Everyone with chips must act; a bet or raise reopens the action for the others.
    const needs = new Set(order.filter((p) => !p.folded && p.stack > 0));
    for (let k = 0; needs.size && k < 400; k++) {
      const p = order[k % n];
      if (!needs.has(p)) continue;
      needs.delete(p);
      if (p.folded || p.stack <= 0) continue;
      const facing = current - p.street;
      // Matched, and nobody else can bet: no turn.
      if (facing <= 0 && !alive().some((x) => x !== p && x.stack > 0)) continue;
      if (p === hero) {
        const live = alive().filter((x) => x !== hero);
        const maxOpp = Math.max(...live.map((x) => x.stack + x.street - hero.street));
        const stack = Math.min(hero.stack, Math.max(maxOpp, facing));
        const at0 = post.indexOf(hero);
        truth.push({ street: board.length, pot: P.reduce((a, x) => a + x.put, 0), toCall: Math.min(facing, stack), stack,
          opponents: post.slice(at0 + 1).concat(post.slice(0, at0)).filter((x) => !x.folded)
            .map((x) => ({ name: x.name, committed: x.put, stack: x.stack, bet: x.street, heroIP: post.indexOf(x) < at0 })) });
      }
      push('game:player_turn_started', { playerID: p.id, playerPos: p.pos, turnTimeDurationMS: 23000, turnTimeElapsedMS: 0 });
      // A random legal action.
      const u = r();
      let type, amt = 0;
      const othersCanCall = alive().some((x) => x !== p && x.stack > 0);
      if (facing > 0) {
        if (u < 0.25) type = 'fold';
        else if (u < 0.75 || p.stack <= facing || !othersCanCall) { type = 'call'; amt = Math.min(facing, p.stack); }
        else {
          const minTo = current + lastInc;
          const maxTo = p.street + p.stack;
          const to = Math.min(maxTo, Math.round(minTo + r() * r() * Math.max(0, maxTo - minTo)));
          type = 'raise'; amt = to - p.street;
        }
      } else if (u < 0.55) type = 'check';
      else { type = 'raise'; amt = Math.min(p.stack, Math.max(bb, Math.round(r() * r() * p.stack))); }
      if (type === 'fold') {
        push('player:game:player_play_state_changed', { newPlayState: 'folded', userId: p.auth });
        p.folded = true;
        push('player:game:action_taken', { actionType: 'fold', makeBetValue: 0, playerID: p.id, playerPos: p.pos, wasServerAutoAction: false });
      } else {
        push('player:game:action_taken', { actionType: type, makeBetValue: amt, playerID: p.id, playerPos: p.pos, wasServerAutoAction: false });
        put(p, amt);
        if (p.street > current) {
          if (p.street - current >= lastInc) lastInc = p.street - current;
          current = p.street;
          for (const x of order) if (x !== p && !x.folded && x.stack > 0) needs.add(x);
        }
      }
      push('game:player_turn_ended', { playerID: p.id, playerPos: p.pos });
      if (alive().length < 2) break;
    }
    push('game:stage_ended', { stageType: stage });
  }
  const total = P.reduce((a, x) => a + x.put, 0);
  if (alive().length >= 2) push('game:stage_began', { stageType: 'showdown' });
  push('game:game_ended', { endPopupData: { gameResults: { gameResult: 'one_winner', sidePotsWithWinners: [{ isMainPot: true, isUncalledBet: false, netPotAmount: total }] } } });
  return { msgs, truth, players: P, hero };
}

module.exports = { rng32, randomSpot, adviceProblems, randomHand };
