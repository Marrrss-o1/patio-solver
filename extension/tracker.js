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
  const MAX_SHOWS = 40;
  const MAX_HISTORY = 150;
  // Each hand a player is dealt into shrinks their older counts by 1%, so the last
  // hundred or so hands carry most of the weight and reads follow players who change.
  const DECAY = 0.99;
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
      else if (k === 'st' || k === 'vs' || k === 'pos') for (const j of Object.keys(b[k])) if (!t[k][j]) t[k][j] = b[k][j];
    }
    return t;
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
          agg: [], sizes: {}, shown: [],
        };
      }
      this.hand = {
        players, street: 0, started: false, board: [], heroUids: [], heroCards: {}, uidPos: {},
        pfRaiser: null, flopBet: false,
        currentBet: 0, preRaises: 0, dealerPos: null, bigBlind: s.bigBlind || null,
        finished: false,
      };
      this.emit('hand', this.hand);
    }

    handle(ev, data, snap) {
      if (snap) this.snap = snap;
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
          if (p) { p.stageBet += data.amount; p.total += data.amount; }
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

      const isHero = p.id === this.heroId();
      const r = isHero ? null : this.record(p.auth, p.name);
      if (street === 0) {
        if (r && !p.faced3 && h.preRaises === 1 && kind !== 'check') {
          p.faced3 = true;
          r.tally.pf3betOpp++;
          if (kind === '3bet') r.tally.pf3bet++;
        }
        if (kind === 'raise' || kind === '3bet') { h.preRaises++; h.pfRaiser = p.id; }
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
        players: Object.values(h.players).map((p) => ({
          name: p.name, hero: p.id === heroId, position: this.posGroup(p.id), folded: p.folded,
          put: p.total, actions: p.seq, shown: p.shown,
        })),
      };
      h.logEntry = entry;
      const list = this.db.history || (this.db.history = []);
      list.push(entry);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    }

    // The overlay reports each piece of advice so the hand log can show it.
    noteAdvice(text, ev) {
      const h = this.hand;
      if (!h || h.finished) return;
      (h.advice || (h.advice = [])).push({ street: h.board.length, text, ev: Math.round(ev * 100) / 100 });
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
      const actions = { pre: PatioTracker.streetAction(p.seq.pre, 0) };
      for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (h.board.length >= n) actions[k] = PatioTracker.streetAction(p.seq[k], n);
      if (actions.pre === 'pending') actions.pre = 'call';
      const show = {
        cards: p.shown.slice(), board: h.board.slice(), agg: p.agg.slice(),
        actions, sizes: Object.assign({}, p.sizes), pfAggressor: h.pfRaiser === p.id, position: this.posGroup(p.id),
      };
      // How well the range we would have put them on matches what they showed.
      if (this.scorer) { try { show.fit = this.scorer(show, r.tally); } catch (e) { /* scoring is optional */ } }
      r.tally.shows.push(show);
      if (r.tally.shows.length > MAX_SHOWS) r.tally.shows.splice(0, r.tally.shows.length - MAX_SHOWS);
      this.emit('save', this.db);
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
        const a = { pre: PatioTracker.streetAction(o.seq.pre, 0) };
        for (const [k, n] of [['flop', 3], ['turn', 4], ['river', 5]]) if (street >= n) a[k] = PatioTracker.streetAction(o.seq[k], n);
        if (street > 0 && a.pre === 'pending') a.pre = 'call';
        return a;
      };
      const opponents = opps.map((o) => {
        const r = this.record(o.auth, o.name);
        const actions = { pre: PatioTracker.streetAction(o.seq.pre, 0) };
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
  PatioTracker.upgradeTally = upgradeTally;
  PatioTracker.cardStr = cardStr;
  if (typeof module !== 'undefined' && module.exports) module.exports = PatioTracker;
  else global.PatioTracker = PatioTracker;
})(typeof window !== 'undefined' ? window : globalThis);
