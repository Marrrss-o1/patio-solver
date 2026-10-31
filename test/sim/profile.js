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

function blank() {
  const st = () => ({ check: 0, bet: 0, fold: 0, call: 0, raise: 0 });
  const pos = () => ({ n: 0, vpip: 0, pfr: 0 });
  return {
    hands: 0, vpip: 0, pfr: 0, pos: { early: pos(), late: pos(), blinds: pos() },
    // Preflop details (need the full action log, v1.2.2+):
    pfLogHands: 0, unopened: 0, open: 0, limp: 0, unopenedFold: 0,
    vsOpen: 0, vsOpenFold: 0, vsOpenCall: 0, vsOpen3b: 0,
    vs3b: 0, vs3bFold: 0, vsBig: 0, vsBigCont: 0,
    openSizes: [], threeBetRatio: [],
    st: { flop: st(), turn: st(), river: st() },
    // Facing a bet by its size (bet / pot before it): small <45%, medium 45-85%, large >85%.
    vs: { small: { fold: 0, call: 0, raise: 0 }, medium: { fold: 0, call: 0, raise: 0 }, large: { fold: 0, call: 0, raise: 0 } },
    betPct: [], raiseRatio: [], cbetOpp: 0, cbet: 0, xrOpp: 0, xr: 0, donkOpp: 0, donk: 0,
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
  let raises = 0, lastTo = bb, pfRaiser = null;
  const preDone = {};
  for (const e of h.log) {
    if (e.st !== 'pre') break;
    if (e.act === 'sb' || e.act === 'bb') continue;
    const t = (e.who !== heroName || opts.includeHero) ? prof[e.who] : null;
    const first = !preDone[e.who];
    preDone[e.who] = true;
    if (t && first) t.pfLogHands++;
    if (t) {
      if (raises === 0 && first && e.act !== 'check') {
        t.unopened++;
        if (e.act === 'raise') { t.open++; t.openSizes.push(r2(e.to / bb)); }
        else if (e.act === 'call') t.limp++;
        else if (e.act === 'fold') t.unopenedFold++;
      } else if (raises === 1 && !seen[e.who + ':vo'] && e.facing > 0) {
        seen[e.who + ':vo'] = true;
        t.vsOpen++;
        if (e.act === 'fold') t.vsOpenFold++; else if (e.act === 'call') t.vsOpenCall++; else t.vsOpen3b++;
      } else if (raises >= 2 && e.facing > 0 && pfRaiser === e.who && !seen[e.who + ':v3']) {
        seen[e.who + ':v3'] = true;
        t.vs3b++; if (e.act === 'fold') t.vs3bFold++;
      }
      if (e.facing >= 8 * bb && e.act !== 'check' && !seen[e.who + ':big']) {
        seen[e.who + ':big'] = true; t.vsBig++; if (e.act !== 'fold') t.vsBigCont++;
      }
      if (e.act === '3bet' && lastTo > 0) t.threeBetRatio.push(r2(e.to / lastTo));
    }
    if (e.act === 'raise' || e.act === '3bet') { raises++; lastTo = e.to; pfRaiser = e.who; }
  }
  // Postflop: sizes, facing-size reactions, c-bets, check-raises, donks.
  const checked = {};
  let street = null, betMade = false, flopBet = false;
  for (const e of h.log) {
    if (e.st === 'pre') continue;
    if (e.st !== street) { street = e.st; betMade = false; for (const k of Object.keys(checked)) delete checked[k]; }
    const t = (e.who !== heroName || opts.includeHero) ? prof[e.who] : null;
    if (t) {
      if ((e.act === 'bet') && e.potPct != null) t.betPct.push(e.potPct / 100);
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
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

// The numbers calibration matches, from a tally.
function summarize(t) {
  const s = {
    hands: t.hands,
    vpip: ratio(t.vpip, t.hands), pfr: ratio(t.pfr, t.hands),
    limp: ratio(t.limp, t.unopened), openRaise: ratio(t.open, t.unopened), unopenedFold: ratio(t.unopenedFold, t.unopened), unopenedN: t.unopened,
    vsOpenFold: ratio(t.vsOpenFold, t.vsOpen), vsOpen3b: ratio(t.vsOpen3b, t.vsOpen), vsOpenN: t.vsOpen,
    vs3bFold: ratio(t.vs3bFold, t.vs3b), vs3bN: t.vs3b,
    callBig: ratio(t.vsBigCont, t.vsBig), callBigN: t.vsBig,
    openSize: mean(t.openSizes), threeBetRatio: mean(t.threeBetRatio),
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
