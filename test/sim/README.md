# Simulator (test/sim)

Plays the real solver, driven through the real tracker exactly like the overlay, against bots on identical deals,
with as much of the luck removed as can be done without bias. Replaces `test/sim.js` and `test/sim-multi.js`
for measuring changes (those two still work and are left as they were).

```
node test/sim/run.js --hands 2000 --players 4 --bots friends                  # solver vs bots fitted to Marwin's friends
node test/sim/run.js --hands 2000 --players 2 --bots maniac --stack 100 \
     --a-opts '{"preflopSolver":false}' --b-opts '{}'                         # paired A/B: preflop solver off vs on
node test/sim/run.js --hands 2000 --players 4 --bots friends --a-ref main --b-ref my-branch   # two versions of src/
node test/sim/run.js --hands 2000 --players 2 --bots typical --agent baseline --b-agent solver
node test/sim/selftest.js                                                      # checks the simulator itself (~40 s)
node test/sim/profile.js <hand-log.json> ...                                   # a player's numbers from an export
node test/sim/calibrate.js <hand-log.json> ... --names <private file>         # refits profiles.json from logs
```

The summary (JSON on stdout, per-deal results in `test/out/sim-<tag>.json`) gives, for each variant, bb/100 won with
its standard error raw and after the luck correction (`aivatBB100 ± aivatSE100`, the number to read), and for A/B
runs the paired difference B - A. Progress lines on stderr show the running numbers. Every result in bb/100 is the
hero's win rate against the whole table.

## What removes the noise

1. **Duplicate deals** (`--dup 1`, default). Every deal is played once per seat: the hole cards stay with their
   position and the players rotate, so hero plays every hand of the deal from its seat, and so does every bot.
   Card luck between players cancels. (The old `sim-multi.js` rotated cards but not the button.)
2. **AIVAT luck correction** (`--aivat call`, default). Each board card and each decision of a bot (bots publish
   their action probabilities) adds `V(what happened) - E[V(what could have happened)]`, where V is hero's expected
   result if the hand were checked down from there with every hole card known (exact enumeration on the flop and
   later, 2,000 sampled boards preflop; bets not yet called are assumed called). Each correction has zero mean, so
   the corrected result is unbiased (selftest checks it); it strips out who hit the river and whether a bot happened
   to bluff this time. Hero's own decisions are not corrected (the solver's strategy isn't known in closed form).
   All-in hands become all-in equity automatically. A board card's correction is scaled by
   `1 + 0.8 * min(stack behind / pot, 1.5)` (`--future`, `--cap`), because a card that changes who is ahead also
   changes how much more money goes in; the scale is fixed before the card falls, so the mean stays zero. That
   cut the remaining variance by about 20% in bot-vs-bot tuning runs. (A hole-card control variate was tried on top
   and did not help: duplicate deals already cancel that luck.)
3. **Paired A/B on the same deals.** Both variants play the same deals with the same bot random numbers (bots draw
   from a hash of deal, seat and decision number), and the difference is taken deal by deal.
4. **Warm reads** (`--warm 300`). Each block of deals starts with 300 hands watched with a simple player in hero's
   seat, so the solver has reads like Marwin's instead of learning from scratch. Both variants get the same hands.

Measured with a fast bot in hero's seat: 4-handed vs friends the per-deal spread is 11.3 bb raw (already duplicate)
and 7.6 bb corrected; heads-up vs the old typical bot, duplicate alone cuts the hands needed for a given precision
about 3.5x and the correction another 1.6x, so about 6x in all. For A/B runs the pairing adds to that.

`node test/sim/diff.js test/out/sim-<tag>.json` splits an A/B difference by hero's position and starting hand.
`node test/sim/diff.js <file>:A <file>:B` does the same for variants from two runs of the same deals (same players,
bots, seed and block size), so a third arm can be added later without replaying the first two.

## Bots

* `friends`: bots fitted to the friends in Marwin's hand logs (`profiles.json`, ids f1..f11, most hands first; the
  names are kept out of this public repo). Each block of deals seats a different lineup. `home:f3` seats one profile,
  `home:pool` the pooled average friend, `home:hero` a bot fitted to Marwin's own play (used during calibration).
  They limp a lot, open 3-5bb, 3-bet with min-raises (raise wars), bet small and min-bet, and call with any pair or
  draw. Fitted per friend, shrunk toward the pool by sample size: VPIP, PFR, fold and 3-bet vs an open, continue vs
  8bb+ to call, a limper's fold to a raise (real limpers fold about half the time), an opener's fold to a 3-bet,
  open size, share of opens that are all-in, bet size, and bet / fold-to-bet / raise per street (average miss
  ~1.7 points over 23 stats and 278 hands from three exports, deduplicated by time stamp). Opens of 12bb or more
  count as shove-opens (one friend opens all-in about a fifth of the time), so they don't set the open size or
  count as facing an open; each bet's size is capped at 2x pot so a few huge bets don't set the mean. Pooled
  over all friends (too few showdowns each), how strong river callers are at showdown sets how loosely they call
  (they call with weaker hands than a strict threshold would, and fold some better ones). WTSD and the share of weak
  hands among shown bets come out close without being fitted.
* `solver` (or `solver@REF` for src/ of a git ref): the solver itself in a bot seat, with its own tracker that
  watches the table from that seat (its own hole cards, reads on everyone including hero), like a friend running
  the same overlay. Mix with friends as a comma list, e.g. `--bots solver,home:f4,home:f2`. Use it to check that
  a change does not only exploit the bots. It costs a solve per decision in every solver seat, and its decisions
  get no luck correction (its strategy isn't known in closed form), so expect more noise. Each A/B variant plays
  against its own copy, since the copies learn from hero's play.
* `typical`, `station`, `maniac`, `mixed`: the old simulators' bots (same decisions), for continuity.
* `--agent baseline`: the old simple solid regular, as a yardstick.

Stacks default to 150bb with friend bots (like the real lobby) and 100bb otherwise; big blind 2 chips.

## Speed

All cores by default (`--workers`). Results depend only on `--seed` and `--block`, not on the number of workers.
With the WebAssembly kernels the solver costs ~50-150 ms per decision at sim settings (`--iters 3000`,
`--river-iters 120`, preflop solver at its phone default; the preflop solver is most of it). On 4 cores a paired
A/B of 2,000 deals takes about 18 minutes 4-handed (16,000 hands) and 7 minutes heads-up. With `--tag name`, every finished block is appended to `test/out/sim-name.blocks.jsonl`; starting the same
command again (same settings, solver commit and profiles) skips those blocks, so a run cut off by a container
restart loses at most one block per worker. The old flags PF=0, PFIT=n, TURN=1, TURNIT=n work as environment variables (they apply to both variants;
`--a-opts`/`--b-opts` override).
