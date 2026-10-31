/*
 * Blueprint strategy: a heads-up 100bb strategy trained offline by self-play
 * (blueprint/trainer.c: external-sampling MCCFR with Linear CFR and negative-regret pruning).
 *
 * This file reads the trainer's export, rebuilds the same betting tree, puts hero's hand in
 * the same card bucket the trainer used, follows the hand's real actions down the tree
 * (mapping off-tree bet sizes to the nearest sizes in the tree with pseudo-harmonic mapping),
 * and returns the blueprint's action frequencies for hero's decision. engine.js then uses
 * them as the base strategy that the opponent reads adjust.
 *
 * Everything here must match blueprint/trainer.c: combo order, hand evaluator (engine.js),
 * percentiles, canonical flops, bucket edges and the tree rules.
 */
(function (global) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : global.PokerEngine;
  const NUM_COMBOS = 1326;

  // ---- combos (same order as engine.js and the trainer) ----
  const COMBO_HI = new Uint8Array(NUM_COMBOS), COMBO_LO = new Uint8Array(NUM_COMBOS), COMBO_CLASS = new Uint8Array(NUM_COMBOS);
  const COMBO_INDEX = new Int16Array(52 * 52).fill(-1);
  {
    let k = 0;
    for (let a = 51; a >= 1; a--) {
      for (let b = a - 1; b >= 0; b--) {
        COMBO_HI[k] = a; COMBO_LO[k] = b;
        COMBO_INDEX[a * 52 + b] = k; COMBO_INDEX[b * 52 + a] = k;
        const ra = a >> 2, rb = b >> 2;
        let row, col;
        if (ra === rb) { row = col = 12 - ra; } else if ((a & 3) === (b & 3)) { row = 12 - ra; col = 12 - rb; } else { row = 12 - rb; col = 12 - ra; }
        COMBO_CLASS[k] = row * 13 + col;
        k++;
      }
    }
  }
  const PERMS = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) {
    if (a === b || a === c || a === d || b === c || b === d || c === d) continue;
    PERMS.push([a, b, c, d]);
  }

  function canonKey(cards) {
    let best = -1, bp = 0;
    const m = new Array(cards.length);
    for (let p = 0; p < 24; p++) {
      for (let i = 0; i < cards.length; i++) m[i] = (cards[i] & ~3) | PERMS[p][cards[i] & 3];
      m.sort((x, y) => y - x);
      let key = 0;
      for (let i = 0; i < m.length; i++) key = key * 52 + m[i];
      if (best < 0 || key < best) { best = key; bp = p; }
    }
    return { key: best, perm: PERMS[bp] };
  }

  // ---- features (= trainer board_features) ----
  function percentiles(scores, valid, count, out, keys) {
    for (let i = 0; i < count; i++) keys[i] = scores[valid[i]] * 2048 + valid[i];
    const ks = keys.subarray(0, count);
    ks.sort();
    let i = 0;
    const denom = Math.max(1, count - 1);
    while (i < count) {
      const s = Math.floor(ks[i] / 2048);
      let j = i;
      while (j < count && Math.floor(ks[j] / 2048) === s) j++;
      const p = (i + (j - i - 1) / 2) / denom;
      for (let x = i; x < j; x++) out[ks[x] % 2048] = p;
      i = j;
    }
  }
  // hs: each combo's percentile on the board; ehs: its average river percentile over every
  // runout (both cards on the flop, the river card on the turn).
  function boardFeatures(board) {
    const n = board.length;
    const dead = new Uint8Array(52);
    for (const c of board) dead[c] = 1;
    const buf = new Int32Array(7);
    for (let i = 0; i < n; i++) buf[i] = board[i];
    const scores = new Int32Array(NUM_COMBOS), valid = new Int16Array(NUM_COMBOS), valid2 = new Int16Array(NUM_COMBOS);
    const keys = new Float64Array(NUM_COMBOS), tmp = new Float64Array(NUM_COMBOS);
    const hs = new Float64Array(NUM_COMBOS).fill(-1), ehs = new Float64Array(NUM_COMBOS).fill(-1);
    let count = 0;
    for (let k = 0; k < NUM_COMBOS; k++) {
      const a = COMBO_HI[k], b = COMBO_LO[k];
      if (dead[a] || dead[b]) continue;
      buf[n] = a; buf[n + 1] = b;
      scores[k] = E.evaluate(buf, n + 2);
      valid[count++] = k;
    }
    percentiles(scores, valid, count, hs, keys);
    if (n < 5) {
      const sum = new Float64Array(NUM_COMBOS), cnt = new Int32Array(NUM_COMBOS);
      for (let t = 0; t < 52; t++) {
        if (dead[t]) continue;
        const rFrom = n === 3 ? t + 1 : t, rTo = n === 3 ? 52 : t + 1;
        for (let r = rFrom; r < rTo; r++) {
          if (n === 3 && dead[r]) continue;
          buf[n] = t;
          if (n === 3) buf[n + 1] = r;
          let c2 = 0;
          for (let i = 0; i < count; i++) {
            const k = valid[i], a = COMBO_HI[k], b = COMBO_LO[k];
            if (a === t || b === t || (n === 3 && (a === r || b === r))) continue;
            buf[5] = a; buf[6] = b;
            scores[k] = E.evaluate(buf, 7);
            valid2[c2++] = k;
          }
          percentiles(scores, valid2, c2, tmp, keys);
          for (let i = 0; i < c2; i++) { const k = valid2[i]; sum[k] += tmp[k]; cnt[k]++; }
        }
      }
      for (let i = 0; i < count; i++) { const k = valid[i]; ehs[k] = cnt[k] ? sum[k] / cnt[k] : hs[k]; }
    } else {
      for (let i = 0; i < count; i++) ehs[valid[i]] = hs[valid[i]];
    }
    return { hs, ehs };
  }

  // ---- tree (= trainer build) ----
  function parseSizes(s) {
    return s.split('|').map((st) => st.split('/').map((lv) => (lv ? lv.split(',').map(Number) : [])));
  }
  // Seats: preflop order 0 .. n-1 (n-2 small blind, n-1 big blind; heads-up seat 0 is the
  // button / small blind). Postflop the blinds act first (heads-up: the big blind).
  function actionOrder(n) {
    const order = [Array.from({ length: n }, (_, i) => i)];
    for (let s = 1; s < 4; s++) order.push(n === 2 ? [1, 0] : [n - 2, n - 1].concat(Array.from({ length: n - 2 }, (_, i) => i)));
    return order;
  }
  function buildTree(cfg) {
    const N = cfg.players || 2, S = cfg.stack, sizes = parseSizes(cfg.sizes), ORDER = actionOrder(N);
    const exportStreets = cfg.exportStreets != null ? cfg.exportStreets : 4;
    const nodes = [], terms = [];
    let total = 0, xtotal = 0, xinfo = 0;
    function newTerm(st) { terms.push({ commit: st.commit.slice(), live: st.folded.map((f) => !f) }); return -terms.length; }
    function nextActor(st, from) {
      const ord = ORDER[st.street], idx = ord.indexOf(from);
      for (let k = 1; k <= N; k++) { const q = ord[(idx + k) % N]; if (!st.folded[q] && st.commit[q] < S && !st.acted[q]) return q; }
      return -1;
    }
    function build(st, p) {
      const id = nodes.length;
      let maxBet = 0, pot = 0;
      for (let i = 0; i < N; i++) { if (st.bet[i] > maxBet) maxBet = st.bet[i]; pot += st.commit[i]; }
      const facing = maxBet - st.bet[p], rem = S - st.commit[p];
      const kind = [], add = [];
      if (facing > 0) { kind.push('f'); add.push(0); kind.push('c'); add.push(Math.min(facing, rem)); } else { kind.push('k'); add.push(0); }
      let others = false;
      for (let i = 0; i < N; i++) if (i !== p && !st.folded[i] && st.commit[i] < S) others = true;
      const lv = sizes[st.street];
      if (rem > facing && others && st.raises < lv.length) {
        const potAfter = pot + facing;
        for (const f of lv[st.raises]) {
          let to = maxBet + Math.floor(f * potAfter + 0.5);
          const minInc = st.lastRaise > cfg.bb ? st.lastRaise : cfg.bb;
          if (to < maxBet + minInc) to = maxBet + minInc;
          const a = to - st.bet[p];
          if (a > cfg.allinFrac * rem) continue;
          if (kind.some((k, j) => k === 'r' && add[j] === a)) continue;
          kind.push('r'); add.push(a);
        }
        kind.push('a'); add.push(rem);
      }
      const exp = st.street < exportStreets;
      const nd = { id, player: p, street: st.street, nacts: kind.length, kind, add, child: new Array(kind.length),
        off: exp ? xtotal : -1, info: exp ? xinfo : -1, bet: st.bet.slice(), commit: st.commit.slice(), folded: st.folded.slice() };
      total += kind.length * cfg.nb[st.street];
      if (exp) { xtotal += kind.length * cfg.nb[st.street]; xinfo += cfg.nb[st.street]; }
      nodes.push(nd);
      for (let i = 0; i < kind.length; i++) {
        const k = kind[i], amt = add[i];
        const s2 = { street: st.street, bet: st.bet.slice(), commit: st.commit.slice(), folded: st.folded.slice(), acted: st.acted.slice(), raises: st.raises, lastRaise: st.lastRaise };
        if (k === 'f') s2.folded[p] = 1;
        else { s2.bet[p] += amt; s2.commit[p] += amt; }
        s2.acted[p] = 1;
        if (k === 'r' || k === 'a') {
          const inc = s2.bet[p] - maxBet;
          if (inc > s2.lastRaise) s2.lastRaise = inc;
          s2.raises++;
          for (let q = 0; q < N; q++) if (q !== p) s2.acted[q] = 0;
        }
        let live = 0;
        for (let q = 0; q < N; q++) if (!s2.folded[q]) live++;
        let ch;
        if (live === 1) ch = newTerm(s2);
        else {
          const nx = nextActor(s2, p);
          if (nx >= 0) ch = build(s2, nx);
          else {
            let canAct = 0;
            for (let q = 0; q < N; q++) if (!s2.folded[q] && s2.commit[q] < S) canAct++;
            if (st.street === 3 || canAct <= 1) ch = newTerm(s2);
            else {
              const s3 = { street: st.street + 1, bet: new Array(N).fill(0), commit: s2.commit.slice(), folded: s2.folded.slice(), acted: new Array(N).fill(0), raises: 0, lastRaise: 0 };
              ch = build(s3, nextActor(s3, ORDER[s3.street][N - 1]));
            }
          }
        }
        nd.child[i] = ch;
      }
      return id;
    }
    const bet = new Array(N).fill(0);
    bet[N - 2] = cfg.sb; bet[N - 1] = cfg.bb;
    build({ street: 0, bet, commit: bet.slice(), folded: new Array(N).fill(0), acted: new Array(N).fill(0), raises: 0, lastRaise: cfg.bb }, 0);
    // FNV-1a, as the trainer's tree_hash
    let h = 2166136261 >>> 0;
    const mix = (x) => { const v = x >>> 0; for (let b = 0; b < 4; b++) { h ^= (v >>> (8 * b)) & 255; h = Math.imul(h, 16777619) >>> 0; } };
    for (const nd of nodes) {
      mix(nd.player); mix(nd.street); mix(nd.nacts);
      for (let a = 0; a < nd.nacts; a++) { mix(nd.kind[a].charCodeAt(0)); mix(nd.add[a]); mix(nd.child[a]); }
    }
    return { nodes, terms, total, xtotal, infosets: xinfo, hash: h >>> 0, players: N };
  }

  // ---- loading ----
  function load(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0x50425350) throw new Error('not a blueprint file');
    const jl = dv.getUint32(8, true);
    const head = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jl)));
    let off = 12 + jl;
    const flopKeys = new Int32Array(head.flopBoards);
    for (let i = 0; i < head.flopBoards; i++) flopKeys[i] = dv.getInt32(off + 4 * i, true);
    off += 4 * head.flopBoards;
    const flopTable = u8.subarray(off, off + head.flopBoards * NUM_COMBOS); off += head.flopBoards * NUM_COMBOS;
    const tree = buildTree(head);
    if (tree.nodes.length !== head.nodes || tree.total !== head.total || tree.hash !== head.treeHash) throw new Error('blueprint tree mismatch');
    const xt = head.exportTotal != null ? head.exportTotal : head.total;
    if (xt !== tree.xtotal) throw new Error('blueprint size mismatch');
    const strat = u8.subarray(off, off + xt); off += xt;
    const conf = u8.subarray(off, off + tree.infosets);
    return makeBlueprint(head, tree, flopKeys, flopTable, strat, conf);
  }

  function makeBlueprint(head, tree, flopKeys, flopTable, strat, conf) {
    const featCache = new Map();
    function features(board) {
      const key = board.slice().sort((a, b) => a - b).join(',');
      let f = featCache.get(key);
      if (!f) {
        f = boardFeatures(board);
        if (featCache.size > 64) featCache.clear();
        featCache.set(key, f);
      }
      return f;
    }
    const spec = [null, head.b1, head.b2, head.b3];
    const countLe = (edges, from, n, x) => { let c = 0; while (c < n && x >= edges[from + c]) c++; return c; };
    function bucketOf(s, hs, ehs) {
      const sp = spec[s];
      if (sp.nh <= 1) return countLe(sp.e, 0, sp.ne - 1, hs);
      const e = countLe(sp.e, 0, sp.ne - 1, ehs);
      return e * sp.nh + countLe(sp.h, e * (sp.nh - 1), sp.nh - 1, hs);
    }
    function flopBucket(flop, k) {
      const { key, perm } = canonKey(flop);
      let lo = 0, hi = flopKeys.length - 1, id = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (flopKeys[mid] < key) lo = mid + 1; else if (flopKeys[mid] > key) hi = mid - 1; else { id = mid; break; } }
      if (id < 0) return -1;
      const a = COMBO_HI[k], b = COMBO_LO[k];
      const ma = (a & ~3) | perm[a & 3], mb = (b & ~3) | perm[b & 3];
      const v = flopTable[id * NUM_COMBOS + COMBO_INDEX[ma * 52 + mb]];
      return v === 255 ? -1 : v;
    }
    // Bucket of combo k on street s (0 preflop .. 3 river) given the board so far.
    function bucket(s, board, k) {
      if (s === 0) return COMBO_CLASS[k];
      if (s === 1) return flopBucket(board.slice(0, 3), k);
      const f = features(board.slice(0, s + 2));
      if (f.hs[k] < 0) return -1;
      return bucketOf(s, f.hs[k], f.ehs[k]);
    }
    // All live combos' buckets on street s.
    function buckets(s, board) {
      const out = new Int16Array(NUM_COMBOS).fill(-1);
      const dead = new Uint8Array(52);
      const b = board.slice(0, s === 0 ? 0 : s + 2);
      for (const c of b) dead[c] = 1;
      if (s >= 2) {
        const f = features(b);
        for (let k = 0; k < NUM_COMBOS; k++) if (f.hs[k] >= 0) out[k] = bucketOf(s, f.hs[k], f.ehs[k]);
        return out;
      }
      for (let k = 0; k < NUM_COMBOS; k++) {
        if (dead[COMBO_HI[k]] || dead[COMBO_LO[k]]) continue;
        out[k] = s === 0 ? COMBO_CLASS[k] : flopBucket(b, k);
      }
      return out;
    }
    function strategyAt(node, b) {
      const n = node.nacts, base = node.off + b * n;
      if (node.off < 0) return new Float64Array(n).fill(1 / n);
      const out = new Float64Array(n);
      let t = 0;
      for (let a = 0; a < n; a++) { out[a] = strat[base + a]; t += out[a]; }
      for (let a = 0; a < n; a++) out[a] = t > 0 ? out[a] / t : 1 / n;
      return out;
    }
    // log2(1 + strategy mass) at the infoset: how much training it got.
    const visits = (node, b) => (node.info < 0 ? 0 : conf[node.info + b] / 8);

    const N = tree.players;
    // Fraction of the pot after calling that a raise to `to` represents (bet if facing 0).
    const fracOf = (to, maxBet, potAfter) => (to - maxBet) / Math.max(1e-9, potAfter);
    const sum = (xs) => xs.reduce((x, y) => x + y, 0);

    /*
     * Seats in the tree from the table: `seats` lists the players' names in postflop order
     * (small blind first, button last), as tracker.seatOrder(). Without it (heads-up only), the
     * small-blind entry of the history decides.
     */
    function seatMap(history, seats) {
      const map = new Map();
      if (Array.isArray(seats) && seats.length) {
        if (seats.length !== N) return null;
        if (N === 2) { map.set(seats[1], 0); map.set(seats[0], 1); }
        else { map.set(seats[0], N - 2); map.set(seats[1], N - 1); for (let i = 2; i < N; i++) map.set(seats[i], i - 2); }
        return map;
      }
      if (N !== 2) return null;
      const sbE = history.find((e) => e.act === 'sb'), bbE = history.find((e) => e.act === 'bb');
      if (!sbE || !bbE) return null;
      map.set(sbE.who, 0); map.set(bbE.who, 1);
      return map;
    }

    /*
     * Follow the hand down the tree. `history`: the tracker's hand log (blinds as sb/bb, then
     * every action with amt added). Returns the abstract node for hero's decision plus the real
     * bets there, or { error }.
     */
    function locate(history, seats, heroName0) {
      const SKEY = { pre: 0, flop: 1, turn: 2, river: 3 };
      const map = seatMap(history, seats);
      if (!map) return { error: 'seats' };
      const heroE = history.find((e) => e.hero);
      const heroName = heroName0 != null ? heroName0 : heroE ? heroE.who : null;
      const bet = new Array(N).fill(0), commit = new Array(N).fill(0);
      for (const e of history) {
        if (e.act !== 'sb' && e.act !== 'bb') continue;
        const seat = map.get(e.who);
        if (seat == null) return { error: 'seats' };
        bet[seat] += e.amt; commit[seat] += e.amt;
      }
      let nid = 0, street = 0;
      const path = [];
      for (const e of history) {
        if (e.act === 'sb' || e.act === 'bb') continue;
        const s = SKEY[e.st];
        if (s == null) return { error: 'street' };
        if (s !== street) { street = s; bet.fill(0); }
        if (nid < 0) return { error: 'off tree (hand ended in the tree)' };
        const nd = tree.nodes[nid];
        const seat = map.get(e.who);
        if (seat == null) return { error: 'seats' };
        if (nd.street !== s || nd.player !== seat) return { error: 'off tree (order)' };
        const maxBet = Math.max(...bet);
        const facing = Math.max(0, maxBet - bet[seat]);
        let ai = -1;
        if (e.act === 'fold') ai = nd.kind.indexOf('f');
        else if (e.act === 'check') ai = nd.kind.indexOf('k');
        else if (e.act === 'call') ai = nd.kind.indexOf('c') >= 0 ? nd.kind.indexOf('c') : nd.kind.indexOf('k');
        else {
          const real = fracOf(bet[seat] + e.amt, maxBet, sum(commit) + facing);
          ai = mapRaise(nd, real, !!e.allin);
        }
        if (ai < 0) return { error: 'off tree (' + e.act + ')' };
        path.push({ node: nid, action: ai, seat, street: s });
        bet[seat] += e.amt; commit[seat] += e.amt;
        nid = nd.child[ai];
      }
      if (nid < 0) return { error: 'off tree (hand ended in the tree)' };
      const nd = tree.nodes[nid];
      const heroSeat = heroName != null ? map.get(heroName) : null;
      if (heroSeat == null || nd.player !== heroSeat) return { error: 'off tree (not hero to act)' };
      return { node: nd, heroSeat, bet, commit, street, path };
    }

    // Abstract raise options at a node as pot fractions.
    function raiseFracs(nd) {
      const p = nd.player, maxBet = Math.max(...nd.bet);
      const potAfter = sum(nd.commit) + maxBet - nd.bet[p];
      const out = [];
      for (let a = 0; a < nd.nacts; a++) {
        if (nd.kind[a] !== 'r' && nd.kind[a] !== 'a') continue;
        out.push({ a, f: fracOf(nd.bet[p] + nd.add[a], maxBet, potAfter), allin: nd.kind[a] === 'a' });
      }
      return out;
    }
    // Pseudo-harmonic action translation (Ganzfried and Sandholm): a real size x between
    // abstract sizes A < B maps to A with probability (B - x)(1 + A) / ((B - A)(1 + x)).
    // Here deterministic: whichever side gets at least half. Real all-ins map to all-in.
    function mapRaise(nd, x, allin) {
      const opts = raiseFracs(nd).sort((u, v) => u.f - v.f);
      if (!opts.length) return -1;
      if (allin) { const a = opts.find((q) => q.allin); if (a) return a.a; }
      // A raise that leaves chips behind stays a raise (all-in would end the line in the tree).
      if (!allin && opts.length > 1 && opts[opts.length - 1].allin) opts.pop();
      if (x <= opts[0].f) return opts[0].a;
      if (x >= opts[opts.length - 1].f) return opts[opts.length - 1].a;
      for (let i = 0; i + 1 < opts.length; i++) {
        const A = opts[i].f, B = opts[i + 1].f;
        if (x >= A && x <= B) {
          const pA = ((B - x) * (1 + A)) / ((B - A) * (1 + x));
          return pA >= 0.5 ? opts[i].a : opts[i + 1].a;
        }
      }
      return opts[opts.length - 1].a;
    }

    /*
     * Blueprint advice for hero.
     *   input: { hero: [c, c], board, history (tracker log), seats (names, postflop order),
     *            bigBlind, stack (hero's chips behind) }
     * Returns { actions: [{ kind, add, frac, p }], visits, street, bucket } or { error }.
     *   add: chips hero puts in with this action in the real hand.
     */
    function advise(input) {
      if (!input || !input.history || !input.hero || input.hero.length !== 2) return { error: 'no history' };
      const loc = locate(input.history, input.seats, input.heroName);
      if (loc.error) return loc;
      const board = input.board || [];
      const s = { 0: 0, 3: 1, 4: 2, 5: 3 }[board.length];
      if (s == null || s !== loc.node.street) return { error: 'street mismatch' };
      if (loc.node.off < 0) return { error: 'street not in this blueprint' };
      const k = COMBO_INDEX[input.hero[0] * 52 + input.hero[1]];
      const b = bucket(s, board, k);
      if (b < 0) return { error: 'bucket' };
      const nd = loc.node, p = nd.player;
      const sigma = strategyAt(nd, b);
      const maxBet = Math.max(...loc.bet);
      const facing = Math.max(0, maxBet - loc.bet[p]);
      const potAfter = sum(loc.commit) + facing;
      const behind = input.stack != null ? input.stack : Infinity;
      const fr = raiseFracs(nd);
      const bb = input.bigBlind > 0 ? input.bigBlind : 1;
      const actions = [];
      for (let a = 0; a < nd.nacts; a++) {
        const kd = nd.kind[a];
        let kind, add = 0, frac = 0;
        if (kd === 'f') kind = 'fold';
        else if (kd === 'k') kind = 'check';
        else if (kd === 'c') { kind = 'call'; add = Math.min(facing, behind); }
        else {
          frac = fr.find((q) => q.a === a).f;
          if (kd === 'a') { kind = 'allin'; add = behind; }
          else {
            const to = maxBet + Math.max(frac * potAfter, Math.max(bb, facing));
            add = to - loc.bet[p];
            kind = facing > 0 ? 'raise' : 'bet';
            if (add >= behind) { kind = 'allin'; add = behind; }
          }
        }
        actions.push({ kind, add, frac, p: sigma[a], abs: kd });
      }
      return { actions, visits: visits(nd, b), street: s, bucket: b, node: nd.id, heroSeat: loc.heroSeat, players: N };
    }

    /*
     * A player's range under the blueprint: for every combo, the probability that the blueprint
     * plays that player's line so far (each past decision's frequency at that combo's bucket).
     * seat: defaults to hero's.
     */
    function rangeOf(input, seat) {
      const loc = locate(input.history, input.seats, input.heroName);
      if (loc.error) return null;
      const who = seat != null ? seat : loc.heroSeat;
      const board = input.board || [];
      const W = new Float64Array(NUM_COMBOS).fill(1);
      const dead = new Uint8Array(52);
      for (const c of board) dead[c] = 1;
      for (const c of input.deadExtra || []) dead[c] = 1;
      for (let k = 0; k < NUM_COMBOS; k++) if (dead[COMBO_HI[k]] || dead[COMBO_LO[k]]) W[k] = 0;
      const cache = {};
      for (const st of loc.path) {
        if (st.seat !== who) continue;
        const nd = tree.nodes[st.node];
        if (nd.off < 0) continue;
        const bs = cache[st.street] || (cache[st.street] = buckets(st.street, board));
        for (let k = 0; k < NUM_COMBOS; k++) {
          if (!W[k] || bs[k] < 0) continue;
          W[k] *= strat[nd.off + bs[k] * nd.nacts + st.action] / 255;
        }
      }
      return W;
    }
    const heroRange = (input) => rangeOf(input);

    return { head, tree, players: N, advise, heroRange, rangeOf, locate, bucket, buckets, strategyAt, features, visits };
  }

  const api = { load, buildTree, boardFeatures, canonKey, COMBO_CLASS, COMBO_INDEX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PatioBlueprint = api;
})(typeof window !== 'undefined' ? window : globalThis);
