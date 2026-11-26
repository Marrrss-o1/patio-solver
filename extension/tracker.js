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
  // Where a seat sits going clockwise. Seats run in ascending number, except the extra seat
  // 's3_v2' (its digits read as 32), which sits between s9 and s10 at the owner's tables
  // (preflop action order in the live hand logs).
  const SEAT_KEY = { s3_v2: 9.5 };
  function seatKey(pos) {
    return Object.prototype.hasOwnProperty.call(SEAT_KEY, pos) ? SEAT_KEY[pos] : seatNum(pos);
  }
  const MAX_SHOWS = 80;
  const MAX_JAM_SHOWS = 20;
  const MAX_MW_FOLDS = 40;
  const MAX_VS_RAISE = 60;
  const MAX_BET_RECENT = 60;
  const MAX_PF_RECENT = 60;
  const MAX_HISTORY = 150;
  // Raw events: kept for the newest RAW_KEEP hands only (about 17 KB a hand in Marwin's logs).
  const RAW_KEEP = 100, RAW_MAX_EVENTS = 400, RAW_MAX_EVENT = 4000;
  // Each hand a player is dealt into shrinks their older counts by 1%, so the last
  // hundred or so hands carry most of the weight and reads follow players who change.
  const DECAY = 0.997;
  function decayTally(t, f) {
    const d = f != null ? f : DECAY;
    for (const k of Object.keys(t)) {
      if (k === 'shows' || k === 'jamShows' || k === 'mwFolds' || k === 'vsRaise' || k === 'betRecent' || k === 'pfRecent') continue;
      if (typeof t[k] === 'number') t[k] *= d;
      else if (t[k] && typeof t[k] === 'object') decayTally(t[k], d);
    }
  }
  const streetTally = () => ({ check: 0, bet: 0, call: 0, raise: 0, fold: 0 });
  const facingTally = () => ({ fold: 0, call: 0, raise: 0 });
  // Facing a bet by size bucket, plus the sizes seen in the bucket (fs = sum of pot fractions, fn = count).
  const sizeTally = () => ({ fold: 0, call: 0, raise: 0, fs: 0, fn: 0 });
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
      // Limpers facing a raise: how often they fold.
      limpFaceN: 0, limpFold: 0,
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
      vs: { small: sizeTally(), medium: sizeTally(), large: sizeTally() },
      // Response to a single open raise preflop by its raise-to size: <=2.5bb, <=3.5bb, under 8bb, and 8bb or more
      // ('huge': shoves and huge opens, kept apart since v1.8.20; older reads have them in 'large'). 'raise' = 3-bet.
      vsOpen: { small: facingTally(), medium: facingTally(), large: facingTally(), huge: facingTally() },
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
      // Preflop all-in re-raises whose cards were seen, at any point of the hand (v1.8.27, DEEP_SHOVE's per-player read):
      // { cards, pre, to, cover } with the raise-to and the biggest stack still in, in big blinds. Newest MAX_JAM_SHOWS.
      jamShows: [],
      // First answers to hero's opening bets of 30%+ of the pot into 2+ opponents after the flop, before anyone stayed
      // (v1.8.29, MW_BET_FOLD's per-player read): { y: 1 folded, f: bet / pot before it, n: street, ck: checked first on
      // the street, ag: bet or raised earlier in the hand, rr: re-raised preflop, k: opponents }. Newest MAX_MW_FOLDS.
      mwFolds: [],
      // Answers to a raise after the flop (v1.8.44, COLD_RAISE and RAISED_RR's per-player reads): { y: 'f' | 'c' | 'r',
      // f: price / pot before it, n: street, role: 'b' had bet or raised the street, 'c' called it, 'k' checked, 'u' not
      // acted, ck: first action on the street a check, ag: bet or raised earlier in the hand, rr: re-raised preflop,
      // h: the raise was hero's }. Newest MAX_VS_RAISE.
      vsRaise: [],
      // Chances to open the betting after the flop (check or bet with nobody's bet in; v1.8.45, BET_RECENT's per-player
      // read): { p: the read's P(bet) then, y: 1 bet, t: time }. Newest MAX_BET_RECENT.
      betRecent: [],
      // Each hand's preflop (v1.8.48, PF_RECENT's per-player read): { f, r: the read's P(fold) and P(raise) then, y: 0
      // fold, 1 call, 2 raise, t: time }. Newest MAX_PF_RECENT.
      pfRecent: [],
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
  // Linked reads: one friend's counts kept under more than one account id, added up.
  function addCounts(out, t) {
    for (const k of Object.keys(t || {})) {
      if (k === 'shows' || k === 'jamShows' || k === 'mwFolds' || k === 'vsRaise' || k === 'betRecent' || k === 'pfRecent') continue;
      const v = t[k];
      if (typeof v === 'number') out[k] = (out[k] || 0) + v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) addCounts(out[k] || (out[k] = {}), v);
    }
    return out;
  }
  // Tallies oldest id first (the order its shows are kept in); the newest MAX_SHOWS shows kept.
  // A linked read's newest `max` entries of one list (shows, jamShows, mwFolds, vsRaise), in time order across the ids.
  // Entries carry `at` (ms, when recorded) since v1.8.46; an older one sorts just before the next entry of its own list
  // that has one, else before that id's last-seen time (`lasts`, db.seen[id].last), so untagged lists line up by when
  // each account was last played. With neither (old data, no seen times) the lists are joined in id order as before.
  // Before v1.8.46 they were always joined in id order (ids by first seen) and the last `max` kept, so a friend back on
  // their oldest account lost their newest shows first: Jagger on 24 Nov had none of his 19 shows from 23-24 Nov.
  function byTime(list, field, lasts, max) {
    const all = [];
    let known = !!(lasts && lasts.some((x) => x > 0));
    list.forEach((t, li) => {
      const arr = (t && t[field]) || [];
      const keys = new Array(arr.length);
      let next = lasts && lasts[li] > 0 ? lasts[li] : 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        const e = arr[i];
        if (e && e.at > 0) { known = true; keys[i] = e.at; next = e.at; } else { keys[i] = next - 1; next = keys[i]; }
      }
      for (let i = 0; i < arr.length; i++) all.push({ e: arr[i], k: keys[i], li, i });
    });
    if (known) all.sort((a, b) => a.k - b.k || a.li - b.li || a.i - b.i);
    return all.slice(-max).map((x) => x.e);
  }
  function mergeTallies(list, lasts) {
    const out = blankTally();
    for (const t of list) addCounts(out, t);
    out.shows = byTime(list, 'shows', lasts, MAX_SHOWS);
    out.jamShows = byTime(list, 'jamShows', lasts, MAX_JAM_SHOWS);
    out.mwFolds = byTime(list, 'mwFolds', lasts, MAX_MW_FOLDS);
    out.vsRaise = byTime(list, 'vsRaise', lasts, MAX_VS_RAISE);
    // In time order across the ids (a friend can switch back and forth between accounts); the sort is stable.
    const br = [];
    for (const t of list) for (const a of t.betRecent || []) br.push(a);
    br.sort((a, b) => ((a && a.t) || 0) - ((b && b.t) || 0));
    out.betRecent = br.slice(-MAX_BET_RECENT);
    const pr = [];
    for (const t of list) for (const a of t.pfRecent || []) pr.push(a);
    pr.sort((a, b) => ((a && a.t) || 0) - ((b && b.t) || 0));
    out.pfRecent = pr.slice(-MAX_PF_RECENT);
    return out;
  }
  const normName = (s) => String(s == null ? '' : s).trim().toLowerCase();
  // Names a site could hand out to many people (none seen at Marwin's tables yet): never matched.
  const GENERIC_NAME = /^(guest|player|user|anonymous|anon)[\s_#-]*\d*$/;
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  // "Who is this?" (audit 10 Nov, finding 7): an account the reads have seen for under `hands` hands, with no same-name
  // read to ask about, is offered the `max` most recently seen players with `minHands`+ hands who are not at the table.
  const WHO = { hands: 10, minHands: 10, max: 8 };

  const STREET_BY_STAGE = { pre_flop: 0, flop: 3, turn: 4, river: 5 };
  const STREET_KEY = { 0: 'pre', 3: 'flop', 4: 'turn', 5: 'river' };

  class PatioTracker {
    constructor(db) {
      // db: { players: { [authUserId]: { name, tally } }, history, and for linked reads (below):
      //   same: { [id]: root id }, notSame: { 'a|b': time }, seen: { [id]: { names, met, first, last } } }
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

    // ---------- linked reads ----------
    // A friend can turn up under a new account id (a guest id changes when they clear their
    // browser or switch devices: Jagger on 2 Nov came back on a new id, read from his first hands
    // there instead of the 96 on his old one) and under a new name. Reads stay stored per id; `db.same[id] =
    // root` puts id in root's group, and everything that reads a player (solver input, read scores,
    // the panel) uses the group's counts added up (`readTally`). Each id keeps counting into its
    // own record, so a link can be undone at any time without losing hands. Links are made only
    // by hand (the panel suggests same-name matches, `linkMatches`). Two ids never link when they
    // were dealt into the same hand (`seen[id].met`): they are two players. A pair answered
    // "different players" or unlinked is not suggested again (`notSame`).
    canon(id) {
      const s = this.db.same;
      return (s && s[id]) || id;
    }

    // Root first, then the other ids linked to it.
    groupOf(id) {
      if (!id) return [];
      const root = this.canon(id);
      const out = [root];
      const s = this.db.same;
      if (s) for (const k of Object.keys(s)) if (s[k] === root && k !== root) out.push(k);
      return out;
    }

    // The read for id: its own tally when it is not linked (the same object, so nothing changes
    // for players with one id), else every linked id's counts added up, oldest first.
    readTally(id) {
      const ids = this.groupOf(id).filter((k) => this.db.players[k] && this.db.players[k].tally);
      if (ids.length <= 1) return ids.length ? this.db.players[ids[0]].tally : null;
      const seen = this.db.seen || {};
      const first = (k) => (seen[k] && seen[k].first) || 0;
      ids.sort((a, b) => first(a) - first(b));
      return mergeTallies(ids.map((k) => upgradeTally(this.db.players[k].tally)), ids.map((k) => (seen[k] && seen[k].last) || 0));
    }

    // Every name an id has played under, newest first.
    namesOf(id) {
      const e = this.db.seen && this.db.seen[id];
      const out = e ? Object.keys(e.names || {}).sort((a, b) => e.names[b] - e.names[a]) : [];
      const r = this.db.players[id];
      const cur = (r && r.name) || null;
      return cur ? [cur].concat(out.filter((n) => n !== cur)) : out;
    }

    // Why two ids can't be one player: 'table' (dealt into the same hand), 'unlinked', or null.
    apart(a, b) {
      const seen = this.db.seen || {};
      if ((seen[a] && seen[a].met && seen[a].met[b]) || (seen[b] && seen[b].met && seen[b].met[a])) return 'table';
      if (this.db.notSame && this.db.notSame[pairKey(a, b)]) return 'unlinked';
      return null;
    }
    groupsApart(A, B, ignoreUnlinked) {
      for (const a of A) for (const b of B) {
        const why = this.apart(a, b);
        if (why && !(ignoreUnlinked && why === 'unlinked')) return { why, a, b };
      }
      return null;
    }

    // Who was dealt in this hand: the names each id used, and which ids played together.
    noteSeats(ids, names, t) {
      const seen = this.db.seen || (this.db.seen = {});
      ids.forEach((id, i) => {
        const e = seen[id] || (seen[id] = { names: {}, met: {}, first: t, last: t });
        e.last = t;
        if (names[i]) e.names[names[i]] = t;
        for (const o of ids) if (o !== id) e.met[o] = 1;
      });
    }

    // Groups in one: every id points at the root (the id seen first).
    joinGroups(groups) {
      const all = [];
      for (const g of groups) for (const k of g) if (!all.includes(k)) all.push(k);
      const seen = this.db.seen || {};
      const first = (k) => (seen[k] && seen[k].first != null ? seen[k].first : -Infinity);
      const root = groups.map((g) => g[0]).sort((a, b) => first(a) - first(b))[0]; // ties: the first group
      const same = this.db.same || (this.db.same = {});
      for (const k of all) if (k !== root) same[k] = root;
      delete same[root];
      return root;
    }

    linkInfo(id) {
      const ids = this.groupOf(id);
      const t = this.readTally(id);
      const hands = t ? (t.pfFold || 0) + (t.pfCall || 0) + (t.pfRaise || 0) : 0;
      const names = [];
      for (const k of ids) for (const n of this.namesOf(k)) if (!names.includes(n)) names.push(n);
      return { id, ids, names, hands };
    }

    // A player sitting down under a name another read used (now or before), on another account
    // id, with no sign that they are two people: the panel asks whether they are the same player
    // (Marwin answers; nothing is joined before that, 3 Nov). A name change on the same id needs
    // nothing: reads are kept by id. -> the older reads that could be this player (one entry per
    // player, as `linkInfo`), or [].
    linkMatches(id, name, heroId) {
      const nm = normName(name);
      if (!id || id === heroId || !nm || GENERIC_NAME.test(nm)) return [];
      const mine = this.groupOf(id);
      const roots = [];
      for (const k of Object.keys(this.db.players)) {
        if (k === heroId || mine.includes(k)) continue;
        if (!this.namesOf(k).some((n) => normName(n) === nm)) continue;
        const root = this.canon(k);
        if (!roots.includes(root) && !mine.includes(root)) roots.push(root);
      }
      return roots.map((r) => this.groupOf(r))
        .filter((g) => !g.includes(heroId) && !this.groupsApart(mine, g))
        .map((g) => this.linkInfo(g[0]));
    }

    // At each new hand: the players dealt in who could be an older read (`linkMatches`), kept in
    // `linkAsks` for the panel. 'linkAsk' fires when the list changes.
    askLinks(dealt, heroId) {
      const asks = {};
      for (const p of dealt) {
        const m = this.linkMatches(p.authUserId, p.name, heroId);
        if (m.length) asks[p.authUserId] = { id: p.authUserId, name: p.name, matches: m };
      }
      const key = (a) => Object.keys(a).sort().map((k) => k + ':' + a[k].matches.map((x) => x.id).join(',')).join(';');
      const changed = key(asks) !== key(this.linkAsks || {});
      this.linkAsks = asks;
      if (changed) this.emit('linkAsk', asks);
      return asks;
    }

    // "Who is this?" at each new hand: a new account (its own hands under WHO.hands, not linked, no same-name question,
    // not answered "someone new") gets the known players who could be it: the most recently seen with WHO.minHands+
    // hands, not dealt into this hand, never at a table with it and not answered "different players". Kept in
    // `whoAsks` for the panel; 'whoAsk' fires when the list changes. Nothing is joined before Marwin picks one (7 Nov:
    // all four friends sat down on new accounts and were linked by hand at hands 5 and 6, so their first hands read
    // them as strangers).
    askWho(dealt, heroId) {
      const W = Object.assign({}, WHO, this.whoOpts || {});
      const asks = {};
      const newOk = this.db.newOk || {};
      const dealtIds = new Set(dealt.map((p) => p.authUserId));
      let groups = null;
      for (const p of dealt) {
        const id = p.authUserId;
        if (!id || id === heroId || newOk[id] || (this.linkAsks && this.linkAsks[id])) continue;
        const mine = this.groupOf(id);
        if (mine.length > 1) continue;
        const own = this.db.players[id] && this.db.players[id].tally;
        const n = own ? (own.pfFold || 0) + (own.pfCall || 0) + (own.pfRaise || 0) : 0;
        if (n >= W.hands) continue;
        groups = groups || this.readGroups();
        const m = groups.filter((g) => g.hands >= W.minHands && !g.ids.some((k) => dealtIds.has(k) || k === heroId) && !this.groupsApart(mine, g.ids))
          .slice(0, W.max);
        if (m.length) asks[id] = { id, name: p.name, matches: m };
      }
      const key = (a) => Object.keys(a).sort().map((k) => k + ':' + a[k].matches.map((x) => x.id).join(',')).join(';');
      const changed = key(asks) !== key(this.whoAsks || {});
      this.whoAsks = asks;
      if (changed) this.emit('whoAsk', asks);
      return asks;
    }

    // "Someone new" to "Who is this?": that account isn't asked about again (Link reads still joins it by hand).
    markNew(id) {
      const ok = this.db.newOk || (this.db.newOk = {});
      ok[id] = this.now();
      if (this.whoAsks) delete this.whoAsks[id];
      this.emit('save', this.db);
      return true;
    }

    // "Different players": id and that read are never suggested together again.
    refuseLink(a, b) {
      const ns = this.db.notSame || (this.db.notSame = {});
      for (const x of this.groupOf(a)) for (const y of this.groupOf(b)) ns[pairKey(x, y)] = this.now();
      if (this.linkAsks && this.linkAsks[a]) {
        const e = this.linkAsks[a];
        e.matches = e.matches.filter((m) => !m.ids.includes(b));
        if (!e.matches.length) delete this.linkAsks[a];
      }
      this.emit('save', this.db);
      return true;
    }

    // By hand (the panel): a and b are one player. Refused when they were dealt into the same
    // hand, or when one of them is hero. Clears earlier "not the same player" answers between them.
    link(a, b) {
      const heroId = this.snap && this.snap.heroAuthId;
      if (!a || !b || a === b) return { ok: false, error: 'Pick two different players.' };
      if (a === heroId || b === heroId) return { ok: false, error: "That's you." };
      const has = (k) => this.db.players[k] || (this.db.seen && this.db.seen[k]);
      if (!has(a) || !has(b)) return { ok: false, error: 'No reads for that player yet.' };
      const A = this.groupOf(a), B = this.groupOf(b);
      if (A[0] === B[0]) return { ok: true, already: true, info: this.linkInfo(a) };
      const c = this.groupsApart(A, B, true);
      if (c) {
        const nameOf = (k) => this.namesOf(k)[0] || k;
        return { ok: false, error: `${nameOf(c.a)} and ${nameOf(c.b)} played the same hand, so they are two players.` };
      }
      for (const x of A) {
        if (!this.db.players[x]) this.record(x, this.namesOf(x)[0]);
        for (const y of B) if (this.db.notSame) delete this.db.notSame[pairKey(x, y)];
      }
      for (const y of B) if (!this.db.players[y]) this.record(y, this.namesOf(y)[0]);
      this.joinGroups([B, A]);
      if (this.linkAsks) for (const x of this.groupOf(a)) delete this.linkAsks[x];
      if (this.whoAsks) for (const x of this.groupOf(a)) delete this.whoAsks[x];
      const log = this.db.linkLog || (this.db.linkLog = []);
      log.push({ t: this.now(), id: a, name: this.namesOf(a)[0], ids: this.groupOf(a).slice() });
      if (log.length > 50) log.splice(0, log.length - 50);
      const info = this.linkInfo(a);
      this.emit('link', info);
      this.emit('save', this.db);
      return { ok: true, info };
    }

    // "Not the same player" after linking: id leaves its group with its own counts, and is not
    // suggested with the rest again.
    unlink(id) {
      const g = this.groupOf(id);
      if (g.length < 2) return false;
      const same = this.db.same;
      const rest = g.filter((k) => k !== id);
      delete same[id];
      if (g[0] === id) { delete same[rest[0]]; for (const k of rest.slice(1)) same[k] = rest[0]; }
      const ns = this.db.notSame || (this.db.notSame = {});
      for (const k of rest) ns[pairKey(id, k)] = this.now();
      const log = this.db.linkLog || (this.db.linkLog = []);
      log.push({ t: this.now(), id, name: this.namesOf(id)[0], ids: rest.slice(), unlinked: true });
      if (log.length > 50) log.splice(0, log.length - 50);
      this.emit('unlink', { id, ids: rest });
      this.emit('save', this.db);
      return true;
    }

    // Read groups for the panel: one entry per player (linked ids together), with every name
    // used, hands, and when they were last dealt in.
    readGroups() {
      const out = [];
      const done = new Set();
      const seen = this.db.seen || {};
      const heroId = this.snap && this.snap.heroAuthId;
      for (const k of Object.keys(this.db.players)) {
        const root = this.canon(k);
        if (done.has(root) || k === heroId) continue;
        done.add(root);
        const info = this.linkInfo(root);
        info.last = Math.max(0, ...info.ids.map((x) => (seen[x] && seen[x].last) || 0));
        out.push(info);
      }
      return out.sort((a, b) => b.last - a.last || b.hands - a.hands);
    }

    // After "Import": the rebuild's links (it started from these and added to them) and its seat
    // info merged into this page's (which may know hands the stored log no longer has).
    absorbLinks(rebuilt) {
      for (const k of ['same', 'notSame', 'linkLog']) if (rebuilt[k]) this.db[k] = rebuilt[k];
      const seen = this.db.seen || (this.db.seen = {});
      for (const [id, e] of Object.entries(rebuilt.seen || {})) {
        const cur = seen[id];
        if (!cur) { seen[id] = e; continue; }
        cur.first = Math.min(cur.first, e.first);
        cur.last = Math.max(cur.last, e.last);
        for (const [n, t] of Object.entries(e.names || {})) if (!(cur.names[n] >= t)) cur.names[n] = t;
        Object.assign(cur.met, e.met);
      }
    }

    // Seat info from stored hands (raw snapshots carry account ids since v1.8.1), for reads
    // saved before v1.8.8: which ids played the same hands, and the names they used.
    learnSeats(entries) {
      const seen = this.db.seen || (this.db.seen = {});
      for (const e of entries || []) {
        const hero = (e && e.players || []).find((p) => p.hero);
        const dealt = new Map(); // id -> name, for everyone in the hand in any snapshot
        for (const r of (e && e.raw) || []) {
          for (const x of r.s || []) {
            if (!x[5] || (hero && x[1] === hero.name)) continue;
            if (x[4] === 'playing' || x[4] === 'folded' || x[4] === 'all_in') dealt.set(x[5], x[1]);
          }
        }
        const t = e.t || 0;
        for (const [id, name] of dealt) {
          const en = seen[id] || (seen[id] = { names: {}, met: {}, first: t, last: t });
          if (!(en.first <= t)) en.first = t;
          if (!(en.last >= t)) en.last = t;
          if (name && !(en.names[name] >= t)) en.names[name] = t;
          for (const o of dealt.keys()) if (o !== id) en.met[o] = 1;
        }
      }
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
      const dealt = s.players.filter((p) => (p.playState === 'playing' || p.playState === 'folded' || p.playState === 'all_in') && p.authUserId && p.authUserId !== s.heroAuthId);
      // Seats first (who played together), then which new ids might be an older read.
      if (this.linkReads !== false) {
        this.noteSeats(dealt.map((p) => p.authUserId), dealt.map((p) => p.name), this.now());
        this.askLinks(dealt, s.heroAuthId);
        this.askWho(dealt, s.heroAuthId);
      }
      // Counts shrink for every id of a player dealt in (linked ids together), once a hand.
      const decayed = new Set();
      for (const p of s.players) {
        if (p.playState !== 'playing' && p.playState !== 'folded' && p.playState !== 'all_in') continue;
        if (p.authUserId !== s.heroAuthId) {
          for (const k of this.groupOf(p.authUserId)) {
            const known = this.db.players[k];
            if (decayed.has(k) || !known || !known.tally) continue;
            decayed.add(k);
            decayTally(upgradeTally(known.tally), this.decay);
          }
        }
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
        currentBet: 0, preRaises: 0, dealerPos: null, bigBlind: this.settingsBB || s.bigBlind || null,
        finished: false, log: [], raw: this.pendingRaw || [], turnAt: {}, t0: this.rawStart || this.now(),
      };
      this.pendingRaw = null;
      this.emit('hand', this.hand);
    }

    // The clock for think times and raw event times; rebuildReads replays a hand on its recorded times.
    now() { return this.clock ? this.clock() : Date.now(); }

    handle(ev, data, snap) {
      if (snap) this.snap = snap;
      if (ev === 'game:stage_began' && data && data.stageType === 'set_blinds') this.rawStart = this.now();
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
          if (h) {
            h.dealerPos = data.dealerSeatPos;
            h.sbPos = data.smallBlindSeatPos || null;
            h.bbPos = data.bigBlindSeatPos || null;
            h.utgPos = data.underTheGunSeatPos || null;
          }
          break;
        case 'game:small_blind_paid':
        case 'game:big_blind_paid': {
          if (!h) break;
          const p = h.players[data.playerId];
          const ps = p && this.snap && this.snap.players.find((x) => x.id === p.id);
          if (p) {
            p.stageBet += data.amount; p.total += data.amount;
            // A blind that takes the whole stack: all-in from the start, with any two cards.
            if (ps && ps.stack != null && ps.stack - data.amount <= 0) { p.allin = true; p.blindAllin = true; }
            h.log.push({ st: 'pre', who: p.name, hero: p.id === this.heroId(), act: ev === 'game:big_blind_paid' ? 'bb' : 'sb', amt: data.amount });
          }
          h.currentBet = Math.max(h.currentBet, data.amount);
          if (ev === 'game:big_blind_paid') {
            // A big blind posted short (the player is all-in for less) doesn't change the blinds.
            const short = ps && ps.stack - data.amount <= 0;
            h.bigBlind = Math.max(data.amount, this.settingsBB || 0, short ? (this.snap && this.snap.bigBlind) || 0 : 0);
          }
          break;
        }
        case 'admin:game:new_hand_started': {
          // The table's settings for the next hand (it comes just before set_blinds).
          const gs = data && data.gameSettings;
          if (gs && gs.big_blind > 0) this.settingsBB = +gs.big_blind;
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
          if (h) h.turnAt[data.playerID] = this.now();
          if (h && !h.finished) {
            if (snap) this.checkChips(snap);
            const left = data.turnTimeDurationMS > 0 ? data.turnTimeDurationMS - (data.turnTimeElapsedMS || 0) : null;
            // Players who are all-in still get a turn, and the server checks for them at once:
            // that is no decision for hero.
            const p = h.players[data.playerID];
            this.emit('turn', { playerID: data.playerID, isHero: data.playerID === this.heroId() && !(p && p.allin), timeLeftMs: left });
          }
          break;
        case 'player:game:player_play_state_changed': {
          // A player who leaves the table mid-hand (or is kicked) is out of the hand, and the server
          // sends no fold for them (a live player left during a pause in Marwin's log).
          const st = data && data.newPlayState;
          if (h && !h.finished && (st === 'exiting' || st === 'unseated')) {
            const p = Object.values(h.players).find((x) => x.auth && x.auth === data.userId);
            if (p && !p.folded) { p.folded = true; p.left = true; }
          }
          break;
        }
        case 'chat_message': {
          // The host set a stack ("pss" game log: Admin updated stack, `amt` the new stack behind, `ostk` the old one).
          // Mid-hand (6 Nov afternoon: the game paused during a hand, MarAllin 403 -> 272) the table's stacks then
          // no longer match the chips counted, and advice stopped for the hand. Move that player's starting stack by
          // the change, so the chips still add up (and the hand's result leaves it out).
          // After the hand, while its result still waits for the next hand's stacks (no payout), the same move keeps
          // the change out of that result.
          const lg = data && data.msgType === 'game_log' && data.log;
          const open = h && (!h.finished || (h.logEntry && !h.logEntry.net && !h.noSettle));
          if (open && lg && lg.e === 'pss' && lg.pid && isFinite(+lg.amt) && isFinite(+lg.ostk)) {
            const p = Object.values(h.players).find((x) => x.auth && x.auth === lg.pid);
            if (p) {
              const dlt = +lg.amt - +lg.ostk;
              p.start += dlt;
              p.adminStack = Math.round(((p.adminStack || 0) + dlt) * 100) / 100;
              if (h.desync && h.desync.who === p.name && Math.abs(p.start - p.total - +lg.amt) <= 0.01) delete h.desync;
              const lp = h.finished && (h.logEntry.players || []).find((x) => x.name === p.name);
              if (lp) lp.adminStack = p.adminStack;
            }
          }
          break;
        }
        case 'game:player_turn_ended':
          if (h && data.playerID === this.heroId()) this.emit('heroDone', null);
          break;
        case 'game:game_ended':
        case 'admin:game:game_stopped':
          if (ev === 'admin:game:game_stopped' && h && !h.finished) h.stopped = true;
          this.finishHand();
          if (ev === 'game:game_ended' && h) this.settleFromPayout(h, data);
          break;
        case 'admin:game:player_stacks_reset':
          // The host reset every stack between hands (6 Nov afternoon: the game stopped mid-hand, then "All player
          // stacks were reset to $200"). The next hand's starting stacks then say nothing about this hand's result,
          // which the hand log filled in from them (hero -152bb, and +79bb later, for hands that cost 1bb). A hand the
          // host stops before the payout hands every bet back (the 3 such hands in the logs without a reset: every
          // stack the same the next hand), so its result is 0; another hand without a result keeps none.
          if (h && h.finished && h.logEntry && !h.logEntry.net) {
            h.logEntry.stackReset = isFinite(+data.newStackAmount) ? +data.newStackAmount : true;
            if (h.stopped) {
              const net = {};
              for (const p of Object.values(h.players)) net[p.name] = 0;
              this.applyNet(h, net);
            } else h.noSettle = true;
          }
          break;
        default:
          break;
      }
    }

    // Safety net: at each turn the table's stacks are current (docs/protocol.md), so every player's
    // stack at the start of the hand minus the chips counted for them must match it. If not, an
    // event was missed (a reconnect) or the table did something the tracker doesn't know (a
    // straddle, an ante): the pot and the price would be wrong, so advice stops for this hand.
    // A player the table shows as folded is out, even if their fold was missed (in the 128 logged
    // hands the two always agreed).
    checkChips(snap) {
      const h = this.hand;
      if (!h || !snap || !snap.players) return;
      for (const p of Object.values(h.players)) {
        const sp = snap.players.find((x) => x.id === p.id);
        if (sp && !p.folded && sp.playState === 'folded') { p.folded = true; p.missedFold = true; }
      }
      if (h.desync) return;
      for (const p of Object.values(h.players)) {
        if (p.left) continue;
        const sp = snap.players.find((x) => x.id === p.id);
        if (!sp || sp.stack == null || !isFinite(+sp.stack)) continue;
        const tracked = p.start - p.total;
        if (Math.abs(tracked - +sp.stack) > 0.01) {
          const r2 = (x) => Math.round(x * 100) / 100;
          h.desync = { who: p.name, tracked: r2(tracked), table: r2(+sp.stack), street: h.board.length };
          return;
        }
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
      // A player who is already all-in gets a turn on every later street and the server checks for
      // them (wasServerAutoAction), even facing a bet. That is no decision: counted as a check it
      // narrowed their range as if they had chosen to check, and moved their reads.
      if (p.allin && !(added > 0)) return;
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
          ? (kind === 'fold' || kind === 'call' || kind === 'raise') && { kind: 'face', n: street, out: kind, frac: facing / Math.max(1, potBefore - facing), aggLine: p.agg.length > 0, mw: multiway, reraised: /^\dbet$/.test(PatioTracker.preAction(p)),
            // First action on this street a check (true), or none before this one (false).
            checked: p.seq[key].length >= 2 ? (p.seq[key][0] === 'check' ? true : null) : false }
          : (kind === 'check' || kind === 'bet') && { kind: 'open', n: street, out: kind, cbet: street === 3 && h.pfRaiser === p.id && !p.cbetSeen && !h.flopBet, mw: multiway };
        if (d) {
          const rd = this.scorePrediction(r.tally, Object.assign(d, { pos: this.posGroup(p.id) }), this.readTally(p.auth));
          // A chance to open the betting, with the read's P(bet) before it counts (BET_RECENT).
          if (d.kind === 'open' && rd) PatioTracker.addBetRecent(r.tally, rd, kind === 'bet', this.now());
        }
      }
      if (r) this.extraStats(p, r.tally, kind, facing, key);
      // Hero's opening bet into 2+ opponents after the flop, and each answer to it until someone stays (MW_BET_FOLD's
      // per-player read).
      if (street > 0) {
        const mo = h.mwOpen && h.mwOpen.st === street ? h.mwOpen : null;
        if (isHero && kind === 'bet') {
          const k = Object.values(h.players).filter((x) => !x.folded && x.id !== p.id).length;
          h.mwOpen = k >= 2 ? { st: street, k, stayed: false } : null;
        } else if (isHero && mo) mo.stayed = true;
        else if (!isHero && mo && !mo.stayed && facing > 0 && (kind === 'fold' || kind === 'call' || kind === 'raise')) {
          const f = facing / Math.max(1, potBefore - facing);
          if (r && f >= 0.3) {
            const t = r.tally;
            if (!t.mwFolds) t.mwFolds = [];
            const ck = p.seq[key].length >= 2 && p.seq[key][0] === 'check';
            t.mwFolds.push({ y: kind === 'fold' ? 1 : 0, f: Math.round(f * 1000) / 1000, n: street, ck: ck ? 1 : 0, ag: p.agg.length > 0 ? 1 : 0, rr: /^\dbet$/.test(PatioTracker.preAction(p)) ? 1 : 0, k: mo.k, at: this.now() });
            if (t.mwFolds.length > MAX_MW_FOLDS) t.mwFolds.splice(0, t.mwFolds.length - MAX_MW_FOLDS);
          }
          if (kind !== 'fold') mo.stayed = true;
        }
      }
      // Answers to a raise after the flop (tally.vsRaise): this street had a bet and a raise before this action.
      if (r && street > 0 && facing > 0 && (kind === 'fold' || kind === 'call' || kind === 'raise')) {
        const a = PatioTracker.vsRaiseEntry(h.log.slice(0, -1), h.log[h.log.length - 1]);
        if (a) {
          a.f = Math.round((facing / Math.max(1, potBefore - facing)) * 1000) / 1000;
          a.ag = p.agg.length > 0 ? 1 : 0;
          a.rr = /^\dbet$/.test(PatioTracker.preAction(p)) ? 1 : 0;
          a.at = this.now();
          const t = r.tally;
          if (!t.vsRaise) t.vsRaise = [];
          t.vsRaise.push(a);
          if (t.vsRaise.length > MAX_VS_RAISE) t.vsRaise.splice(0, t.vsRaise.length - MAX_VS_RAISE);
        }
      }
      if (street === 0) {
        if (r && !p.faced3 && h.preRaises === 1 && kind !== 'check') {
          p.faced3 = true;
          r.tally.pf3betOpp++;
          if (kind === '3bet') r.tally.pf3bet++;
          // Response to an open by size, for players who had not acted yet (limpers facing a raise
          // keep most of their limping range, and the solver asks only about players still to act).
          const toBB = h.bigBlind > 0 && p.seq.pre.length === 1 ? (p.stageBet - added + facing) / h.bigBlind : 0;
          const vo = toBB > 0 && r.tally.vsOpen && r.tally.vsOpen[toBB <= 2.5 ? 'small' : toBB <= 3.5 ? 'medium' : toBB < 8 ? 'large' : 'huge'];
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
          // Raise-to and chips left behind, in big blinds (v1.8.15): huge raises that keep chips behind read tight.
          if (bb > 0) {
            p.sizes.preTo = Math.round((p.stageBet / bb) * 100) / 100;
            p.sizes.preBehind = Math.round((Math.max(0, p.start - p.total) / bb) * 100) / 100;
            // The most chips any other player still in had at the start of the hand (v1.8.23): how deep a shove really
            // is when a big stack shoves into shorter ones (DEEP_SHOVE).
            let cover = 0;
            for (const x of Object.values(h.players)) if (x.id !== p.id && !x.folded) cover = Math.max(cover, x.start);
            p.sizes.preCover = Math.round((cover / bb) * 100) / 100;
          }
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
            const f = facing / Math.max(1, potBefore - facing), vb = t.vs[sizeBucket(f)];
            vb[kind]++;
            vb.fs = (vb.fs || 0) + Math.min(f, 3);
            vb.fn = (vb.fn || 0) + 1;
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
          const out = { pfFold: 'fold', pfCall: 'call', pfRaise: 'raise' }[p.pfCat || 'pfFold'];
          const rd = this.scorePrediction(r.tally, { kind: 'pf', out, pos: g }, this.readTally(p.auth));
          // The hand's preflop, with the read's P(fold) and P(raise) before it counts (PF_RECENT).
          if (rd) PatioTracker.addPfRecent(r.tally, rd, out, this.now());
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
        t: this.now(), board: h.board.slice(), bigBlind: h.bigBlind,
        hero: h.heroUids.map((u) => h.heroCards[u]).filter(Boolean),
        pot: Object.values(h.players).reduce((a, p) => a + p.total, 0),
        advice: (h.advice || []).slice(),
        log: h.log.slice(),
        raw: h.raw,
        desync: h.desync || undefined,
        players: Object.values(h.players).map((p) => ({
          name: p.name, hero: p.id === heroId, position: this.posGroup(p.id), folded: p.folded, stack: p.start,
          put: p.total, actions: p.seq, shown: p.shown, fit: p.fit, accuracy: p.accuracy, left: p.left || undefined,
          adminStack: p.adminStack || undefined,
          pred: p.id === heroId ? undefined : predSummary(this.readTally(p.auth)),
          accounts: p.id !== heroId && this.groupOf(p.auth).length > 1 ? this.groupOf(p.auth).length : undefined,
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
      if (h.turnAt[p.id]) { e.ms = this.now() - h.turnAt[p.id]; delete h.turnAt[p.id]; }
      if (snapP && snapP.stack != null) e.stack = r2(+snapP.stack);
      if (potBefore > 0 && (kind === 'bet' || kind === 'raise' || kind === '3bet')) e.potPct = Math.round(100 * Math.max(0, added - facing) / (potBefore + facing));
      if (p.allin) e.allin = true;
      h.log.push(e);
      if (!isHero || !h.advice) return;
      const adv = h.advice.slice().reverse().find((a) => a.street === h.board.length && !a.did);
      if (!adv) return;
      adv.did = kind + (added > 0 ? ' ' + r2(added) : '');
      const group = (k) => (k === 'bet' || k === 'raise' || k === '3bet' || k === 'allin' ? 'aggr' : k);
      if (adv.kind) adv.followed = PatioTracker.followedAdvice(adv, kind);
      // How far hero's bet or raise was from the advised size (1 = as advised; a min-raise against
      // "raise to 7x" shows as about 0.3). `followed` only checks the kind of action.
      if (adv.amount > 0 && added > 0 && group(adv.kind) === 'aggr' && group(kind) === 'aggr') adv.sizeRatio = r2(added / adv.amount);
    }

    // Read accuracy: before an action is counted, how likely the read made it, and how likely an
    // average player's read did. `predictor(tally, d)` (set by the UI from the engine) returns
    // [read probabilities, average-player probabilities] for the decision d. The score is counted
    // in t (the player's own record); `read` is the tally the read comes from (linked ids added up).
    // Returns the read's probabilities (null without a predictor).
    scorePrediction(t, d, read) {
      if (!this.predictor || !t.pred) return null;
      try {
        const [rd, pop] = this.predictor(read || t, d);
        const pr = (x) => { let s = 0; for (const v of Object.values(x)) s += Math.max(0, v); return Math.max(1e-3, (x[d.out] || 0) / (s || 1)); };
        t.pred.n++;
        t.pred.read += -Math.log(pr(rd));
        t.pred.pop += -Math.log(pr(pop));
        return rd;
      } catch (e) { return null; /* scoring is optional */ }
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

    // The table's shows after a flop the player did not bet or raise, by players who put 15bb+ in: their scoreShow
    // tilt log-likelihoods summed, in hero's pots (hi) and in pots hero had left (ho), for the engine's learned
    // hero-pot tilt (heroPotLearned in engine.js). Shows saved by older versions carry no `hp` and are left out.
    // Shows saved before v1.8.9 carry no `hp`, so heroPotShows would leave out every show in reads built from
    // earlier sessions. They are filled in from the stored hands: the hand where the same two cards were shown on
    // a board that starts with the show's board (a show at an all-in can come before the last cards), with the same
    // formula as onReveal. Returns how many shows were tagged.
    tagHeroPot(entries) {
      const key = (cards) => cards.slice().sort().join(',');
      const byCards = new Map();
      for (const e of entries || []) {
        if (!e || !Array.isArray(e.board) || e.board.length < 3 || !Array.isArray(e.players)) continue;
        const hero = e.players.find((p) => p && p.hero);
        for (const p of e.players) {
          if (!p || p.hero || !Array.isArray(p.shown) || p.shown.length !== 2 || p.put == null) continue;
          const k = key(p.shown);
          if (!byCards.has(k)) byCards.set(k, []);
          byCards.get(k).push({ board: e.board, hp: { in: !!(hero && !hero.folded), put: Math.round(((p.put || 0) / (e.bigBlind || 1)) * 10) / 10 } });
        }
      }
      let n = 0;
      for (const r of Object.values(this.db.players)) {
        for (const s of (r && r.tally && r.tally.shows) || []) {
          if (!s || s.hp || !Array.isArray(s.cards) || s.cards.length !== 2 || !Array.isArray(s.board)) continue;
          const m = (byCards.get(key(s.cards)) || []).filter((c) => s.board.every((x, i) => c.board[i] === x));
          if (m.length !== 1) continue;
          s.hp = Object.assign({}, m[0].hp);
          n++;
        }
      }
      return n;
    }

    // Shown all-in re-raises from hands stored before v1.8.27, which recorded no `jamShows` (DEEP_SHOVE's per-player read):
    // found in each stored hand's action log (the player's last preflop raise was a re-raise that left under a tenth of
    // the raise-to behind, and their cards were shown) and added to that player's read, oldest first, newest
    // MAX_JAM_SHOWS kept, skipping any already there. The player is the account id the hand's raw events give that name,
    // else the one read that used the name around that time. Returns how many were added.
    tagJamShows(entries) {
      const seen = this.db.seen || {};
      const idFor = (name, t, raw) => {
        for (const r of raw || []) for (const x of (r && r.s) || []) if (x && x[1] === name && x[5] && this.db.players[x[5]]) return x[5];
        const ids = Object.keys(this.db.players).filter((id) => (seen[id] && seen[id].names && seen[id].names[name] != null) || this.db.players[id].name === name);
        if (ids.length === 1) return ids[0];
        const at = ids.filter((id) => seen[id] && seen[id].first <= t + 6e5 && seen[id].last >= t - 6e5);
        return at.length === 1 ? at[0] : null;
      };
      const list = (entries || []).filter((e) => e && Array.isArray(e.log) && Array.isArray(e.players) && e.bigBlind > 0).sort((a, b) => (a.t || 0) - (b.t || 0));
      let n = 0;
      for (const e of list) {
        const bb = e.bigBlind;
        const pre = e.log.filter((x) => x && x.st === 'pre');
        for (const p of e.players) {
          if (!p || p.hero || !Array.isArray(p.shown) || p.shown.length !== 2) continue;
          let i = -1;
          for (let j = 0; j < pre.length; j++) if (pre[j].who === p.name && (pre[j].act === 'raise' || pre[j].act === '3bet')) i = j;
          if (i < 0) continue;
          const x = pre[i];
          const top = 1 + pre.slice(0, i).filter((y) => y.act === 'raise' || y.act === '3bet').length;
          if (top < 2 || !(x.to > 0)) continue;
          const to = Math.round((x.to / bb) * 100) / 100;
          const behind = x.stack != null ? Math.max(0, x.stack - (x.amt || 0)) / bb : x.allin ? 0 : null;
          if (behind == null || behind > 0.1 * to) continue;
          const folded = new Set(pre.slice(0, i).filter((y) => y.act === 'fold').map((y) => y.who));
          let cover = 0;
          for (const q of e.players) if (q && q.name !== p.name && !folded.has(q.name) && q.stack > cover) cover = q.stack;
          const id = idFor(p.name, e.t || 0, e.raw);
          const r = id && this.db.players[id];
          if (!r) continue;
          const t = r.tally || (r.tally = blankTally());
          if (!t.jamShows) t.jamShows = [];
          const cards = p.shown.slice();
          const key = cards.slice().sort().join('');
          if (t.jamShows.some((s) => s && Array.isArray(s.cards) && s.cards.slice().sort().join('') === key && Math.abs((s.to || 0) - to) < 0.02)) continue;
          t.jamShows.push(Object.assign({ cards, pre: top >= 4 ? '5bet' : top === 3 ? '4bet' : '3bet', to, cover: Math.round((cover / bb) * 100) / 100 }, e.t > 0 ? { at: e.t } : {}));
          if (t.jamShows.length > MAX_JAM_SHOWS) t.jamShows.splice(0, t.jamShows.length - MAX_JAM_SHOWS);
          n++;
        }
      }
      return n;
    }

    heroPotShows() {
      const out = { hi: null, hiN: 0, ho: null, hoN: 0 };
      for (const r of Object.values(this.db.players)) {
        for (const s of (r && r.tally && r.tally.shows) || []) {
          const f = s && s.fit;
          if (!s || s.folded || !s.hp || !(s.hp.put >= 15) || !f || !Array.isArray(f.tl)) continue;
          if (this.fitVersion != null && f.v !== this.fitVersion) continue;
          if (/bet|raise/.test((s.actions && s.actions.flop) || '')) continue;
          const k = s.hp.in ? 'hi' : 'ho';
          if (out[k] && out[k].length !== f.tl.length) continue;
          out[k] = out[k] ? out[k].map((x, i) => x + f.tl[i]) : f.tl.slice();
          out[k + 'N']++;
        }
      }
      return out;
    }

    // Shows scored by an older engine (or not at all) are scored again a few at a time after each
    // hand, so learned tilts and noise use the current range model. `fitVersion` is set by the UI.
    rescoreStale(limit) {
      if (!this.scorer || this.fitVersion == null) return 0;
      let done = 0;
      for (const [id, r] of Object.entries(this.db.players)) {
        const shows = (r.tally && r.tally.shows) || [];
        for (const sh of shows) {
          if (done >= limit) return done;
          if (!sh || sh.folded || (sh.fit && sh.fit.v === this.fitVersion) || sh.rescored === this.fitVersion) continue;
          sh.rescored = this.fitVersion;
          done++;
          try {
            const rt = this.readTally(id) || r.tally;
            const others = Object.assign({}, rt, { shows: (rt.shows || []).filter((x) => x !== sh) });
            const fit = this.scorer(sh, others);
            if (fit) sh.fit = fit;
          } catch (e) { /* keep the old fit */ }
        }
      }
      return done;
    }

    // Shows saved before v1.8.29 don't say whether hero checked the river first (CHECK_BET_TILT's per-player read, show
    // `hck`): filled in from the stored hands, matched like tagHeroPot (same two cards, a board that starts with the
    // show's). Returns how many shows were tagged.
    tagCheckBet(entries) {
      const key = (cards) => cards.slice().sort().join(',');
      const byCards = new Map();
      for (const e of entries || []) {
        if (!e || !Array.isArray(e.board) || e.board.length < 3 || !Array.isArray(e.players) || !Array.isArray(e.log)) continue;
        const first = e.log.find((x) => x && x.st === 'river' && x.hero);
        const hck = !!(e.board.length >= 5 && first && first.act === 'check');
        for (const p of e.players) {
          if (!p || p.hero || !Array.isArray(p.shown) || p.shown.length !== 2) continue;
          const k = key(p.shown);
          if (!byCards.has(k)) byCards.set(k, []);
          byCards.get(k).push({ board: e.board, hck });
        }
      }
      let n = 0;
      for (const r of Object.values(this.db.players)) {
        for (const s of (r && r.tally && r.tally.shows) || []) {
          if (!s || s.hck != null || !Array.isArray(s.cards) || s.cards.length !== 2 || !Array.isArray(s.board)) continue;
          const m = (byCards.get(key(s.cards)) || []).filter((c) => s.board.every((x, i) => c.board[i] === x));
          if (m.length !== 1) continue;
          s.hck = m[0].hck;
          n++;
        }
      }
      return n;
    }

    // Shows saved before v1.8.36 don't say whether they reached a showdown (show `sd`, CHECK_BET_TILT's showdowns-only
    // read): filled in from the stored hands, matched like tagCheckBet; a showdown when two or more players were still in
    // at the end. Returns how many shows were tagged.
    tagShowdown(entries) {
      const key = (cards) => cards.slice().sort().join(',');
      const byCards = new Map();
      for (const e of entries || []) {
        if (!e || !Array.isArray(e.board) || e.board.length < 3 || !Array.isArray(e.players)) continue;
        const live = e.players.filter((p) => p && !p.folded).length;
        for (const p of e.players) {
          if (!p || p.hero || !Array.isArray(p.shown) || p.shown.length !== 2) continue;
          const k = key(p.shown);
          if (!byCards.has(k)) byCards.set(k, []);
          byCards.get(k).push({ board: e.board, sd: !p.folded && live >= 2 });
        }
      }
      let n = 0;
      for (const r of Object.values(this.db.players)) {
        for (const s of (r && r.tally && r.tally.shows) || []) {
          if (!s || s.sd != null || !Array.isArray(s.cards) || s.cards.length !== 2 || !Array.isArray(s.board)) continue;
          const m = (byCards.get(key(s.cards)) || []).filter((c) => s.board.every((x, i) => c.board[i] === x));
          if (m.length !== 1) continue;
          s.sd = m[0].sd;
          n++;
        }
      }
      return n;
    }

    // Shows and shown all-in re-raises saved before v1.8.46 carry no `at`, so a linked read can't put them in time order
    // (byTime). Filled in from the stored hands: the hand's start time where the same two cards were shown on a board
    // that starts with the show's (as tagHeroPot), for jamShows the hand where they were shown after a preflop re-raise
    // to the same size. Shows older than the stored hands keep none. Returns how many were tagged.
    tagShowTimes(entries) {
      const key = (cards) => cards.slice().sort().join(',');
      const byCards = new Map();
      for (const e of entries || []) {
        if (!e || !(e.t > 0) || !Array.isArray(e.players)) continue;
        const bb = e.bigBlind > 0 ? e.bigBlind : 0;
        for (const p of e.players) {
          if (!p || p.hero || !Array.isArray(p.shown) || p.shown.length !== 2) continue;
          const tos = bb && Array.isArray(e.log) ? e.log.filter((x) => x && x.st === 'pre' && x.who === p.name && /^(raise|\dbet)$/.test(x.act) && x.to > 0).map((x) => Math.round((x.to / bb) * 100) / 100) : [];
          const k = key(p.shown);
          if (!byCards.has(k)) byCards.set(k, []);
          byCards.get(k).push({ board: Array.isArray(e.board) ? e.board : [], t: e.t, tos });
        }
      }
      let n = 0;
      for (const r of Object.values(this.db.players)) {
        const t = r && r.tally;
        for (const s of (t && t.shows) || []) {
          if (!s || s.at > 0 || !Array.isArray(s.cards) || s.cards.length !== 2 || !Array.isArray(s.board)) continue;
          const m = (byCards.get(key(s.cards)) || []).filter((c) => c.board.length >= s.board.length && s.board.every((x, i) => c.board[i] === x));
          if (m.length !== 1) continue;
          s.at = m[0].t;
          n++;
        }
        for (const s of (t && t.jamShows) || []) {
          if (!s || s.at > 0 || !Array.isArray(s.cards) || s.cards.length !== 2) continue;
          const m = (byCards.get(key(s.cards)) || []).filter((c) => c.tos.some((x) => Math.abs(x - (s.to || 0)) < 0.02));
          if (m.length !== 1) continue;
          s.at = m[0].t;
          n++;
        }
      }
      return n;
    }

    // First answers to hero's multiway bets from hands stored before v1.8.29 (MW_BET_FOLD's per-player read,
    // tally.mwFolds): found in each stored hand's action log the way the live tracker counts them (hero's opening bet
    // after the flop into 2+ opponents, each answer of 30%+ of the pot until someone stays), oldest first, added to the
    // player's read (the account id as tagJamShows finds it). Meant to run once, before any hand of this version.
    // Returns how many answers were added.
    tagMwFolds(entries) {
      const seen = this.db.seen || {};
      const idFor = (name, t, raw) => {
        for (const r of raw || []) for (const x of (r && r.s) || []) if (x && x[1] === name && x[5] && this.db.players[x[5]]) return x[5];
        const ids = Object.keys(this.db.players).filter((id) => (seen[id] && seen[id].names && seen[id].names[name] != null) || this.db.players[id].name === name);
        if (ids.length === 1) return ids[0];
        const at = ids.filter((id) => seen[id] && seen[id].first <= t + 6e5 && seen[id].last >= t - 6e5);
        return at.length === 1 ? at[0] : null;
      };
      const list = (entries || []).filter((e) => e && Array.isArray(e.log) && Array.isArray(e.players)).sort((a, b) => (a.t || 0) - (b.t || 0));
      let n = 0;
      for (const e of list) {
        const log = e.log.filter((x) => x && x.act && x.act !== 'sb' && x.act !== 'bb');
        for (const st of ['flop', 'turn', 'river']) {
          const i = log.findIndex((x) => x.st === st && x.hero && x.act === 'bet');
          if (i < 0) continue;
          const bet = log[i];
          const folded = new Set(log.slice(0, i).filter((x) => x.act === 'fold').map((x) => x.who));
          const k = e.players.filter((p) => p && !p.hero && !folded.has(p.name)).length;
          if (k < 2 || !(bet.pot > 0)) continue;
          const f = bet.amt / bet.pot;
          for (const x of log.slice(i + 1)) {
            if (x.st !== st || x.hero) break;
            if (x.act !== 'fold' && x.act !== 'call' && x.act !== 'raise') break;
            if (f >= 0.3) {
              const id = idFor(x.who, e.t || 0, e.raw);
              const r = id && this.db.players[id];
              if (r) {
                const t = r.tally || (r.tally = blankTally());
                if (!t.mwFolds) t.mwFolds = [];
                const mine = log.slice(0, i + 1).filter((y) => y.who === x.who);
                t.mwFolds.push(Object.assign({
                  y: x.act === 'fold' ? 1 : 0, f: Math.round(f * 1000) / 1000, n: { flop: 3, turn: 4, river: 5 }[st],
                  ck: mine.some((y) => y.st === st && y.act === 'check') ? 1 : 0,
                  ag: mine.some((y) => y.st !== 'pre' && (y.act === 'bet' || y.act === 'raise')) ? 1 : 0,
                  rr: mine.some((y) => y.st === 'pre' && /^\dbet$/.test(y.act)) ? 1 : 0, k,
                }, e.t > 0 ? { at: e.t } : {}));
                if (t.mwFolds.length > MAX_MW_FOLDS) t.mwFolds.splice(0, t.mwFolds.length - MAX_MW_FOLDS);
                n++;
              }
            }
            if (x.act !== 'fold') break;
          }
        }
      }
      return n;
    }

    // Answers to raises after the flop from hands stored before v1.8.44 (tally.vsRaise, COLD_RAISE and RAISED_RR's
    // per-player reads), found in each stored hand's action log as the live tracker counts them, oldest first (the
    // account id as tagMwFolds finds it). Meant to run once, before any hand of this version. Returns how many were added.
    tagVsRaise(entries) {
      const seen = this.db.seen || {};
      const idFor = (name, t, raw) => {
        for (const r of raw || []) for (const x of (r && r.s) || []) if (x && x[1] === name && x[5] && this.db.players[x[5]]) return x[5];
        const ids = Object.keys(this.db.players).filter((id) => (seen[id] && seen[id].names && seen[id].names[name] != null) || this.db.players[id].name === name);
        if (ids.length === 1) return ids[0];
        const at = ids.filter((id) => seen[id] && seen[id].first <= t + 6e5 && seen[id].last >= t - 6e5);
        return at.length === 1 ? at[0] : null;
      };
      const list = (entries || []).filter((e) => e && Array.isArray(e.log) && Array.isArray(e.players)).sort((a, b) => (a.t || 0) - (b.t || 0));
      let n = 0;
      for (const e of list) {
        const log = e.log.filter((x) => x && x.act);
        log.forEach((x, i) => {
          if (x.hero || !(x.facing > 0)) return;
          const a = PatioTracker.vsRaiseEntry(log.slice(0, i), x);
          if (!a) return;
          const id = idFor(x.who, e.t || 0, e.raw);
          const r = id && this.db.players[id];
          if (!r) return;
          const before = log.slice(0, i).filter((y) => y.who === x.who);
          a.f = Math.round((x.facing / Math.max(1, (x.pot || 0) - x.facing)) * 1000) / 1000;
          a.ag = before.some((y) => y.st !== 'pre' && (y.act === 'bet' || y.act === 'raise')) ? 1 : 0;
          a.rr = before.some((y) => y.st === 'pre' && /^\dbet$/.test(y.act)) ? 1 : 0;
          if (e.t > 0) a.at = e.t;
          const t = r.tally || (r.tally = blankTally());
          if (!t.vsRaise) t.vsRaise = [];
          t.vsRaise.push(a);
          if (t.vsRaise.length > MAX_VS_RAISE) t.vsRaise.splice(0, t.vsRaise.length - MAX_VS_RAISE);
          n++;
        });
      }
      return n;
    }

    // Chances to open the betting after the flop from hands stored before v1.8.45 (tally.betRecent, BET_RECENT's
    // per-player read), oldest first, each with the current read's P(bet) (the read at the time isn't stored; it moves
    // little over the newest 60 chances). Needs the predictor. Meant to run once, before any hand of this version.
    // Returns how many were added.
    tagBetRecent(entries) {
      if (!this.predictor) return 0;
      const seen = this.db.seen || {};
      const idFor = (name, t, raw) => {
        for (const r of raw || []) for (const x of (r && r.s) || []) if (x && x[1] === name && x[5] && this.db.players[x[5]]) return x[5];
        const ids = Object.keys(this.db.players).filter((id) => (seen[id] && seen[id].names && seen[id].names[name] != null) || this.db.players[id].name === name);
        if (ids.length === 1) return ids[0];
        const at = ids.filter((id) => seen[id] && seen[id].first <= t + 6e5 && seen[id].last >= t - 6e5);
        return at.length === 1 ? at[0] : null;
      };
      const ST = { flop: 3, turn: 4, river: 5 };
      const list = (entries || []).filter((e) => e && Array.isArray(e.log)).sort((a, b) => (a.t || 0) - (b.t || 0));
      const reads = {};
      let n = 0;
      for (const e of list) {
        const log = e.log.filter((x) => x && x.act);
        let pfRaiser = null, flopBet = false;
        const flopActed = new Set(), ids = {};
        log.forEach((x, i) => {
          if (x.st === 'pre' && (x.act === 'raise' || /^\dbet$/.test(x.act))) pfRaiser = x.who;
          const n0 = ST[x.st];
          if (n0 && !x.hero && !(x.facing > 0) && (x.act === 'check' || x.act === 'bet')) {
            const id = ids[x.who] !== undefined ? ids[x.who] : (ids[x.who] = idFor(x.who, e.t || 0, e.raw));
            const r = id && this.db.players[id];
            if (r) {
              const d = { kind: 'open', n: n0, out: x.act, cbet: n0 === 3 && x.who === pfRaiser && !flopActed.has(x.who) && !flopBet };
              try {
                // The read is the same all through, so one prediction per player, street and c-bet chance.
                const key = (this.canon ? this.canon(id) : id) + '|' + n0 + '|' + (d.cbet ? 1 : 0);
                const rd = reads[key] || (reads[key] = this.predictor(this.readTally(id) || r.tally || blankTally(), d)[0]);
                PatioTracker.addBetRecent(r.tally || (r.tally = blankTally()), rd, x.act === 'bet', (e.t || 0) + i);
                n++;
              } catch (err) { /* optional */ }
            }
          }
          if (x.st === 'flop') { flopActed.add(x.who); if (x.act === 'bet') flopBet = true; }
        });
      }
      return n;
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
        if (p.seq.pre.length === 1 && h.preRaises === 0 && kind !== 'check') { t.limpOpp++; if (kind === 'call') { t.limp++; p.limped = true; } }
        else if (p.limped && !p.limpFaced && h.preRaises >= 1 && facing > 0) { p.limpFaced = true; t.limpFaceN++; if (kind === 'fold') t.limpFold++; }
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
      const rec = { t: this.now() - (t0 || this.now()), ev, d };
      if (snap && (isNewHand || ev === 'game:player_turn_started' || ev === 'game:game_ended' || ev === 'game:stage_began')) {
        // The account id last, so an imported log rebuilds reads under the same keys (rebuildReads).
        rec.s = (snap.players || []).map((x) => [x.id, x.name, x.stack, x.posType, x.playState, x.authUserId]);
        if (isNewHand) rec.bb = snap.bigBlind;
      }
      // Past the cap, keep only the events the tracker itself uses, so chatty extras can't push them out.
      if (list.length >= RAW_MAX_EVENTS && !/^(game:(stage_began|dealer_updated|small_blind_paid|big_blind_paid|cards?_dealt?_to_|update_card_data|player_turn|game_ended)|player:game:action_taken)/.test(ev)) return;
      list.push(rec);
    }

    // Each hand's result: what the server paid each player at game_ended (winnersInfo: won
    // plus uncalled bets handed back) minus what they put in. Without a usable payout it is
    // filled in from the next hand's starting stacks instead (settleLog), where rebuys show up
    // as winnings and a player who busted and left has no result: in Marwin's log that dropped
    // his own -60bb hand from the hand log's results.
    settleFromPayout(h, data) {
      if (!h.logEntry || h.logEntry.net) return;
      const gr = data && data.endPopupData && data.endPopupData.gameResults;
      const info = gr && gr.winnersInfo;
      if (!info || typeof info !== 'object' || !Object.keys(info).length) return;
      const list = Object.values(h.players);
      const won = {};
      let paid = 0;
      for (const [auth, w] of Object.entries(info)) {
        const pd = (w && w.playerData) || {};
        const p = list.find((x) => x.auth === (pd.authUserId || auth)) || list.find((x) => pd.posType && x.pos === pd.posType);
        if (!p) return; // a winner this hand doesn't know
        const x = (+w.wonAmount || 0) + (+w.refundUncalledBetsAmount || 0);
        won[p.id] = (won[p.id] || 0) + x;
        paid += x;
      }
      // The payout has to account for every chip put in (less any rake), or the tracker missed
      // something: then the stacks decide.
      const rake = (gr.sidePotsWithWinners || []).reduce((a, sp) => a + (+(sp && sp.potRake) || 0), 0);
      const put = list.reduce((a, p) => a + p.total, 0);
      if (Math.abs(paid + rake - put) > 0.01) return;
      const net = {};
      for (const p of list) net[p.name] = Math.round(((won[p.id] || 0) - p.total) * 100) / 100;
      this.applyNet(h, net);
    }

    // Stacks only update after the pot is paid, so without a payout (settleFromPayout) each
    // hand's result is filled in from the next hand's starting stacks.
    settleLog(s) {
      const prev = this.hand;
      if (!prev || !prev.logEntry || prev.logEntry.net || prev.noSettle) return;
      const net = {};
      for (const p of Object.values(prev.players)) {
        const now = s.players.find((x) => x.id === p.id);
        if (now && now.stack != null) net[p.name] = Math.round((+now.stack - p.start) * 100) / 100;
      }
      this.applyNet(prev, net);
    }

    applyNet(prev, net) {
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
        // Blueprint (computer mode): its own frequencies, or why it was not used.
        if (r.blueprint) a.bp = r.blueprint.actions
          ? { acts: r.blueprint.actions.filter((x) => x.p >= 0.02).map((x) => x.kind + (x.amount ? ' ' + r2(x.amount) : '') + ' ' + Math.round(x.p * 100) + '%'), visits: r2(r.blueprint.visits || 0), blended: !!r.blueprint.used }
          : { off: r.blueprint.why };
        if (r.quick) a.quick = true;
        // Hero-pot tilt in use (learned from the table's shows; n of them) and how much of it this pot gets.
        if (r.heroPot && r.heroPot.ramp > 0) a.heroPot = { tilt: r2(r.heroPot.tilt), n: r.heroPot.n, ramp: r2(r.heroPot.ramp) };
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
          tiltHero: o.stats.tiltHero ? r2(o.stats.tiltHero) : undefined,
          // The player's own numbers for the per-player reads (v1.8.29): multiway bet fold odds, river check-bet tilt.
          mwOdds: o.stats.mwBet ? { odds: r2(o.stats.mwBet.odds), n: o.stats.mwBet.n } : undefined,
          cbTilt: o.stats.tiltCheckBet ? { tilt: r2(o.stats.tiltCheckBet.tilt), n: o.stats.tiltCheckBet.n } : undefined,
          // v1.8.32: the player's own hero-pot tilt (heroPotOwn) and how many of their shows it rests on.
          hpOwn: o.stats.heroPotOwn ? { tilt: r2(o.stats.heroPotOwn.tilt), n: o.stats.heroPotOwn.n } : undefined,
          rrTilt: o.stats.tiltRaise && o.stats.tiltRaise.n ? { tilt: r2(o.stats.tiltRaise.tilt), n: o.stats.tiltRaise.n } : undefined,
          // v1.8.40: the chips-in tilt this player's range got (slope x ln(bb in / 15)), their slope and the shows it rests on.
          chTilt: o.stats.chipTilt && o.stats.chipTilt.tilt ? { tilt: r2(o.stats.chipTilt.tilt), slope: o.stats.chipTilt.slope, n: o.stats.chipTilt.n } : undefined,
          // v1.8.44: answers to hero's raise after the flop (COLD_RAISE, RAISED_RR): cold fold odds and the bettor's
          // re-raise multiplier, with the answers each rests on.
          vr: o.stats.vsRaiseRead ? { cold: r2(o.stats.vsRaiseRead.odds), nCold: o.stats.vsRaiseRead.nCold, rr: o.stats.vsRaiseRead.mult != null ? r2(o.stats.vsRaiseRead.mult) : undefined, nBet: o.stats.vsRaiseRead.nBet } : undefined,
          // v1.8.45: the player's recent-betting odds (BET_RECENT) and how many chances to bet they rest on.
          br: o.stats.betRecent ? { odds: r2(o.stats.betRecent.odds), n: o.stats.betRecent.n, on: !!o.stats.betRecent.on } : undefined,
          // v1.8.48: the player's recent preflop odds (PF_RECENT: raise and fold) and how many hands they rest on.
          pr: o.stats.pfRecent ? { raise: r2(o.stats.pfRecent.raise), fold: r2(o.stats.pfRecent.fold), n: o.stats.pfRecent.n, on: !!o.stats.pfRecent.on } : undefined,
          certainty: o.stats.certainty != null ? r2(o.stats.certainty) : undefined,
        }));
      }
      (h.advice || (h.advice = [])).push(a);
    }

    // Players in postflop order: small blind first, button last.
    // The server names the dealer, both blinds and UTG each hand, so those are pinned; only
    // players between UTG and the dealer (6+ handed) rely on the seat order (seatKey).
    seatOrder() {
      const h = this.hand;
      const all = Object.values(h.players).sort((a, b) => seatKey(a.pos) - seatKey(b.pos));
      const dealerK = seatKey(h.dealerPos);
      const ring = all.filter((p) => seatKey(p.pos) > dealerK).concat(all.filter((p) => seatKey(p.pos) <= dealerK));
      if (ring.length < 3) return ring;
      const at = (pos) => (pos ? ring.find((p) => p.pos === pos) : null);
      const dealer = at(h.dealerPos);
      const head = [];
      for (const p of [at(h.sbPos), at(h.bbPos), at(h.utgPos)]) if (p && p !== dealer && !head.includes(p)) head.push(p);
      if (!head.length) return ring;
      const rest = ring.filter((p) => p !== dealer && !head.includes(p));
      return head.concat(rest, dealer ? [dealer] : []);
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
      // A preflop all-in re-raise, shown at showdown or after everyone folded (DEEP_SHOVE's per-player read).
      const pre0 = PatioTracker.preAction(p);
      if (/^\dbet$/.test(pre0) && p.sizes.preTo > 0 && p.sizes.preBehind != null && p.sizes.preBehind <= 0.1 * p.sizes.preTo) {
        const rj = this.record(p.auth, p.name);
        if (rj) {
          if (!rj.tally.jamShows) rj.tally.jamShows = [];
          rj.tally.jamShows.push({ cards: p.shown.slice(), pre: pre0, to: p.sizes.preTo, cover: p.sizes.preCover != null ? p.sizes.preCover : null, at: this.now() });
          if (rj.tally.jamShows.length > MAX_JAM_SHOWS) rj.tally.jamShows.splice(0, rj.tally.jamShows.length - MAX_JAM_SHOWS);
          if (h.board.length < 3) this.emit('save', this.db);
        }
      }
      if (h.board.length < 3) return;
      const r = this.record(p.auth, p.name);
      if (!r) return;
      const actions = { pre: PatioTracker.preAction(p) };
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = PatioTracker.streetAction(p.seq[k], n);
      if (actions.pre === 'pending' && !p.blindAllin) actions.pre = 'call';
      const hero = Object.values(h.players).find((x) => x.id === this.heroId());
      const show = {
        cards: p.shown.slice(), board: h.board.slice(), agg: p.agg.slice(), at: this.now(),
        actions, sizes: Object.assign({}, p.sizes), ms: p.ms.slice(), pfAggressor: h.pfRaiser === p.id, position: this.posGroup(p.id),
        // Whether hero was still in the pot, and the big blinds this player put in (heroPotShows).
        hp: { in: !!(hero && !hero.folded), put: Math.round(((p.total || 0) / (h.bigBlind || 1)) * 10) / 10 },
        // Hero's first river action was a check (a river bet in `actions` came after it: CHECK_BET_TILT's per-player read).
        hck: !!(hero && h.board.length >= 5 && hero.seq && hero.seq.river && hero.seq.river[0] === 'check'),
        // A showdown (someone else still in when the cards were turned up), not a show after everyone folded: the
        // per-player read of river bets after hero's check learns from showdowns only (CHECK_BET_TILT `sd`).
        sd: !p.folded && Object.values(h.players).some((x) => x.id !== p.id && !x.folded),
      };
      // How well the range we would have put them on matches what they showed.
      // Folded hands are kept (bets before the fold were bluffs) but not scored against a range.
      if (p.folded) show.folded = true;
      else if (this.scorer) { try { show.fit = this.scorer(show, this.readTally(p.auth)); } catch (e) { /* scoring is optional */ } }
      r.tally.shows.push(show);
      // Hand log: how well this read fit, and the player's running accuracy.
      if (show.fit) {
        p.fit = show.fit;
        p.accuracy = accuracySummary(this.readTally(p.auth));
        const lp = h.logEntry && h.logEntry.players.find((x) => x.name === p.name && !x.hero);
        if (lp) { lp.fit = p.fit; lp.accuracy = p.accuracy; }
      }
      if (r.tally.shows.length > MAX_SHOWS) r.tally.shows.splice(0, r.tally.shows.length - MAX_SHOWS);
      this.emit('save', this.db);
    }

    // A player's preflop line for the solver: like streetAction, but a re-raise once the pot already
    // had two raises is a '4bet', and three or more a '5bet'.
    // Whether hero's action kind matches the advice: any bet or raise for an aggressive advice, and a call for
    // "Call all-in" (an all-in advice that only matches the bet). A call against an all-in raise is not following.
    // Each hand's preflop from hands stored before v1.8.48 (tally.pfRecent, PF_RECENT's per-player read), oldest first,
    // with the current read's P(fold) and P(raise) for the position group the hand log kept (the read at the time isn't
    // stored; it moves little over the newest 60 hands). Needs the predictor. Meant to run once, before any hand of this
    // version. Returns how many were added.
    tagPfRecent(entries) {
      if (!this.predictor) return 0;
      const seen = this.db.seen || {};
      const idFor = (name, t, raw) => {
        for (const r of raw || []) for (const x of (r && r.s) || []) if (x && x[1] === name && x[5] && this.db.players[x[5]]) return x[5];
        const ids = Object.keys(this.db.players).filter((id) => (seen[id] && seen[id].names && seen[id].names[name] != null) || this.db.players[id].name === name);
        if (ids.length === 1) return ids[0];
        const at = ids.filter((id) => seen[id] && seen[id].first <= t + 6e5 && seen[id].last >= t - 6e5);
        return at.length === 1 ? at[0] : null;
      };
      const RANK = { call: 1, raise: 2, '3bet': 2 };
      const list = (entries || []).filter((e) => e && Array.isArray(e.players)).sort((a, b) => (a.t || 0) - (b.t || 0));
      const reads = {};
      let n = 0;
      for (const e of list) {
        for (const p of e.players) {
          if (!p || p.hero) continue;
          const id = idFor(p.name, e.t || 0, e.raw);
          const r = id && this.db.players[id];
          if (!r) continue;
          let top = 0;
          for (const k of (p.actions && p.actions.pre) || []) top = Math.max(top, RANK[k] || 0);
          const out = top === 2 ? 'raise' : top === 1 ? 'call' : 'fold';
          const d = { kind: 'pf', out, pos: p.position || null };
          try {
            const key = (this.canon ? this.canon(id) : id) + '|' + d.pos;
            const rd = reads[key] || (reads[key] = this.predictor(this.readTally(id) || r.tally || blankTally(), d)[0]);
            PatioTracker.addPfRecent(r.tally || (r.tally = blankTally()), rd, out, e.t || 0);
            n++;
          } catch (err) { /* optional */ }
        }
      }
      return n;
    }

    static followedAdvice(adv, kind) {
      const group = (k) => (k === 'bet' || k === 'raise' || k === '3bet' || k === 'allin' ? 'aggr' : k);
      if (adv.kind === 'allin' && kind === 'call') return !(adv.amount > (adv.toCall || 0) + 1e-9);
      return group(adv.kind) === group(kind);
    }

    // A chance to open the betting after the flop (tally.betRecent, BET_RECENT): the read's probabilities `rd`
    // ({ check, bet }), whether they bet, and when.
    // A hand's preflop (tally.pfRecent, PF_RECENT): the read's probabilities `rd` ({ fold, call, raise }), what they did
    // ('fold', 'call' or 'raise'), and when.
    static addPfRecent(t, rd, out, time) {
      const f = Math.max(0, rd.fold || 0), c = Math.max(0, rd.call || 0), r = Math.max(0, rd.raise || 0), s = f + c + r;
      if (!(s > 0)) return;
      if (!t.pfRecent) t.pfRecent = [];
      const R = (x) => Math.round((x / s) * 10000) / 10000;
      t.pfRecent.push({ f: R(f), r: R(r), y: out === 'raise' ? 2 : out === 'call' ? 1 : 0, t: time || 0 });
      if (t.pfRecent.length > MAX_PF_RECENT) t.pfRecent.splice(0, t.pfRecent.length - MAX_PF_RECENT);
    }

    static addBetRecent(t, rd, bet, time) {
      const s = Math.max(0, rd.check || 0) + Math.max(0, rd.bet || 0);
      if (!(s > 0)) return;
      if (!t.betRecent) t.betRecent = [];
      t.betRecent.push({ p: Math.round((Math.max(0, rd.bet || 0) / s) * 10000) / 10000, y: bet ? 1 : 0, t: time || 0 });
      if (t.betRecent.length > MAX_BET_RECENT) t.betRecent.splice(0, t.betRecent.length - MAX_BET_RECENT);
    }

    // An answer to a raise after the flop (tally.vsRaise): `log` is the hand's actions before it, `me` the answer (both in
    // the hand log's form). Null unless the street had a bet and a raise before it. Role: 'b' their last action on the
    // street was the bet, 'x' a raise (facing a re-raise), 'c' a call, 'k' a check, 'u' none yet. f, ag and rr are filled
    // in by the caller.
    static vsRaiseEntry(log, me) {
      if (!me || !me.st || me.st === 'pre' || (me.act !== 'fold' && me.act !== 'call' && me.act !== 'raise')) return null;
      let nb = 0, last = null;
      const mine = [];
      for (const x of log) {
        if (!x || x.st !== me.st) continue;
        if (x.act === 'bet' || x.act === 'raise') { nb++; last = x; }
        if (x.who === me.who) mine.push(x);
      }
      if (nb < 2) return null;
      const lastMine = mine.filter((x) => x.act !== 'sb' && x.act !== 'bb').pop();
      const role = !lastMine ? 'u' : lastMine.act === 'bet' ? 'b' : lastMine.act === 'raise' ? 'x' : lastMine.act === 'call' ? 'c' : 'k';
      return { y: me.act === 'fold' ? 'f' : me.act === 'call' ? 'c' : 'r', f: 0, n: { flop: 3, turn: 4, river: 5 }[me.st], role, ck: mine.length && mine[0].act === 'check' ? 1 : 0, ag: 0, rr: 0, h: last.hero ? 1 : 0 };
    }

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
      // Raised, then called a re-raise: like betcall, their range is the part of the raising range that continues.
      // Two or more bets and raises on the street (bet then re-raise a raise: 'betraise'; raise, then raise again:
      // 'reraise'; v1.8.10) are read as two aggressive actions, not as one raise.
      if (seq.includes('raise')) {
        const called = seq.slice(seq.lastIndexOf('raise') + 1).includes('call') ? 'call' : '';
        if (seq.filter((a) => a === 'bet' || a === 'raise').length >= 2) return (first === 'bet' ? 'betraise' : 'reraise') + called;
        return (first === 'check' ? 'checkraise' : 'raise') + called;
      }
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
      if (hero.allin) return { error: 'You are all-in. Nothing to decide this hand.' };
      if (h.desync) {
        const x = h.desync;
        return { error: `Lost track of the chips this hand (${x.who}: ${x.tracked} counted, ${x.table} at the table). Advice is back next hand.` };
      }
      const heroCards = h.heroUids.map((u) => h.heroCards[u]).filter(Boolean);
      if (heroCards.length < 2) return { error: 'Waiting to see your cards.' };
      // The board has to match the street the table is on: a missed card or street start would
      // put the wrong cards (or last street's bets) into the advice.
      if (![0, 3, 4, 5].includes(h.board.length) || h.board.length !== h.street) return { error: 'Waiting for the board.' };

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
      // Players before hero in postflop order act first, so hero is in position against them.
      const actsBefore = new Set(afterDealer.slice(0, hi).map((p) => p.id));
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
        if (street > 0 && a.pre === 'pending' && !o.blindAllin) a.pre = 'call';
        return a;
      };
      const opponents = opps.map((o) => {
        this.record(o.auth, o.name);
        const actions = { pre: PatioTracker.preAction(o) };
        for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) {
          if (street >= n) actions[k] = PatioTracker.streetAction(o.seq[k], n);
        }
        // A player all-in from posting a blind made no preflop choice: 'pending' reads as any two cards.
        if (street > 0 && actions.pre === 'pending' && !o.blindAllin) actions.pre = 'call';
        const cbetter = h.pfRaiser === o.id;
        return { name: o.name, tally: Object.assign(blankTally(), this.readTally(o.auth) || {}), actions, sizes: Object.assign({}, o.sizes), pfAggressor: cbetter, position: this.posGroup(o.id),
          // For side pots: chips already in the pot this hand, and chips behind.
          committed: o.total, stack: snapOf(o.id) ? snapOf(o.id).stack : null,
          // Chips in on this street (blinds count), so the engine knows what each still owes.
          bet: o.stageBet, heroIP: actsBefore.has(o.id) };
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
          heroCommitted: hero.total, heroBet: hero.stageBet,
          // Every action so far and the effective stack at the start of the hand (blueprint lookup).
          history: h.log.map((e) => ({ st: e.st, who: e.who, hero: !!e.hero, act: e.act, amt: e.amt, to: e.to, pot: e.pot, facing: e.facing, allin: !!e.allin })),
          seats: afterDealer.map((p) => p.name), heroName: hero.name,
          startStack: heroStack != null ? Math.min(heroStack + hero.total, Math.max(...opps.map((o) => { const s = snapOf(o.id); return s ? s.stack + o.total : 0; }))) : null,
          // Every known opponent's counts added up, for the engine's table prior.
          pool: this.poolTally(),
          heroPotShows: this.heroPotShows(),
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
  // Hand-log entries replayed in order through tracker `t`, each on its own recorded clock (it ended at e.t), so think
  // times come out as played. idOf(e, name, accountId) gives a seat's account id; o.heroAuth hero's when the hand doesn't
  // say; o.yieldEvery / o.onProgress keep a page usable.
  async function replayEntries(t, list, idOf, o) {
    let i = 0;
    for (const e of list) {
      const heroP = (e.players || []).find((p) => p.hero);
      const heroName = heroP ? heroP.name : null;
      let snap = null;
      const last = e.raw[e.raw.length - 1];
      const base = (e.t || 0) - ((last && last.t) || 0);
      let cur = base;
      t.clock = () => cur;
      for (const r of e.raw) {
        cur = base + (r.t || 0);
        if (r.s) {
          const players = r.s.map(([id, name, stack, posType, playState, auth]) => ({ id, name, stack, posType, playState, authUserId: idOf(e, name, auth) }));
          const me = heroName && players.find((x) => x.name === heroName);
          snap = { tableType: 'private', heroAuthId: me ? me.authUserId : o.heroAuth || null, bigBlind: r.bb || (snap && snap.bigBlind) || e.bigBlind, players };
        }
        try { t.handle(r.ev, r.d, r.s ? snap : null); } catch (err) { /* a broken event skips itself */ }
      }
      if (t.hand && !t.hand.finished) t.finishHand();
      if (o.yieldEvery && ++i % o.yieldEvery === 0) {
        if (o.onProgress) o.onProgress(i, list.length);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
  }

  // Hands left out of the reads (db.leftOut: [{ from, to }], hand start times, both ends in) or flagged `excluded`.
  function leftOutTest(ranges) {
    const rs = (ranges || []).filter((r) => r && r.from != null && r.to != null);
    return (e) => !!(e && (e.excluded || rs.some((r) => e.t >= r.from && e.t <= r.to)));
  }

  // Hands left out of the reads, or put back (v1.8.47, "Leave out" on the panel's sessions; Marwin, 24 Nov: friends who
  // played a session for fun). The reads now are the stored hands minus those `was` leaves out; they come back as the
  // stored hands minus those `isOut` leaves out, as if the hands left out had never been played. Every id dealt into a
  // hand from the first one that differs on goes back to where it stood before it, and the hands from there that stay
  // in are replayed. Every count shrinks by the same factor each hand (DECAY) and what a hand adds to it depends only on
  // its events, so a count then = (count now - what those hands added, replayed from zero) / the shrink they applied,
  // exactly. Lists (shows, jamShows, mwFolds, vsRaise, betRecent, pfRecent; newest kept) lose the entries those hands added at
  // their end, and get back the older ones they pushed out of a full list from the stored hands before. The read's own
  // accuracy (pred.read / pred.pop) is what the read predicted at the time, so it is matched by replaying the same hands
  // from the state then with the reads as they were, until the replay ends where the reads are now.
  // A link made during those hands counts as made before them (each of the player's ids shrinks once a hand there).
  // entries: stored hands (with raw events). opts: setup, known, heroAuth, yieldEvery, onProgress (as rebuildReads),
  // was (default: nothing left out yet).
  // -> null if no stored hand changes side, else { db: { players }, ids (reads changed), removed (ids with no hand
  //    left), out / back (hands left out / put back), redone (hands replayed after), regained (list entries found
  //    again), check (largest gap, over every count, between the replay from the state then and the reads now: about 0
  //    when the stored hands are the ones the reads saw) }
  async function dropHands(db, entries, isOut, opts) {
    const o = opts || {};
    const was = o.was || (() => false);
    const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
    const LISTS = ['shows', 'jamShows', 'mwFolds', 'vsRaise', 'betRecent', 'pfRecent'];
    const list = (entries || []).filter((e) => e && Array.isArray(e.raw) && e.raw.length).sort((a, b) => (a.t || 0) - (b.t || 0));
    const i0 = list.findIndex((e) => !was(e) !== !isOut(e));
    if (i0 < 0) return null;
    const tail = list.slice(i0);
    const inNow = tail.filter((e) => !was(e)), inAfter = tail.filter((e) => !isOut(e));
    const known = o.known || {};
    const idOf = (e, name, given) => given || known[name] || 'name:' + name;
    const make = (players, scored) => {
      const t = new PatioTracker({ players, same: copy(db.same), notSame: copy(db.notSame), seen: copy(db.seen) });
      t.rawKeep = 0; t.linkReads = false; t.rescoreLimit = 0;
      if (scored && o.setup) o.setup(t);
      // From zero: a flat predictor, so the lists that keep the read's chances (betRecent) get their entries.
      else if (!scored) { const one = { fold: 1, call: 1, raise: 1, check: 1, bet: 1 }; t.predictor = () => [one, one]; }
      return t;
    };
    const zeroed = (t) => {
      const z = {};
      for (const k of Object.keys(t)) {
        const v = t[k];
        z[k] = LISTS.includes(k) ? [] : typeof v === 'number' ? 0 : v && typeof v === 'object' && !Array.isArray(v) ? zeroed(v) : copy(v);
      }
      return z;
    };
    // What the hands in the reads now added from the first one that changes side, replayed from zero; `_k` the shrink.
    const now = {}, zp = {};
    for (const [id, r] of Object.entries(db.players || {})) {
      if (!r) continue;
      now[id] = upgradeTally(copy(r.tally || {}));
      zp[id] = { name: r.name, tally: Object.assign(zeroed(now[id]), { _k: 1 }) };
    }
    const tz = make(zp, false);
    await replayEntries(tz, inNow, idOf, o);
    const hasAny = (t) => (t.pfFold || 0) + (t.pfCall || 0) + (t.pfRaise || 0) > 1e-9 || LISTS.some((k) => (t[k] || []).length);
    const ids = Object.keys(now).filter((id) => tz.db.players[id] && (tz.db.players[id].tally._k < 1 || hasAny(tz.db.players[id].tally)));
    const fac = {}, then = {};
    const sub = (c, a, f) => {
      const out = {};
      for (const k of Object.keys(c)) {
        const v = c[k], w = a ? a[k] : undefined;
        if (LISTS.includes(k)) out[k] = (v || []).slice(0, Math.max(0, (v || []).length - ((w && w.length) || 0)));
        else if (typeof v === 'number') out[k] = Math.max(0, (v - (typeof w === 'number' ? w : 0)) / f);
        else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = sub(v, w, f);
        else out[k] = copy(v);
      }
      return out;
    };
    for (const id of ids) {
      fac[id] = tz.db.players[id].tally._k;
      then[id] = sub(now[id], tz.db.players[id].tally, fac[id]);
    }
    const base = () => {
      const p = copy(db.players);
      for (const id of ids) p[id] = Object.assign({}, p[id], { tally: copy(then[id]) });
      return p;
    };
    // Entries those hands pushed out of a full list are found again in the hands before (up to 400 of them), replayed
    // with the reads then: a regained entry's read-dependent part (a show's fit, a betting chance's P(bet)) is as the
    // reads then see it, not as it was when first kept.
    const MAXL = { shows: MAX_SHOWS, jamShows: MAX_JAM_SHOWS, mwFolds: MAX_MW_FOLDS, vsRaise: MAX_VS_RAISE, betRecent: MAX_BET_RECENT, pfRecent: MAX_PF_RECENT };
    const short = [];
    for (const id of ids) for (const k of LISTS) if (((tz.db.players[id].tally[k] || []).length) && (now[id][k] || []).length >= MAXL[k]) short.push([id, k]);
    let regained = 0;
    if (short.length && i0 > 0) {
      const hp = base();
      for (const [id, k] of short) hp[id].tally[k] = [];
      const th = make(hp, true);
      await replayEntries(th, list.slice(Math.max(0, i0 - 400), i0), idOf, o);
      for (const [id, k] of short) {
        const got = (th.db.players[id] && th.db.players[id].tally[k]) || [], have = then[id][k];
        const n = Math.min(MAXL[k] - have.length, got.length - have.length);
        if (n > 0) { then[id][k] = got.slice(got.length - have.length - n, got.length - have.length).concat(have); regained += n; }
      }
    }
    // The read's accuracy (counted only with a predictor, so the replay from zero has none of it): replay from the state
    // then with the scorer and predictor, until it ends where the reads are.
    const gap = (g, w, top) => {
      let m = 0;
      for (const k of Object.keys(w)) {
        if (LISTS.includes(k) || (top && k === 'pred')) continue;
        const a = g ? g[k] : undefined, b = w[k];
        if (typeof b === 'number') m = Math.max(m, Math.abs((typeof a === 'number' ? a : 0) - b) / Math.max(1, Math.abs(b)));
        else if (b && typeof b === 'object' && !Array.isArray(b)) m = Math.max(m, gap(a, b, false));
      }
      return m;
    };
    let check = 0;
    for (let it = 0; it < 5 && ids.length; it++) {
      const tr = make(base(), true);
      await replayEntries(tr, inNow, idOf, o);
      let move = 0;
      check = 0;
      for (const id of ids) {
        const got = tr.db.players[id].tally, want = now[id], pr = then[id].pred;
        check = Math.max(check, gap(got, want, true));
        for (const k of ['n', 'read', 'pop']) {
          const d = (want.pred[k] - got.pred[k]) / fac[id];
          pr[k] = Math.max(0, pr[k] + d);
          move = Math.max(move, Math.abs(d));
        }
      }
      if (move < 1e-8) break;
    }
    // From the state then, the hands that stay in.
    let final = base();
    if (inAfter.length) {
      const tk = make(final, true);
      await replayEntries(tk, inAfter, idOf, o);
      final = tk.db.players;
    }
    const players = Object.assign({}, db.players);
    const linked = new Set();
    for (const [k, v] of Object.entries(db.same || {})) { linked.add(k); linked.add(v); }
    const removed = [];
    // Players the reads had none of (every hand of theirs was left out) come back from the replay.
    for (const id of Object.keys(final)) if (!db.players[id] && !ids.includes(id)) ids.push(id);
    for (const id of ids) {
      const r = final[id];
      if (!r || (!hasAny(r.tally) && !linked.has(id))) { delete players[id]; removed.push(id); continue; }
      delete r.tally._k;
      players[id] = Object.assign({}, r, { name: (db.players[id] && db.players[id].name) || r.name });
    }
    return {
      db: { players }, ids, removed, check, regained,
      out: tail.filter((e) => isOut(e) && !was(e)).length, back: tail.filter((e) => was(e) && !isOut(e)).length,
      redone: inAfter.filter((e) => !isOut(e) && !was(e)).length,
    };
  }

  // Reads rebuilt from hand-log entries (an export, or the stored log plus an import): every hand
  // with raw events is replayed, oldest first, through a fresh tracker, exactly as at the table.
  // Raw snapshots from v1.8.1 on carry each player's account id; older ones only names, so a name
  // maps to the id its chat lines carried that day, else to the id `known` gives it (the reads
  // the page already has), else to "name:<name>". `setup(tracker)` sets the scorer, predictor and
  // fit version like the overlay's. Async: it yields every `yieldEvery` hands so a page stays usable.
  // `same`/`notSame`/`linkLog`: the page's linked reads, kept (and added to) in the rebuild.
  // -> { db: { players, same, notSame, seen, linkLog }, replayed, skipped (no raw events) }
  async function rebuildReads(entries, opts) {
    const o = opts || {};
    const day = (e) => new Date(e.t || 0).toISOString().slice(0, 10);
    const votes = {};
    for (const e of entries) for (const r of e.raw || []) {
      if (r.ev === 'chat_message' && r.d && r.d.username && r.d.userId && r.d.userId !== -1) {
        const k = day(e) + '|' + r.d.username;
        const v = votes[k] || (votes[k] = {});
        v[r.d.userId] = (v[r.d.userId] || 0) + 1;
      }
    }
    const voted = (e, name) => {
      const v = votes[day(e) + '|' + name];
      return v ? Object.entries(v).sort((a, b) => b[1] - a[1])[0][0] : null;
    };
    const known = o.known || {};
    const idOf = (e, name, given) => given || voted(e, name) || known[name] || 'name:' + name;
    // Links and "not the same player" answers carry into the rebuild (new ones are made on the way).
    const copy = (x) => (x ? JSON.parse(JSON.stringify(x)) : undefined);
    const t = new PatioTracker({ players: {}, same: copy(o.same), notSame: copy(o.notSame), linkLog: copy(o.linkLog) });
    t.rawKeep = 0;
    if (o.setup) o.setup(t);
    // Hands left out of the reads on the panel (db.leftOut, v1.8.47) stay out of a rebuild too.
    const out = leftOutTest(o.leftOut);
    const all = entries.filter((e) => e && Array.isArray(e.raw) && e.raw.length);
    const list = all.filter((e) => !out(e)).sort((a, b) => (a.t || 0) - (b.t || 0));
    await replayEntries(t, list, idOf, o);
    const db = { players: t.db.players };
    for (const k of ['same', 'notSame', 'seen', 'linkLog']) if (t.db[k]) db[k] = t.db[k];
    return { db, replayed: list.length, skipped: entries.length - all.length, leftOut: all.length - list.length };
  }
  PatioTracker.rebuildReads = rebuildReads;
  PatioTracker.dropHands = dropHands;
  PatioTracker.leftOutTest = leftOutTest;
  PatioTracker.predSummary = predSummary;
  PatioTracker.blankTally = blankTally;
  PatioTracker.DECAY = DECAY;
  PatioTracker.WHO = WHO;
  PatioTracker.MAX_HISTORY = MAX_HISTORY;
  PatioTracker.RAW_KEEP = RAW_KEEP;
  PatioTracker.accuracySummary = accuracySummary;
  PatioTracker.upgradeTally = upgradeTally;
  PatioTracker.mergeTallies = mergeTallies;
  PatioTracker.cardStr = cardStr;
  if (typeof module !== 'undefined' && module.exports) module.exports = PatioTracker;
  else global.PatioTracker = PatioTracker;
})(typeof window !== 'undefined' ? window : globalThis);
