// Heads-up simulation: agent (solver or baseline) vs a scripted amateur bot.
// Usage: node test/sim.js <hands> <solver|baseline> <station|typical|maniac> <seed>
// Env: DUP=1 plays every deal twice with the seats and cards swapped (cuts card luck),
// PF=0 turns the preflop solver off, PFIT=<n> sets its iterations, TURN=1 turns the turn
// solver on (TURNIT=<n> iterations), TAG=<name> is added to the output file name.
// Plays the solver (driven through the real tracker, like the overlay) or a simple solid
// rule-based bot against a scripted amateur. Same seed = same deals, so solver and
// baseline runs can be compared hand by hand. Per-hand results go to test/out/.
const E = require('../src/engine.js');
const T = require('../src/tracker.js');
const [,, HANDS = '200', AGENT = 'solver', BOT = 'typical', SEED = '1'] = process.argv;
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });
const BB = 10, SB = 5, START = 1000;
function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const RANKS = '23456789TJQKA', SUITN = ['clubs', 'diamonds', 'hearts', 'spades'];
const cstr = (c) => RANKS[c >> 2] + 'cdhs'[c & 3];
const cdata = (c, uid) => ({ uniqueID: uid, suite: SUITN[c & 3], value: RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2] });

// preflop strength 0..1 (1 = AA)
const ORDER = {}; E.PREFLOP_ORDER.forEach((n, i) => { ORDER[n] = i; });
function pfStrength(h) {
  const a = Math.max(h[0] >> 2, h[1] >> 2), b = Math.min(h[0] >> 2, h[1] >> 2);
  const n = a === b ? RANKS[a] + RANKS[b] : RANKS[a] + RANKS[b] + ((h[0] & 3) === (h[1] & 3) ? 's' : 'o');
  return 1 - ORDER[n] / 168;
}
function post(h, board) {
  const hp = E.handPercentile(h, board);
  const d = board.length < 5 ? (E.describeHero(h, board).draws || []).filter((x) => x.outs >= 7).length > 0 : false;
  return { hp, drawy: d };
}

// ---------- bots ----------
const BOTS = {
  // Loose-passive "calling station": plays most hands, calls too much, rarely bluffs.
  station: { vpip: 0.35, pfRaise: 0.9, threebet: 0.95, callRaise: 0.4, betHp: 0.8, bluff: 0.06, raiseHp: 0.96, callBase: 0.3, callSlope: 0.1, drawCall: true },
  // Typical home-game amateur: loose-ish, sometimes aggressive, folds too much to big bets.
  typical: { vpip: 0.5, pfRaise: 0.85, threebet: 0.94, callRaise: 0.55, betHp: 0.75, bluff: 0.15, raiseHp: 0.94, callBase: 0.45, callSlope: 0.25, drawCall: true },
  // Aggressive amateur: raises a lot, bluffs a lot.
  maniac: { vpip: 0.3, pfRaise: 0.6, threebet: 0.85, callRaise: 0.45, betHp: 0.6, bluff: 0.35, raiseHp: 0.85, callBase: 0.4, callSlope: 0.15, drawCall: true },
};
function botAct(cfg, g, me, r) {
  const h = g.hands[me], toCall = g.cur - g.bet[me], pot = g.pot + g.bet[0] + g.bet[1];
  if (g.board.length === 0) {
    const s = pfStrength(h);
    if (toCall <= (me === g.btn ? SB : 0) || g.raises === 0) {
      if (s > cfg.pfRaise && r() < 0.7) return { t: 'raise', to: 3 * BB };
      if (s > 1 - cfg.vpip - 0.5 * (1 - cfg.vpip) * 0 && s > 1 - (1 - cfg.vpip)) return toCall ? { t: 'call' } : { t: 'check' };
      if (s > cfg.vpip) return toCall ? { t: 'call' } : { t: 'check' };
      return toCall ? { t: 'fold' } : { t: 'check' };
    }
    if (s > cfg.threebet && g.raises < 3 && r() < 0.6) return { t: 'raise', to: g.cur * 3 };
    if (s > cfg.callRaise || (toCall <= 3 * BB && s > cfg.callRaise - 0.15)) return { t: 'call' };
    return { t: 'fold' };
  }
  const { hp, drawy } = post(h, g.board);
  if (toCall === 0) {
    if ((hp > cfg.betHp && r() < 0.7) || r() < cfg.bluff) return { t: 'raise', to: Math.round((0.5 + 0.3 * r()) * pot) };
    return { t: 'check' };
  }
  const f = toCall / Math.max(1, pot - toCall);
  if (hp > cfg.raiseHp && r() < 0.5 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
  if (hp > cfg.callBase + cfg.callSlope * Math.min(f, 2) || (cfg.drawCall && drawy && f < 1.2)) return { t: 'call' };
  return { t: 'fold' };
}

// ---------- baseline: a decent rule-based regular ----------
function baselineAct(g, me, r) {
  const h = g.hands[me], toCall = g.cur - g.bet[me], pot = g.pot + g.bet[0] + g.bet[1];
  if (g.board.length === 0) {
    const s = pfStrength(h);
    if (g.raises === 0) {
      if (me === g.btn) return s > 0.45 ? { t: 'raise', to: 2.5 * BB } : { t: 'fold' };
      return s > 0.75 ? { t: 'raise', to: 3.5 * BB } : { t: 'check' };
    }
    if (s > 0.92 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
    if (s > 0.55 || (toCall <= 2 * BB && s > 0.4)) return { t: 'call' };
    return { t: 'fold' };
  }
  const { hp, drawy } = post(h, g.board);
  if (toCall === 0) {
    if (hp > 0.78 || (drawy && r() < 0.5) || (g.pfAgg === me && g.board.length === 3 && r() < 0.6)) return { t: 'raise', to: Math.round(0.66 * pot) };
    return { t: 'check' };
  }
  const f = toCall / Math.max(1, pot - toCall);
  if (hp > 0.94 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
  if (hp > 0.5 + 0.12 * Math.min(f, 2) || (drawy && f < 0.9)) return { t: 'call' };
  return { t: 'fold' };
}

// ---------- solver agent through the real tracker ----------
const tracker = new T({ players: {} });
tracker.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
let uidN = 1;
function snap(g) {
  return { tableType: 'private', heroAuthId: 'H', bigBlind: BB, players: [
    { id: 1, authUserId: 'H', name: 'Hero', stack: g.stack[0], posType: 's1', playState: g.folded[0] ? 'folded' : 'playing' },
    { id: 2, authUserId: 'B', name: 'Bot', stack: g.stack[1], posType: 's2', playState: g.folded[1] ? 'folded' : 'playing' }] };
}
const ev = (g, e, d) => { if (AGENT === 'solver') tracker.handle(e, d, snap(g)); };
let lastAdvice = null;
function solverAct(g, me, r) {
  const b = tracker.solverInput('typical');
  if (b.error) { stats.errors++; return baselineAct(g, me, r); }
  const res = E.analyzeSync(Object.assign({}, b.input, { iterations: 3000, riverIterations: 120, seed: (r() * 4294967296) >>> 0 },
    process.env.PF === '0' ? { preflopSolver: false } : {}, process.env.PFIT ? { preflopIterations: +process.env.PFIT } : {},
    process.env.TURN === '1' ? { turnSolver: true, turnIterations: +(process.env.TURNIT || 30) } : {}));
  const best = res.best;
  if (process.env.DIAG) DIAG.push({ st: g.board.length, facing: b.input.toCall > 0, f: b.input.toCall / Math.max(1, b.input.pot - b.input.toCall), kind: best.kind, amt: best.amount, toCall: b.input.toCall, pot: b.input.pot, btn: g.btn === 0, cards: g.hands[0].map(cstr).join(''), hp: g.board.length ? E.handPercentile(g.hands[0], g.board) : pfStrength(g.hands[0]), eq: res.equity && res.equity.share, solver: res.solver && res.solver.kind, hand: CURHAND });
  if (best.kind === 'fold') return { t: 'fold' };
  if (best.kind === 'check') return { t: 'check' };
  if (best.kind === 'call') return { t: 'call' };
  return { t: 'raise', to: g.bet[me] + best.amount };
}

// ---------- game ----------
const DIAG = []; let CURHAND = 0;
const stats = { net: 0, hands: 0, errors: 0, sq: 0 };
function play(handNo, rs, swap) {
  const r = rng32(rs);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const btn = swap ? 1 - (handNo % 2) : handNo % 2; // 0 = hero on button
  const hands = swap ? [[deck[2], deck[3]], [deck[0], deck[1]]] : [[deck[0], deck[1]], [deck[2], deck[3]]];
  const g = { hands, boardAll: deck.slice(4, 9), board: [], stack: [START, START], bet: [0, 0], pot: 0, cur: 0, folded: [false, false], btn, raises: 0, pfAgg: -1 };
  const botR = rng32(rs ^ 0xabcdef);
  const agentR = rng32(rs ^ 0x123457);
  const sbP = btn, bbP = 1 - btn;
  ev(g, 'game:stage_began', { stageType: 'set_blinds' });
  ev(g, 'game:dealer_updated', { dealerSeatPos: btn === 0 ? 's1' : 's2' });
  const blind = (p, a) => { g.stack[p] -= a; g.bet[p] = a; };
  blind(sbP, SB); ev(g, 'game:small_blind_paid', { amount: SB, playerId: sbP + 1 });
  blind(bbP, BB); ev(g, 'game:big_blind_paid', { amount: BB, playerId: bbP + 1 });
  g.cur = BB;
  const u = [uidN++, uidN++, uidN++, uidN++];
  ev(g, 'game:cards_dealt_to_player', [{ playerPos: 's1', cardData: { uniqueID: u[0] } }, { playerPos: 's2', cardData: { uniqueID: u[2] } }, { playerPos: 's1', cardData: { uniqueID: u[1] } }, { playerPos: 's2', cardData: { uniqueID: u[3] } }]);
  ev(g, 'game:update_card_data', { cardData: cdata(g.hands[0][0], u[0]) });
  ev(g, 'game:update_card_data', { cardData: cdata(g.hands[0][1], u[1]) });
  const streets = [['pre_flop', 0], ['flop', 3], ['turn', 4], ['river', 5]];
  let allin = false;
  for (const [name, n] of streets) {
    if (n > 0) {
      g.pot += g.bet[0] + g.bet[1]; g.bet = [0, 0]; g.cur = 0; g.raises = 0;
      ev(g, 'game:stage_began', { stageType: name });
      const add = g.boardAll.slice(g.board.length, n);
      g.board = g.boardAll.slice(0, n);
      ev(g, 'game:cards_deal_to_stack', add.map((c) => ({ emitData: { stackID: 'community_stack', cardData: cdata(c, uidN++) } })));
    } else ev(g, 'game:stage_began', { stageType: name });
    if (allin) continue;
    let actor = n === 0 ? sbP : bbP, acted = [false, false];
    while (true) {
      if (g.folded[0] || g.folded[1]) break;
      if (acted[0] && acted[1] && g.bet[0] === g.bet[1]) break;
      if (g.stack[actor] === 0) { acted[actor] = true; if (acted[1 - actor] && (g.bet[actor] <= g.cur)) break; actor = 1 - actor; if (acted[0] && acted[1]) break; continue; }
      let a;
      if (actor === 0) { ev(g, 'game:player_turn_started', { playerID: 1 }); a = AGENT === 'solver' ? solverAct(g, 0, agentR) : baselineAct(g, 0, agentR); }
      else a = botAct(BOTS[BOT], g, 1, botR);
      const toCall = g.cur - g.bet[actor];
      if (a.t === 'check' && toCall > 0) a = { t: 'fold' };
      if (a.t === 'call' && toCall === 0) a = { t: 'check' };
      let added = 0, type = a.t;
      if (a.t === 'fold') { g.folded[actor] = true; }
      else if (a.t === 'call') { added = Math.min(toCall, g.stack[actor]); }
      else if (a.t === 'raise') {
        const minTo = g.cur + Math.max(BB, g.cur - (g.raises ? g.cur / 3 : 0));
        let to = Math.max(Math.round(a.to), Math.min(minTo, g.bet[actor] + g.stack[actor]));
        to = Math.min(to, g.bet[actor] + g.stack[actor]);
        const other = 1 - actor; to = Math.min(to, g.bet[other] + g.stack[other] > g.cur ? Math.max(g.cur, g.bet[other] + g.stack[other]) : to);
        if (to <= g.cur) { type = toCall > 0 ? 'call' : 'check'; added = Math.min(toCall, g.stack[actor]); }
        else { added = to - g.bet[actor]; g.cur = to; g.raises++; type = 'raise'; if (n === 0) g.pfAgg = actor; acted = [false, false]; }
      }
      g.stack[actor] -= added; g.bet[actor] += added;
      ev(g, 'player:game:action_taken', { playerID: actor + 1, actionType: type, makeBetValue: added });
      acted[actor] = true;
      actor = 1 - actor;
    }
    if (g.folded[0] || g.folded[1]) break;
    if (g.stack[0] === 0 || g.stack[1] === 0) allin = true;
  }
  g.pot += g.bet[0] + g.bet[1];
  // refund unmatched
  let net;
  const put0 = START - g.stack[0], put1 = START - g.stack[1];
  const matched = Math.min(put0, put1);
  ev(g, 'game:stage_began', { stageType: 'showdown' });
  if (g.folded[0]) net = -put0;
  else if (g.folded[1]) net = put1;
  else {
    g.board = g.boardAll;
    const s0 = E.evaluate(g.hands[0].concat(g.board), 7), s1 = E.evaluate(g.hands[1].concat(g.board), 7);
    net = s0 > s1 ? matched : s0 < s1 ? -matched : 0;
    ev(g, 'game:update_card_data', { cardData: cdata(g.hands[1][0], u[2]) });
    ev(g, 'game:update_card_data', { cardData: cdata(g.hands[1][1], u[3]) });
  }
  ev(g, 'game:game_ended', {});
  return net;
}
const NETS = [];
const N = +HANDS, base = +SEED * 100000;
const t0 = Date.now();
const DUP = process.env.DUP === '1';
const PAIRS = [];
for (let i = 0; i < N; i++) {
  CURHAND = i;
  const d = DUP ? i >> 1 : i;
  const net = play(d, base + d, DUP && (i & 1) === 1);
  NETS.push(net); stats.net += net; stats.sq += net * net; stats.hands++;
  if (DUP && (i & 1)) PAIRS.push(NETS[i - 1] + net);
}
const mean = stats.net / N;
// With DUP the spread comes from the pairs (both seats of a deal), which is much smaller.
const sd = DUP ? Math.sqrt(PAIRS.reduce((a, x) => a + x * x, 0) / PAIRS.length - (2 * mean) ** 2) / Math.SQRT2 : Math.sqrt(stats.sq / N - mean * mean);
if (process.env.DIAG) require('fs').writeFileSync(require('path').join(OUT, 'diag_') + BOT + (process.env.TAG ? '_' + process.env.TAG : '') + '.json', JSON.stringify({ DIAG, NETS }));
require('fs').writeFileSync(require('path').join(OUT, 'nets_') + AGENT + '_' + BOT + '_' + SEED + (process.env.TAG ? '_' + process.env.TAG : '') + (DUP ? '_dup' : '') + '.json', JSON.stringify(NETS));
console.log(JSON.stringify({ agent: AGENT, bot: BOT, hands: N, bb100: (mean / BB) * 100, se100: (sd / Math.sqrt(N) / BB) * 100, errors: stats.errors, sec: (Date.now() - t0) / 1000 }));
