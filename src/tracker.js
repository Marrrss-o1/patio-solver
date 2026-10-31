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
  function decayTally(t) {
    for (const k of Object.keys(t)) {
      if (k === 'shows') continue;
      if (typeof t[k] === 'number') t[k] *= DECAY;
      else if (t[k] && typeof t[k] === 'object') decayTally(t[k]);
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
      // Reaction to a bet by its size (fraction of the pot before the bet): <45%, 45-85%, >85%.
      vs: { small: facingTally(), medium: facingTally(), large: facingTally() },
      // Their own bet sizes postflop, as fractions of the pot.
      betSize: { n: 0, sum: 0 },
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
    for (const k of Object.keys(b)) {
      if (t[k] == null) t[k] = b[k];
      else if (k === 'st' || k === 'vs' || k === 'pos' || k === 'tt') for (const j of Object.keys(b[k])) if (!t[k][j]) t[k][j] = b[k][j];
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
        if (known && known.tally) decayTally(upgradeTally(known.tally));
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
          if (h && !h.finished) this.emit('turn', { playerID: data.playerID, isHero: data.playerID === this.heroId() });
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
      if (r) this.extraStats(p, r.tally, kind, facing, key);
      if (street === 0) {
        if (r && !p.faced3 && h.preRaises === 1 && kind !== 'check') {
          p.faced3 = true;
          r.tally.pf3betOpp++;
          if (kind === '3bet') r.tally.pf3bet++;
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
          r.tally[p.pfCat || 'pfFold']++;
          const g = this.posGroup(p.id);
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
        if (fmt && r.ranked) a.options = r.ranked.slice(0, 5).map((sc) => ({ a: fmt(sc), ev: r2(sc.ev || 0) }));
        if (r.opponents) a.reads = r.opponents.map((o) => ({
          name: o.name, type: o.type && o.type.label, hands: Math.round(o.stats.hands || 0),
          bluff: o.bluffChance != null ? r2(o.bluffChance) : undefined,
          trust: o.stats.exploitWeight != null ? r2(o.stats.exploitWeight) : undefined,
          accuracy: o.stats.accuracy ? { n: o.stats.accuracy.n, hits: o.stats.accuracy.hits, vsGuess: r2(o.stats.accuracy.vsGuess) } : undefined,
          strengthBias: o.stats.strengthBias ? r2(o.stats.strengthBias) : undefined,
          callBig: o.stats.callBig != null ? r2(o.stats.callBig) : undefined,
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
      if (seq.includes('bet')) return 'bet';
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
          iterations: opponents.length > 2 ? 16000 : 24000,
          // Fresh seed each decision, so close spots get mixed rather than always the same advice.
          seed: (Math.random() * 4294967296) >>> 0,
        },
        heroStageBet: hero.stageBet,
        heroCards, board: h.board.slice(),
      };
    }
  }

  PatioTracker.blankTally = blankTally;
  PatioTracker.DECAY = DECAY;
  PatioTracker.accuracySummary = accuracySummary;
  PatioTracker.upgradeTally = upgradeTally;
  PatioTracker.cardStr = cardStr;
  if (typeof module !== 'undefined' && module.exports) module.exports = PatioTracker;
  else global.PatioTracker = PatioTracker;
})(typeof window !== 'undefined' ? window : globalThis);
