// Leads after the flop: how often a player who is checked to, or first to act, bets before the street's aggressor (the
// preflop raiser on the flop, the street before's last bettor on the turn and river) has acted, heads-up and multiway,
// and the other first-bet spots for comparison (after the aggressor checked, as the aggressor, no aggressor). Every
// hand counts, shown or not; hero's own actions are left out. The v12 bots' `leadHu` is fitted on this table.
//
//   node test/sim/lead-test.js <export.json> ...                       (hand-log exports; hands in several are counted once)
//   node test/sim/lead-test.js --bots test/sim/profiles-v12.json --hands 12000
//        (bots against each other, 4-handed at 150bb with the hero bot, like allin-test.js --bots)
'use strict';
const fs = require('fs');
const bots = require('./bots.js');
const { playHand, shuffled, keyed } = require('./game.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes('--' + k) ? args[args.indexOf('--' + k) + 1] : d);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));

function botHands(profFile, N) {
  const profiles = JSON.parse(fs.readFileSync(profFile, 'utf8'));
  const ids = Object.keys(profiles).filter((id) => id !== 'hero' && id !== 'pool');
  const hero = profiles.hero ? bots.homeBot(profiles.hero.params) : bots.baseline();
  const out = [];
  for (let blk = 0; blk < Math.ceil(N / 100); blk++) {
    const order = ids.map((id, i) => [keyed(blk, i, 4711), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 3);
    const seats = [hero].concat(order.map((id) => bots.homeBot(profiles[id].params)));
    for (let h = 0; h < 100 && out.length < N; h++) {
      const d = blk * 100 + h, deck = shuffled((d * 2654435761 + 12345) >>> 0);
      const hands = []; for (let i = 0; i < 4; i++) hands.push([deck[2 * i], deck[2 * i + 1]]);
      out.push(playHand({ n: 4, btn: d % 4, hands, boardAll: deck.slice(8, 13), stacks: [300, 300, 300, 300], sb: 1, bb: 2, seats, hero: 0,
        names: ['hero'].concat(order), seed: (d * 40503 + 7) >>> 0, log: true }).entry);
    }
  }
  return out;
}

const H = opt('bots', null) ? botHands(opt('bots'), +opt('hands', 12000)) : require('../merge-logs.js').loadHands(files);
const AGG = /^(bet|raise|3bet|4bet|5bet|allin)$/;
const rows = [];
for (const h of H) {
  const log = (h.log || []).filter((e) => e.act);
  const heroName = ((h.players || []).find((p) => p.hero) || {}).name;
  const lastAgg = (st) => (log.filter((x) => x.st === st && AGG.test(x.act)).pop() || {}).who || null;
  for (const [st, prev] of [['flop', 'pre'], ['turn', 'flop'], ['river', 'turn']]) {
    const agg = lastAgg(prev);
    const S = log.map((e, i) => [e, i]).filter(([e]) => e.st === st);
    const nIn = new Set(S.map(([e]) => e.who)).size;
    const acted = new Set();
    for (const [e, i] of S) {
      if (e.facing > 0) break; // someone has bet: the rest are answers
      if (!e.hero && e.who !== heroName) {
        const aggIn = agg && !log.slice(0, i).some((x) => x.who === agg && x.act === 'fold');
        const spot = !aggIn ? 'none' : agg === e.who ? 'agg' : acted.has(agg) ? 'after' : 'lead';
        rows.push({ st, spot, bet: AGG.test(e.act), intoHero: agg === heroName, hu: nIn === 2 });
      }
      acted.add(e.who);
      if (AGG.test(e.act)) break;
    }
  }
}
const pct = (s) => (s.length ? `${(s.filter((r) => r.bet).length / s.length).toFixed(3)} (${s.length})` : '-');
console.log(`${H.length} hands, ${rows.length} first actions with no bet yet on the street (bet share, spots)`);
for (const st of ['flop', 'turn', 'river']) {
  const R = rows.filter((r) => r.st === st), L = R.filter((r) => r.spot === 'lead');
  console.log(`  ${st.padEnd(5)} lead into the ${st === 'flop' ? 'preflop raiser' : 'last bettor'}: heads-up ${pct(L.filter((r) => r.hu))}, multiway ` +
    `${pct(L.filter((r) => !r.hu))} (into hero ${pct(L.filter((r) => r.intoHero))}, into others ${pct(L.filter((r) => !r.intoHero))})`);
  console.log(`        after they checked ${pct(R.filter((r) => r.spot === 'after'))}, as that player ${pct(R.filter((r) => r.spot === 'agg'))}, ` +
    `no aggressor ${pct(R.filter((r) => r.spot === 'none'))}`);
}
