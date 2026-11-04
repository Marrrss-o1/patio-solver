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
  const MAX_HISTORY = 150;
  // Raw events: kept for the newest RAW_KEEP hands only (about 17 KB a hand in Marwin's logs).
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
  // Linked reads: one friend's counts kept under more than one account id, added up.
  function addCounts(out, t) {
    for (const k of Object.keys(t || {})) {
      if (k === 'shows') continue;
      const v = t[k];
      if (typeof v === 'number') out[k] = (out[k] || 0) + v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) addCounts(out[k] || (out[k] = {}), v);
    }
    return out;
  }
  // Tallies oldest id first (the order its shows are kept in); the newest MAX_SHOWS shows kept.
  function mergeTallies(list) {
    const out = blankTally();
    for (const t of list) addCounts(out, t);
    const shows = [];
    for (const t of list) for (const sh of t.shows || []) shows.push(sh);
    out.shows = shows.slice(-MAX_SHOWS);
    return out;
  }
  const normName = (s) => String(s == null ? '' : s).trim().toLowerCase();
  // Names a site could hand out to many people (none seen at Marwin's tables yet): never matched.
  const GENERIC_NAME = /^(guest|player|user|anonymous|anon)[\s_#-]*\d*$/;
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

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
      return mergeTallies(ids.map((k) => upgradeTally(this.db.players[k].tally)));
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
        case 'game:player_turn_ended':
          if (h && data.playerID === this.heroId()) this.emit('heroDone', null);
          break;
        case 'game:game_ended':
        case 'admin:game:game_stopped':
          this.finishHand();
          if (ev === 'game:game_ended' && h) this.settleFromPayout(h, data);
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
        if (d) this.scorePrediction(r.tally, Object.assign(d, { pos: this.posGroup(p.id) }), this.readTally(p.auth));
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
          // Raise-to and chips left behind, in big blinds (v1.8.15): huge raises that keep chips behind read tight.
          if (bb > 0) {
            p.sizes.preTo = Math.round((p.stageBet / bb) * 100) / 100;
            p.sizes.preBehind = Math.round((Math.max(0, p.start - p.total) / bb) * 100) / 100;
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
          this.scorePrediction(r.tally, { kind: 'pf', out: { pfFold: 'fold', pfCall: 'call', pfRaise: 'raise' }[p.pfCat || 'pfFold'], pos: g }, this.readTally(p.auth));
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
    scorePrediction(t, d, read) {
      if (!this.predictor || !t.pred) return;
      try {
        const [rd, pop] = this.predictor(read || t, d);
        const pr = (x) => { let s = 0; for (const v of Object.values(x)) s += Math.max(0, v); return Math.max(1e-3, (x[d.out] || 0) / (s || 1)); };
        t.pred.n++;
        t.pred.read += -Math.log(pr(rd));
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
      if (!prev || !prev.logEntry || prev.logEntry.net) return;
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
      if (h.board.length < 3) return;
      const r = this.record(p.auth, p.name);
      if (!r) return;
      const actions = { pre: PatioTracker.preAction(p) };
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = PatioTracker.streetAction(p.seq[k], n);
      if (actions.pre === 'pending' && !p.blindAllin) actions.pre = 'call';
      const hero = Object.values(h.players).find((x) => x.id === this.heroId());
      const show = {
        cards: p.shown.slice(), board: h.board.slice(), agg: p.agg.slice(),
        actions, sizes: Object.assign({}, p.sizes), ms: p.ms.slice(), pfAggressor: h.pfRaiser === p.id, position: this.posGroup(p.id),
        // Whether hero was still in the pot, and the big blinds this player put in (heroPotShows).
        hp: { in: !!(hero && !hero.folded), put: Math.round(((p.total || 0) / (h.bigBlind || 1)) * 10) / 10 },
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
    static followedAdvice(adv, kind) {
      const group = (k) => (k === 'bet' || k === 'raise' || k === '3bet' || k === 'allin' ? 'aggr' : k);
      if (adv.kind === 'allin' && kind === 'call') return !(adv.amount > (adv.toCall || 0) + 1e-9);
      return group(adv.kind) === group(kind);
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
    const list = entries.filter((e) => e && Array.isArray(e.raw) && e.raw.length).sort((a, b) => (a.t || 0) - (b.t || 0));
    let i = 0;
    for (const e of list) {
      const heroP = (e.players || []).find((p) => p.hero);
      const heroName = heroP ? heroP.name : null;
      let snap = null;
      // Replay on the hand's own clock (it ended at e.t), so think times come out as they were played.
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
    const db = { players: t.db.players };
    for (const k of ['same', 'notSame', 'seen', 'linkLog']) if (t.db[k]) db[k] = t.db[k];
    return { db, replayed: list.length, skipped: entries.length - list.length };
  }
  PatioTracker.rebuildReads = rebuildReads;
  PatioTracker.predSummary = predSummary;
  PatioTracker.blankTally = blankTally;
  PatioTracker.DECAY = DECAY;
  PatioTracker.MAX_HISTORY = MAX_HISTORY;
  PatioTracker.RAW_KEEP = RAW_KEEP;
  PatioTracker.accuracySummary = accuracySummary;
  PatioTracker.upgradeTally = upgradeTally;
  PatioTracker.mergeTallies = mergeTallies;
  PatioTracker.cardStr = cardStr;
  if (typeof module !== 'undefined' && module.exports) module.exports = PatioTracker;
  else global.PatioTracker = PatioTracker;
})(typeof window !== 'undefined' ? window : globalThis);
