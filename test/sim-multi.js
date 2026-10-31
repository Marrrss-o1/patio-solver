// Multiway simulation: hero (solver or baseline) vs 2-5 scripted amateur bots at one table.
// Usage: node test/sim-multi.js <hands> <solver|baseline> <players 3-6> <station|typical|maniac|mixed> <seed>
// Same seed = same deals and bot decisions, so solver and baseline runs compare hand by hand.
// DUP=1 (default) replays every deal once per seat, giving hero each seat's cards in turn and
// averaging, which cancels most of the card luck. DIAG=1 writes every hero decision to test/out.
const E = require(process.env.ENGINE || '../src/engine.js');
const T = require('../src/tracker.js');
const [,, HANDS = '200', AGENT = 'solver', NP = '4', BOTMIX = 'mixed', SEED = '1'] = process.argv;
const OUT = require('path').join(__dirname, 'out'); require('fs').mkdirSync(OUT, { recursive: true });
const BB = 10, SB = 5, START = 1000, N = +NP;
function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const RANKS = '23456789TJQKA', SUITN = ['clubs', 'diamonds', 'hearts', 'spades'];
const cdata = (c, uid) => ({ uniqueID: uid, suite: SUITN[c & 3], value: RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2] });
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
const BOTS = {
  station: { vpip: 0.35, pfRaise: 0.9, threebet: 0.95, callRaise: 0.4, betHp: 0.8, bluff: 0.06, raiseHp: 0.96, callBase: 0.3, callSlope: 0.1, drawCall: true },
  typical: { vpip: 0.5, pfRaise: 0.85, threebet: 0.94, callRaise: 0.55, betHp: 0.75, bluff: 0.15, raiseHp: 0.94, callBase: 0.45, callSlope: 0.25, drawCall: true },
  maniac: { vpip: 0.3, pfRaise: 0.6, threebet: 0.85, callRaise: 0.45, betHp: 0.6, bluff: 0.35, raiseHp: 0.85, callBase: 0.4, callSlope: 0.15, drawCall: true },
};
const MIX = ['typical', 'station', 'maniac', 'typical', 'station'];
const botCfg = (i) => BOTS[BOTMIX === 'mixed' ? MIX[(i - 1) % MIX.length] : BOTMIX];
const potOf = (g) => g.pot + g.bet.reduce((a, b) => a + b, 0);
const live = (g) => g.folded.map((f, i) => (f ? -1 : i)).filter((i) => i >= 0);

function botAct(cfg, g, me, r) {
  const h = g.hands[me], toCall = g.cur - g.bet[me], pot = potOf(g);
  const nOpp = live(g).length - 1;
  if (g.board.length === 0) {
    const s = pfStrength(h);
    if (g.raises === 0) {
      if (s > cfg.pfRaise && r() < 0.7) return { t: 'raise', to: 3 * BB + BB * g.limpers };
      if (s > cfg.vpip) return toCall ? { t: 'call' } : { t: 'check' };
      return toCall ? { t: 'fold' } : { t: 'check' };
    }
    if (s > cfg.threebet && g.raises < 3 && r() < 0.6) return { t: 'raise', to: g.cur * 3 };
    if (s > cfg.callRaise || (toCall <= 3 * BB && s > cfg.callRaise - 0.15)) return { t: 'call' };
    return { t: 'fold' };
  }
  const { hp, drawy } = post(h, g.board);
  // Multiway, amateurs tighten up a little: they need more to bet and to call.
  const tight = 0.03 * Math.max(0, nOpp - 1);
  if (toCall === 0) {
    if ((hp > cfg.betHp + tight && r() < 0.7) || r() < cfg.bluff / Math.max(1, nOpp)) return { t: 'raise', to: Math.round((0.5 + 0.3 * r()) * pot) };
    return { t: 'check' };
  }
  const f = toCall / Math.max(1, pot - toCall);
  if (hp > cfg.raiseHp && r() < 0.5 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
  if (hp > cfg.callBase + tight + cfg.callSlope * Math.min(f, 2) || (cfg.drawCall && drawy && f < 1.2)) return { t: 'call' };
  return { t: 'fold' };
}

// A decent rule-based regular, tightened for multiway pots.
function baselineAct(g, me, r) {
  const h = g.hands[me], toCall = g.cur - g.bet[me], pot = potOf(g);
  const nOpp = live(g).length - 1;
  const late = g.posOf(me) === 'late';
  if (g.board.length === 0) {
    const s = pfStrength(h);
    if (g.raises === 0) {
      const need = late ? 0.55 : 0.7;
      if (s > need) return { t: 'raise', to: 3 * BB + BB * g.limpers };
      if (toCall === 0) return { t: 'check' };
      return s > 0.5 && g.limpers > 0 ? { t: 'call' } : { t: 'fold' };
    }
    if (s > 0.92 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
    if (s > 0.62 || (toCall <= 2 * BB && s > 0.45)) return { t: 'call' };
    return { t: 'fold' };
  }
  const { hp, drawy } = post(h, g.board);
  const tight = 0.04 * Math.max(0, nOpp - 1);
  if (toCall === 0) {
    if (hp > 0.8 + tight || (drawy && r() < 0.4) || (g.pfAgg === me && g.board.length === 3 && nOpp === 1 && r() < 0.6)) return { t: 'raise', to: Math.round(0.66 * pot) };
    return { t: 'check' };
  }
  const f = toCall / Math.max(1, pot - toCall);
  if (hp > 0.95 && g.raises < 3) return { t: 'raise', to: g.cur * 3 };
  if (hp > 0.55 + tight + 0.12 * Math.min(f, 2) || (drawy && f < 0.8)) return { t: 'call' };
  return { t: 'fold' };
}

const tracker = new T({ players: {} });
tracker.scorer = (show, tally) => E.scoreShow(show, tally, 'typical');
let uidN = 1;
const NAMES = ['Hero', 'Ann', 'Ben', 'Cat', 'Dan', 'Eve'];
function snap(g) {
  return { tableType: 'private', heroAuthId: 'P0', bigBlind: BB, players: g.hands.map((_, i) => (
    { id: i + 1, authUserId: 'P' + i, name: NAMES[i], stack: g.stack[i], posType: 's' + (i + 1), playState: g.folded[i] ? 'folded' : 'playing' })) };
}
const ev = (g, e, d) => { if (AGENT === 'solver') tracker.handle(e, d, snap(g)); };
const stats = { errors: 0, decisions: 0, ms: 0, multiDecisions: 0 };
function solverAct(g, me, r) {
  const b = tracker.solverInput('typical');
  if (b.error) { stats.errors++; return baselineAct(g, me, r); }
  const t = Date.now();
  const res = E.analyzeSync(Object.assign({}, b.input, { iterations: +(process.env.ITERS || 3000), riverIterations: 120, seed: (r() * 4294967296) >>> 0 }));
  stats.ms += Date.now() - t; stats.decisions++;
  if (b.input.opponents.length > 1 && g.board.length) stats.multiDecisions++;
  const best = res.best;
  if (DIAG) handDiag.push({ st: g.board.length, opps: b.input.opponents.length, kind: best.kind, facing: b.input.toCall > 0,
    frac: best.amount && b.input.pot ? +(best.amount / b.input.pot).toFixed(2) : 0, eq: res.equity ? +res.equity.share.toFixed(2) : null, solved: !!res.solver,
    pos: g.posOf(0), pf: g.board.length ? null : +pfStrength(g.hands[0]).toFixed(2) });
  if (best.kind === 'fold') return { t: 'fold' };
  if (best.kind === 'check') return { t: 'check' };
  if (best.kind === 'call') return { t: 'call' };
  return { t: 'raise', to: g.bet[me] + best.amount };
}

function settle(g) {
  // Side pots by contribution; folded players' chips stay in but they can't win.
  const put = g.put.slice();
  const pays = new Array(N).fill(0);
  const levels = [...new Set(put.filter((x) => x > 0))].sort((a, b) => a - b);
  let prev = 0;
  const scores = g.hands.map((h, i) => (g.folded[i] ? -1 : E.evaluate(h.concat(g.boardAll), 7)));
  for (const lv of levels) {
    const contributors = put.map((x, i) => (x >= lv ? i : -1)).filter((i) => i >= 0);
    const amount = (lv - prev) * contributors.length;
    const elig = contributors.filter((i) => !g.folded[i]);
    if (!elig.length) { pays[contributors[0]] += amount; prev = lv; continue; }
    const top = Math.max(...elig.map((i) => scores[i]));
    const win = elig.filter((i) => scores[i] === top);
    for (const w of win) pays[w] += amount / win.length;
    prev = lv;
  }
  return pays[0] - put[0];
}

function play(handNo, rs, rot) {
  const r = rng32(rs);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const btn = handNo % N;
  const hands = []; for (let i = 0; i < N; i++) { const j = (i + rot) % N; hands.push([deck[2 * j], deck[2 * j + 1]]); }
  const g = { hands, boardAll: deck.slice(2 * N, 2 * N + 5), board: [], stack: new Array(N).fill(START), bet: new Array(N).fill(0), put: new Array(N).fill(0),
    pot: 0, cur: 0, folded: new Array(N).fill(false), btn, raises: 0, pfAgg: -1, limpers: 0, lastRaise: BB };
  g.posOf = (i) => { const d = (i - btn + N) % N; return d === 0 || d === N - 1 ? 'late' : d <= 2 ? 'blinds' : 'early'; };
  const botR = rng32(rs ^ 0xabcdef), agentR = rng32(rs ^ 0x123457);
  const sbP = (btn + 1) % N, bbP = (btn + 2) % N;
  ev(g, 'game:stage_began', { stageType: 'set_blinds' });
  ev(g, 'game:dealer_updated', { dealerSeatPos: 's' + (btn + 1) });
  const pay = (p, a) => { g.stack[p] -= a; g.bet[p] += a; g.put[p] += a; };
  pay(sbP, SB); ev(g, 'game:small_blind_paid', { amount: SB, playerId: sbP + 1 });
  pay(bbP, BB); ev(g, 'game:big_blind_paid', { amount: BB, playerId: bbP + 1 });
  g.cur = BB;
  const uids = hands.map(() => [uidN++, uidN++]);
  ev(g, 'game:cards_dealt_to_player', hands.flatMap((_, i) => [{ playerPos: 's' + (i + 1), cardData: { uniqueID: uids[i][0] } }, { playerPos: 's' + (i + 1), cardData: { uniqueID: uids[i][1] } }]));
  ev(g, 'game:update_card_data', { cardData: cdata(hands[0][0], uids[0][0]) });
  ev(g, 'game:update_card_data', { cardData: cdata(hands[0][1], uids[0][1]) });
  for (const [name, n] of [['pre_flop', 0], ['flop', 3], ['turn', 4], ['river', 5]]) {
    if (n > 0) {
      g.pot += g.bet.reduce((a, b) => a + b, 0); g.bet.fill(0); g.cur = 0; g.raises = 0; g.lastRaise = BB;
      ev(g, 'game:stage_began', { stageType: name });
      const add = g.boardAll.slice(g.board.length, n);
      g.board = g.boardAll.slice(0, n);
      ev(g, 'game:cards_deal_to_stack', add.map((c) => ({ emitData: { stackID: 'community_stack', cardData: cdata(c, uidN++) } })));
    } else ev(g, 'game:stage_began', { stageType: name });
    if (live(g).length < 2) break;
    if (live(g).filter((i) => g.stack[i] > 0).length < 2 && live(g).every((i) => g.bet[i] >= g.cur || g.stack[i] === 0)) continue;
    let actor = n === 0 ? (bbP + 1) % N : (btn + 1) % N;
    const acted = new Array(N).fill(false);
    for (let guard = 0; guard < 200; guard++) {
      if (live(g).length < 2) break;
      const pending = live(g).filter((i) => g.stack[i] > 0 && (!acted[i] || g.bet[i] < g.cur));
      if (!pending.length) break;
      if (g.folded[actor] || g.stack[actor] === 0 || (acted[actor] && g.bet[actor] >= g.cur)) { actor = (actor + 1) % N; continue; }
      let a;
      if (actor === 0) { ev(g, 'game:player_turn_started', { playerID: 1 }); a = AGENT === 'solver' ? solverAct(g, 0, agentR) : baselineAct(g, 0, agentR); }
      else a = botAct(botCfg(actor), g, actor, botR);
      const toCall = g.cur - g.bet[actor];
      if (a.t === 'check' && toCall > 0) a = { t: 'fold' };
      if (a.t === 'call' && toCall === 0) a = { t: 'check' };
      let added = 0, type = a.t;
      if (a.t === 'fold') g.folded[actor] = true;
      else if (a.t === 'call') added = Math.min(toCall, g.stack[actor]);
      else if (a.t === 'raise') {
        const maxTo = g.bet[actor] + g.stack[actor];
        let to = Math.min(Math.max(Math.round(a.to), g.cur + g.lastRaise), maxTo);
        const others = live(g).filter((i) => i !== actor).map((i) => g.bet[i] + g.stack[i]);
        to = Math.min(to, Math.max(g.cur, ...others));
        if (to <= g.cur) { type = toCall > 0 ? 'call' : 'check'; added = Math.min(toCall, g.stack[actor]); }
        else {
          added = to - g.bet[actor]; g.lastRaise = Math.max(g.lastRaise, to - g.cur); g.cur = to; g.raises++; type = 'raise';
          if (n === 0) g.pfAgg = actor;
          acted.fill(false);
        }
      }
      if (n === 0 && type === 'call' && g.raises === 0) g.limpers++;
      g.stack[actor] -= added; g.bet[actor] += added; g.put[actor] += added;
      ev(g, 'player:game:action_taken', { playerID: actor + 1, actionType: type, makeBetValue: added });
      acted[actor] = true;
      actor = (actor + 1) % N;
    }
    if (live(g).length < 2) break;
  }
  ev(g, 'game:stage_began', { stageType: 'showdown' });
  const net = settle(g);
  if (live(g).length >= 2) {
    g.board = g.boardAll;
    for (const i of live(g)) if (i > 0) {
      ev(g, 'game:update_card_data', { cardData: cdata(hands[i][0], uids[i][0]) });
      ev(g, 'game:update_card_data', { cardData: cdata(hands[i][1], uids[i][1]) });
    }
  }
  ev(g, 'game:game_ended', {});
  return { net, multi: g.multiSeen };
}
const DIAG = !!process.env.DIAG, DUP = process.env.DUP !== '0';
let handDiag = [];
const diagOut = [];
const NETS = [];
const H = +HANDS, base = +SEED * 100000;
let sum = 0, sq = 0;
for (let i = 0; i < H; i++) {
  let net = 0;
  const rots = DUP ? N : 1;
  for (let rot = 0; rot < rots; rot++) {
    handDiag = [];
    const x = play(i, base + i, rot).net;
    net += x / rots;
    if (DIAG) diagOut.push({ deal: i, rot, net: x, d: handDiag });
  }
  NETS.push(net); sum += net; sq += net * net;
}
if (DIAG) require('fs').writeFileSync(require('path').join(OUT, `mdb_${AGENT}_${N}_${SEED}.json`), JSON.stringify(tracker.db));
if (DIAG) require('fs').writeFileSync(require('path').join(OUT, `mdiag_${AGENT}_${N}_${BOTMIX}_${SEED}.json`), JSON.stringify(diagOut));
const mean = sum / H, sd = Math.sqrt(sq / H - mean * mean);
require('fs').writeFileSync(require('path').join(OUT, `mnets_${AGENT}_${N}_${BOTMIX}_${SEED}.json`), JSON.stringify(NETS));
console.log(JSON.stringify({ agent: AGENT, players: N, bots: BOTMIX, hands: H, bb100: +((mean / BB) * 100).toFixed(1), se100: +((sd / Math.sqrt(H) / BB) * 100).toFixed(1),
  errors: stats.errors, msPerDecision: stats.decisions ? Math.round(stats.ms / stats.decisions) : 0, multiDecisions: stats.multiDecisions }));
