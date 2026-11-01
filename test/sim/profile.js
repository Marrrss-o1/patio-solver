// Player profiles from hand-log entries (the "Hand log" export, or the simulator's own hands).
// The same code measures real friends and simulated bots, so calibration compares like with like.
//
// Usage: node test/sim/profile.js <export.json> [more.json ...] [--json out.json] [--anon]
//   Prints each opponent's numbers. --anon replaces names with p1, p2, ... (the repo is public).
'use strict';
const E = require('../../src/engine.js');

const STREETS = ['flop', 'turn', 'river'];
const BOARD_N = { flop: 3, turn: 4, river: 5 };
const r2 = (x) => Math.round(x * 1000) / 1000;
// Opens this big (in bb) are shoves: counted apart, so a few all-in opens do not set the open size
// or turn 'facing an open' into 'facing a shove'. Each bet's size is capped at 2x pot for the same reason.
const SHOVE_BB = 12, BET_CAP = 2;

const lineOpenBlank = () => ({ calledN: 0, called: 0, aggrN: 0, aggr: 0, checkedN: 0, checked: 0 });
function blank() {
  const st = () => ({ check: 0, bet: 0, fold: 0, call: 0, raise: 0 });
  const pos = () => ({ n: 0, vpip: 0, pfr: 0 });
  return {
    hands: 0, vpip: 0, pfr: 0, pos: { early: pos(), late: pos(), blinds: pos() },
    // Preflop details (need the full action log, v1.2.2+):
    pfLogHands: 0, unopened: 0, open: 0, openShove: 0, limp: 0, unopenedFold: 0, limpFace: 0, limpFold: 0,
    vsOpen: 0, vsOpenFold: 0, vsOpenCall: 0, vsOpen3b: 0,
    vs3b: 0, vs3bFold: 0, vsBig: 0, vsBigCont: 0,
    openSizes: [], threeBetRatio: [],
    st: { flop: st(), turn: st(), river: st() },
    // Facing a bet by its size (bet / pot before it): small <45%, medium 45-85%, large >85%.
    vs: { small: { fold: 0, call: 0, raise: 0 }, medium: { fold: 0, call: 0, raise: 0 }, large: { fold: 0, call: 0, raise: 0 } },
    betPct: [], raiseRatio: [], cbetOpp: 0, cbet: 0, xrOpp: 0, xr: 0, donkOpp: 0, donk: 0,
    // Sizing: preflop re-raises (facing a raise) and raises after the flop as min-raises / all-ins / other (with
    // their to / current-bet ratio), bets after the flop as min-bets (one big blind) or log(fraction of the pot).
    rrN: 0, rrMin: 0, rrShove: 0, praN: 0, praMin: 0, praShove: 0, praOther: [], betN: 0, minBetN: 0, betLog: [], betLogPot: [],
    // After the flop, raised after betting or raising on the same street: fold / re-raise (once per street).
    vsRaiseN: 0, vsRaiseFold: 0, vsRaiseRe: 0,
    // Answering the first bet of a street after the flop (25-110% pot): heads-up, and multiway as the first to
    // answer, the last after everyone before folded, the last after someone stayed; plus whole answers (all fold) with
    // 2 and 3 to answer, kept on the first answerer.
    huAnsN: 0, huAnsFold: 0, mwFirstN: 0, mwFirstFold: 0, mwLastFoldedN: 0, mwLastFoldedFold: 0, mwLastStayedN: 0, mwLastStayedFold: 0,
    mw2N: 0, mw2Fold: 0, mw3N: 0, mw3Fold: 0,
    // The first chance to bet a turn or river nobody has bet yet, by the player's own line on the street before:
    // called a bet (without betting or raising), bet or raised, or only checked (the street went by without a bet).
    lineOpen: { turn: lineOpenBlank(), river: lineOpenBlank() },
    sawFlop: 0, wtsd: 0, showdowns: 0,
    // Shown hands: strength (percentile vs all hands, no draws) on each street they acted.
    shows: [],
  };
}

function cardsOf(list) {
  const out = (list || []).map(E.parseCard);
  return out.some((c) => c < 0) ? null : out;
}

// Adds one hand-log entry to the profiles map (name -> tally).
function addEntry(prof, h, opts = {}) {
  const bb = h.bigBlind || 1;
  const live = h.players.filter((p) => !p.folded).length;
  for (const p of h.players) {
    if (p.hero && !opts.includeHero) continue;
    const t = prof[p.name] || (prof[p.name] = blank());
    const a = p.actions || { pre: [], flop: [], turn: [], river: [] };
    t.hands++;
    const vol = a.pre.some((k) => k === 'call' || k === 'raise' || k === '3bet');
    const agg = a.pre.some((k) => k === 'raise' || k === '3bet');
    if (vol) t.vpip++;
    if (agg) t.pfr++;
    if (p.position && t.pos[p.position]) { const g = t.pos[p.position]; g.n++; if (vol) g.vpip++; if (agg) g.pfr++; }
    for (const s of STREETS) for (const k of a[s] || []) if (t.st[s][k] != null) t.st[s][k]++;
    // A street's first action is a check or a bet only when nobody has bet before them, so the per-player lists
    // are enough (older logs have no ordered action log).
    for (const s of ['turn', 'river']) {
      const first = (a[s] || [])[0], pl = a[s === 'turn' ? 'flop' : 'turn'] || [];
      if (first !== 'check' && first !== 'bet') continue;
      const line = pl.some((k) => k === 'bet' || k === 'raise') ? 'aggr' : pl.includes('call') ? 'called' : pl.length && pl.every((k) => k === 'check') ? 'checked' : null;
      if (line) { const lo = t.lineOpen[s]; lo[line + 'N']++; if (first === 'bet') lo[line]++; }
    }
    const sawFlop = h.board.length >= 3 && ((a.flop || []).length > 0 || !p.folded);
    if (sawFlop) t.sawFlop++;
    if (sawFlop && !p.folded && live >= 2) t.wtsd++;
    const hole = p.shown && p.shown.length === 2 ? cardsOf(p.shown) : null;
    const board = cardsOf(h.board);
    if (hole && board && board.length === 5 && !p.folded) {
      t.showdowns++;
      const show = { line: {} };
      for (const s of STREETS) {
        const acts = a[s] || [];
        if (!acts.length) continue;
        show.line[s] = acts.join('-');
        show[s] = r2(E.handPercentile(hole, board.slice(0, BOARD_N[s])));
      }
      t.shows.push(show);
    }
  }
  if (Array.isArray(h.log) && h.log.length) addLog(prof, h, bb, opts);
}

// Details that need the ordered action log with amounts.
function addLog(prof, h, bb, opts) {
  const heroName = (h.players.find((p) => p.hero) || {}).name;
  const seen = {};
  let raises = 0, lastTo = bb, pfRaiser = null, opener = null;
  const preDone = {};
  // Sizing of a raise facing a bet: min-raise (adds no more than the last raise did), all-in, or other.
  const sizing = (e, cur, inc) => (e.stack != null && e.amt >= e.stack - 1e-9 ? 'shove' : e.to - cur <= inc + 1e-9 ? 'min' : 'other');
  let curPre = bb, incPre = bb;
  for (const e of h.log) {
    if (e.st !== 'pre') break;
    if (e.act === 'sb' || e.act === 'bb') continue;
    const t = (e.who !== heroName || opts.includeHero) ? prof[e.who] : null;
    if ((e.act === 'raise' || e.act === '3bet') && e.to > curPre) {
      if (t && curPre > bb && e.facing > 0) { const k = sizing(e, curPre, incPre); t.rrN++; if (k === 'min') t.rrMin++; else if (k === 'shove') t.rrShove++; }
      incPre = Math.max(incPre, e.to - curPre); curPre = e.to;
    }
    const first = !preDone[e.who];
    preDone[e.who] = true;
    if (t && first) t.pfLogHands++;
    if (t) {
      if (raises === 0 && first && e.act !== 'check') {
        t.unopened++;
        if (e.act === 'raise') { t.open++; if (e.to >= SHOVE_BB * bb) t.openShove++; else t.openSizes.push(r2(e.to / bb)); }
        else if (e.act === 'call') { t.limp++; seen[e.who + ':limped'] = true; }
        else if (e.act === 'fold') t.unopenedFold++;
      } else if (raises >= 1 && seen[e.who + ':limped'] && !seen[e.who + ':lf'] && e.facing > 0) {
        // A limper's first answer to a raise (iso-raises over limpers are common in this game).
        seen[e.who + ':lf'] = true;
        t.limpFace++; if (e.act === 'fold') t.limpFold++;
      } else if (raises === 1 && lastTo < SHOVE_BB * bb && !seen[e.who + ':vo'] && !seen[e.who + ':limped'] && e.facing > 0) {
        seen[e.who + ':vo'] = true;
        t.vsOpen++;
        if (e.act === 'fold') t.vsOpenFold++; else if (e.act === 'call') t.vsOpenCall++; else t.vsOpen3b++;
      } else if (raises >= 2 && e.facing > 0 && opener === e.who && !seen[e.who + ':v3']) {
        // The opener's answer to a 3-bet.
        seen[e.who + ':v3'] = true;
        t.vs3b++; if (e.act === 'fold') t.vs3bFold++;
      }
      if (e.facing >= 8 * bb && e.act !== 'check' && !seen[e.who + ':big']) {
        seen[e.who + ':big'] = true; t.vsBig++; if (e.act !== 'fold') t.vsBigCont++;
      }
      if (e.act === '3bet' && lastTo > 0) t.threeBetRatio.push(r2(e.to / lastTo));
    }
    if (e.act === 'raise' || e.act === '3bet') { raises++; lastTo = e.to; pfRaiser = e.who; if (raises === 1) opener = e.who; }
  }
  // Postflop: sizes, facing-size reactions, c-bets, check-raises, donks.
  const checked = {};
  let street = null, betMade = false, flopBet = false, cur = 0, inc = bb;
  const aggr = {}, faced = {};
  // Who is still in, for answers to the first bet of each street.
  const out = {};
  for (const e of h.log) if (e.st === 'pre' && e.act === 'fold') out[e.who] = true;
  const names = h.players.map((p) => p.name);
  let fb = null; // the first bet being answered: { m, ans: [[who, act]], open }
  const closeBet = () => {
    if (!fb || fb.m < 2 || fb.ans.length !== fb.m || fb.ans.some(([w, a]) => w === heroName || a === 'raise')) { fb = null; return; }
    const t0 = prof[fb.ans[0][0]];
    if (t0 && (fb.m === 2 || fb.m === 3)) { const allF = fb.ans.every(([, a]) => a === 'fold'); if (fb.m === 2) { t0.mw2N++; if (allF) t0.mw2Fold++; } else { t0.mw3N++; if (allF) t0.mw3Fold++; } }
    fb = null;
  };
  for (const e of h.log) {
    if (e.st === 'pre') continue;
    if (fb && (e.st !== fb.st || !(e.facing > 0) || e.act === 'raise' || e.act === 'bet')) {
      // A raise ends the answers to the first bet (the raiser's own answer counts).
      if (e.st === fb.st && e.facing > 0 && e.act === 'raise' && fb.open) fb.ans.push([e.who, 'raise']);
      fb.open = false;
      if (e.st !== fb.st || !(e.facing > 0)) closeBet();
    }
    if (fb && fb.open && e.facing > 0 && (e.act === 'fold' || e.act === 'call')) {
      const t = (e.who !== heroName || opts.includeHero) ? prof[e.who] : null;
      const i = fb.ans.length, stayed = fb.ans.some(([, a]) => a !== 'fold');
      if (t) {
        const f = e.act === 'fold' ? 1 : 0;
        if (fb.m === 1) { t.huAnsN++; t.huAnsFold += f; }
        else if (i === 0) { t.mwFirstN++; t.mwFirstFold += f; }
        else if (i === fb.m - 1 && !stayed) { t.mwLastFoldedN++; t.mwLastFoldedFold += f; }
        else if (i === fb.m - 1) { t.mwLastStayedN++; t.mwLastStayedFold += f; }
      }
      fb.ans.push([e.who, e.act]);
    }
    if (e.act === 'bet' && !(e.facing > 0) && e.potPct >= 25 && e.potPct <= 110 && (!fb || fb.st !== e.st)) {
      fb = { st: e.st, m: names.filter((nm) => !out[nm] && nm !== e.who).length, ans: [], open: true };
    }
    if (e.act === 'fold') out[e.who] = true;
    if (e.st !== street) { street = e.st; betMade = false; cur = 0; inc = bb; for (const o of [checked, aggr, faced]) for (const k of Object.keys(o)) delete o[k]; }
    const t = (e.who !== heroName || opts.includeHero) ? prof[e.who] : null;
    if (t && aggr[e.who] && e.facing > 0 && !faced[e.who] && (e.act === 'fold' || e.act === 'call' || e.act === 'raise')) {
      faced[e.who] = true; t.vsRaiseN++;
      if (e.act === 'fold') t.vsRaiseFold++; else if (e.act === 'raise') t.vsRaiseRe++;
    }
    if (e.act === 'bet' || e.act === 'raise') aggr[e.who] = true;
    if ((e.act === 'bet' || e.act === 'raise') && e.to > cur) {
      if (t && cur === 0) {
        t.betN++;
        if (e.to <= bb + 1e-9) t.minBetN++;
        else if (e.potPct > 0) { const y = Math.log(Math.min(BET_CAP, e.potPct / 100)); t.betLog.push(y); t.betLogPot.push(Math.log(Math.max(1, e.pot / bb))); }
      } else if (t && e.facing > 0) {
        const k = sizing(e, cur, inc); t.praN++;
        if (k === 'min') t.praMin++; else if (k === 'shove') t.praShove++; else t.praOther.push(r2(e.to / cur));
      }
      inc = Math.max(inc, e.to - cur); cur = e.to;
    }
    if (t) {
      if ((e.act === 'bet') && e.potPct != null) t.betPct.push(Math.min(BET_CAP, e.potPct / 100));
      if (e.act === 'raise' && e.facing > 0) t.raiseRatio.push(r2(e.to / Math.max(1, e.to - e.amt + e.facing)));
      if (e.facing > 0 && (e.act === 'fold' || e.act === 'call' || e.act === 'raise')) {
        const f = e.facing / Math.max(1, e.pot - e.facing);
        t.vs[f < 0.45 ? 'small' : f < 0.85 ? 'medium' : 'large'][e.act]++;
        if (checked[e.who]) { t.xrOpp++; if (e.act === 'raise') t.xr++; checked[e.who] = false; }
      }
      if (street === 'flop' && !flopBet && pfRaiser) {
        if (e.who === pfRaiser && !seen[e.who + ':cb']) { seen[e.who + ':cb'] = true; t.cbetOpp++; if (e.act === 'bet') t.cbet++; }
        else if (e.who !== pfRaiser && !seen[e.who + ':dk'] && !seen[pfRaiser + ':cb']) { seen[e.who + ':dk'] = true; t.donkOpp++; if (e.act === 'bet') t.donk++; }
      }
    }
    if (e.act === 'check') checked[e.who] = true;
    if (e.act === 'bet' || e.act === 'raise') { betMade = true; if (street === 'flop') flopBet = true; }
  }
  closeBet();
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

// The numbers calibration matches, from a tally.
function summarize(t) {
  const s = {
    hands: t.hands,
    vpip: ratio(t.vpip, t.hands), pfr: ratio(t.pfr, t.hands),
    limp: ratio(t.limp, t.unopened), limpFold: ratio(t.limpFold, t.limpFace), limpFaceN: t.limpFace, openRaise: ratio(t.open, t.unopened), unopenedFold: ratio(t.unopenedFold, t.unopened), unopenedN: t.unopened,
    vsOpenFold: ratio(t.vsOpenFold, t.vsOpen), vsOpen3b: ratio(t.vsOpen3b, t.vsOpen), vsOpenN: t.vsOpen,
    vs3bFold: ratio(t.vs3bFold, t.vs3b), vs3bN: t.vs3b,
    callBig: ratio(t.vsBigCont, t.vsBig), callBigN: t.vsBig,
    openSize: mean(t.openSizes), openShove: ratio(t.openShove, t.open), openShoveN: t.open, threeBetRatio: mean(t.threeBetRatio),
    betPct: mean(t.betPct), betPctN: t.betPct.length, raiseRatio: mean(t.raiseRatio),
    cbet: ratio(t.cbet, t.cbetOpp), cbetN: t.cbetOpp, donk: ratio(t.donk, t.donkOpp), xr: ratio(t.xr, t.xrOpp),
    wtsd: ratio(t.wtsd, t.sawFlop), sawFlop: ratio(t.sawFlop, t.hands), sawFlopN: t.sawFlop, showdowns: t.showdowns,
    st: {}, vs: {},
  };
  for (const k of STREETS) {
    const x = t.st[k], u = x.check + x.bet, f = x.fold + x.call + x.raise;
    s.st[k] = { betFreq: ratio(x.bet, u), u, foldToBet: ratio(x.fold, f), raiseFreq: ratio(x.raise, f), f };
  }
  for (const k of ['small', 'medium', 'large']) {
    const x = t.vs[k], n = x.fold + x.call + x.raise;
    s.vs[k] = { fold: ratio(x.fold, n), raise: ratio(x.raise, n), n };
  }
  // Showdown strength: average percentile when they bet/raised vs only called on the river, and
  // the share of their shown bets (any street) made with weak hands (< 45th percentile, like the engine's).
  const rb = [], rc = [], bets = [];
  for (const sh of t.shows) {
    const rl = sh.line.river || '';
    if (/bet|raise/.test(rl)) rb.push(sh.river); else if (/call/.test(rl)) rc.push(sh.river);
    for (const k of STREETS) if (sh.line[k] && /bet|raise/.test(sh.line[k])) bets.push(sh[k]);
  }
  s.sdRiverBet = mean(rb); s.sdRiverBetN = rb.length;
  s.sdRiverCall = mean(rc); s.sdRiverCallN = rc.length;
  s.sdBluffShare = bets.length ? bets.filter((x) => x < 0.45).length / bets.length : null; s.sdBetsN = bets.length;
  s.rrMinShare = ratio(t.rrMin, t.rrN); s.rrShoveShare = ratio(t.rrShove, t.rrN); s.rrN = t.rrN;
  s.raiseMinShare = ratio(t.praMin, t.praN); s.raiseShoveShare = ratio(t.praShove, t.praN); s.raiseN = t.praN; s.raiseOtherRatio = mean(t.praOther);
  s.minBetShare = ratio(t.minBetN, t.betN); s.betN = t.betN;
  s.huAnsFold = ratio(t.huAnsFold, t.huAnsN); s.mwFirstFold = ratio(t.mwFirstFold, t.mwFirstN); s.mwLastFoldedFold = ratio(t.mwLastFoldedFold, t.mwLastFoldedN);
  s.mwLastStayedFold = ratio(t.mwLastStayedFold, t.mwLastStayedN); s.mw2Fold = ratio(t.mw2Fold, t.mw2N); s.mw3Fold = ratio(t.mw3Fold, t.mw3N);
  Object.assign(s, { huAnsN: t.huAnsN, mwFirstN: t.mwFirstN, mwLastFoldedN: t.mwLastFoldedN, mwLastStayedN: t.mwLastStayedN, mw2N: t.mw2N, mw3N: t.mw3N });
  for (const st of ['turn', 'river']) {
    const lo = t.lineOpen[st], S = st === 'turn' ? 'Turn' : 'River';
    for (const k of ['called', 'aggr', 'checked']) { const K = k[0].toUpperCase() + k.slice(1); s['open' + K + S] = ratio(lo[k], lo[k + 'N']); s['open' + K + S + 'N'] = lo[k + 'N']; }
  }
  s.vsRaiseFold = ratio(t.vsRaiseFold, t.vsRaiseN); s.vsRaiseRe = ratio(t.vsRaiseRe, t.vsRaiseN); s.vsRaiseN = t.vsRaiseN;
  const bl = t.betLog, bm = mean(bl);
  s.betLogSd = bl.length > 2 ? Math.sqrt(bl.reduce((a, x) => a + (x - bm) ** 2, 0) / (bl.length - 1)) : null; s.betLogN = bl.length;
  // Bet size against pot size (log fraction of the pot on log pot in big blinds): friends bet about pot in small
  // pots and a fifth of it in big ones (slope about -0.5); the spread left over is betSizeResid.
  s.betSizeSlope = null; s.betSizeResid = null;
  const xs = t.betLogPot;
  if (xs.length > 5 && xs.length === bl.length) {
    const mx = mean(xs);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (bl[i] - bm); sxx += (xs[i] - mx) ** 2; syy += (bl[i] - bm) ** 2; }
    if (sxx > 0) { s.betSizeSlope = sxy / sxx; s.betSizeResid = Math.sqrt(Math.max(0, syy - (sxy * sxy) / sxx) / (xs.length - 2)); }
  }
  return s;
}

// Sums tallies (arrays are concatenated), e.g. to pool several players.
function mergeTallies(list) {
  const out = blank();
  const add = (o, x) => {
    for (const k of Object.keys(o)) {
      if (Array.isArray(o[k])) o[k].push(...(x[k] || []));
      else if (typeof o[k] === 'number') o[k] += x[k] || 0;
      else if (o[k] && typeof o[k] === 'object') add(o[k], x[k] || {});
    }
  };
  for (const t of list) add(out, t);
  return out;
}

function profileEntries(entries, opts) {
  const prof = {};
  for (const h of entries) if (h && Array.isArray(h.players)) addEntry(prof, h, opts);
  return prof;
}

function fmt(s) {
  const p = (x) => (x == null ? '  - ' : String(Math.round(x * 100)).padStart(3) + '%');
  const lines = [];
  lines.push(`hands ${s.hands}  VPIP ${p(s.vpip)} PFR ${p(s.pfr)}  limp ${p(s.limp)} open ${p(s.openRaise)} (n=${s.unopenedN}, ${s.openSize ? s.openSize.toFixed(1) + 'bb' : '-'})  vs open: fold ${p(s.vsOpenFold)} 3bet ${p(s.vsOpen3b)} (n=${s.vsOpenN})  callBig ${p(s.callBig)} (n=${s.callBigN})`);
  lines.push('  ' + STREETS.map((k) => `${k}: bet ${p(s.st[k].betFreq)}/${s.st[k].u} fold ${p(s.st[k].foldToBet)} raise ${p(s.st[k].raiseFreq)}/${s.st[k].f}`).join(' | '));
  lines.push(`  bet size ${s.betPct ? Math.round(s.betPct * 100) + '% pot' : '-'} (n=${s.betPctN})  c-bet ${p(s.cbet)} (n=${s.cbetN})  WTSD ${p(s.wtsd)}  fold vs small/med/large ${p(s.vs.small.fold)}/${p(s.vs.medium.fold)}/${p(s.vs.large.fold)} (n=${s.vs.small.n}/${s.vs.medium.n}/${s.vs.large.n})`);
  lines.push(`  showdowns ${s.showdowns}: river bet ${s.sdRiverBet != null ? s.sdRiverBet.toFixed(2) : '-'} (n=${s.sdRiverBetN}) river call ${s.sdRiverCall != null ? s.sdRiverCall.toFixed(2) : '-'} (n=${s.sdRiverCallN}) weak shown bets ${p(s.sdBluffShare)} (n=${s.sdBetsN})`);
  return lines.join('\n');
}

module.exports = { blank, addEntry, summarize, profileEntries, mergeTallies, fmt };

if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json');
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const anon = args.includes('--anon');
  const entries = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const prof = profileEntries(entries);
  const names = Object.keys(prof).sort((a, b) => prof[b].hands - prof[a].hands);
  const out = {};
  names.forEach((n, i) => {
    const s = summarize(prof[n]);
    const label = anon ? 'p' + (i + 1) : n;
    out[label] = s;
    console.log(label + '\n' + fmt(s));
  });
  // Pool: every opponent together.
  out.pool = summarize(mergeTallies(Object.values(prof)));
  console.log('pool\n' + fmt(out.pool));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
}
