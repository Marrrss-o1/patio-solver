# Simulator (test/sim)

Plays the real solver, driven through the real tracker exactly like the overlay, against bots on identical deals,
with as much of the luck removed as can be done without bias. Replaces `test/sim.js` and `test/sim-multi.js`
for measuring changes (those two still work and are left as they were).

```
node test/sim/run.js --hands 2000 --players 4 --bots friends                  # solver vs bots fitted to Marwin's friends
node test/sim/run.js --hands 1000 --players 4 --bots friends --budget live \
     --a-ref main --b-ref my-branch                                           # the same, with the budget Marwin plays
node test/sim/run.js --hands 2000 --players 2 --bots maniac --stack 100 \
     --a-opts '{"preflopSolver":false}' --b-opts '{}'                         # paired A/B: preflop solver off vs on
node test/sim/run.js --hands 2000 --players 4 --bots friends --a-ref main --b-ref my-branch   # two versions of src/
node test/sim/run.js --hands 2000 --players 2 --bots typical --agent baseline --b-agent solver
node test/sim/tune.js --arms '{"base":{},"r0":{"patch":{"robust":0}}}' --set f4 --players 4 --bots friends  # tuning sweep
node test/sim/validate.js <hand-log.json> ... --names <private file> --sizes  # do the bots play like the logs?
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

5. **One baseline for many arms** (`tune.js`). Every result depends only on the deals and the bots' random numbers,
   not on what else ran, so a variant played in its own run pairs with a baseline from another run exactly as it
   would inside one A/B run (checked: same difference to the last digit). `tune.js` plays each arm once and pairs it
   with one shared baseline, so a sweep of k settings costs k + 1 runs instead of 2k.

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
  ~1.7 points over 23 stats and 278 hands from three exports, deduplicated by time stamp). Pooled over all
  friends: how much more often they fold to bigger bets (real: 36% fold facing under 45% pot, 64-67% above, flat
  from about 2/3 pot; `callSlope` up to `sizeCap`), so bet-sizing changes can be scored. Opens of 12bb or more
  count as shove-opens (one friend opens all-in about a fifth of the time), so they don't set the open size or
  count as facing an open; each bet's size is capped at 2x pot so a few huge bets don't set the mean. Pooled
  over all friends (too few showdowns each), how strong river callers are at showdown sets how loosely they call
  (they call with weaker hands than a strict threshold would, and fold some better ones). WTSD and the share of weak
  hands among shown bets come out close without being fitted. Sizing, pooled: re-raises are mostly min-raises
  (about 4 in 5, a few all-in), raises after the flop a little over half min-raises with some all-ins and the rest
  about 4.5x, and bet sizes shrink as the pot grows (about pot-size in pots under 6bb, a fifth of the pot above 25bb;
  log size on log pot slope -0.52, spread 0.63 around it), and a bettor who gets raised re-raises about 15% of
  the time (3 of 21 in the logs; the bots did 26% before this was fitted) and folds about 29% (not fitted; real 29%),
  multiway, a first bet (25-110% pot) that nobody has called yet is answered about as heads-up (first to answer
  folds 53%, last after the others folded 53-57%) and a player folds more once someone has called (63%; the bots
  before this was fitted did the opposite: 62%, 65% and 44%, so two bots folded together 40% of the time against
  the friends' 24%; now 31%), so the solver faces the cheap big-pot bets and the big
  small-pot bets the real table makes. Checked to on the turn or river, a friend who called the street before rarely
  bets (turn 10% of 68, river 26% of 57), one who bet it bets about half the time (41%, 49%) and one whose street
  was checked through stabs more (25%, 51%); `lineBet` shifts the bots' betting by that line (log-odds, pooled; each
  friend's own value threshold keeps their overall rate). Before it the bots led after calling 25% / 49% and stabbed
  checked streets 17% / 32%. Checked with `validate.js` (below): on all 278 hands every stat, fitted or
  not, is within the logs' sampling noise (RMS z 0.70 fitted, 0.94 pooled, 1.09 unfitted); fitted on half the
  hands, each friend's own bot predicts the other half better than the average friend's (+0.009 to +0.012
  log-likelihood per observation). Known gaps: the bots see a few more flops (66% vs 69%) and lead into the
  preflop raiser more often (24% vs 17%).
  Bet size against strength (not fitted in profiles.json, `sizeTell` 0.6 everywhere): in the logs (87 shown first
  bets after the flop, 31 Oct + 1 Nov) bigger bets showed weaker hands, mean made-hand percentile 0.84 under 0.45
  pot, 0.78 at 0.45-0.85, 0.70 at 0.85-1.2 and 0.61 above (log size on percentile -0.69 ± 0.33). The bots at 0.6
  come out flat (0.79, 0.77, 0.78, 0.78; slope -0.11 ± 0.10, the pot-size slope works against it); `sizeTell` -0.6
  gives 0.82, 0.78, 0.77, 0.68, slope -0.70 ± 0.07 (0 gives -0.44, -0.8 gives -0.79; 8,000 hands each). `--bot-params '{"sizeTell":-0.6}'` plays
  every friend profile that way; use it for anything that reads bet sizes.
* `solver` (or `solver@REF` for src/ of a git ref): the solver itself in a bot seat, with its own tracker that
  watches the table from that seat (its own hole cards, reads on everyone including hero), like a friend running
  the same overlay. Mix with friends as a comma list, e.g. `--bots solver,home:f4,home:f2`. Use it to check that
  a change does not only exploit the bots. It costs a solve per decision in every solver seat, and its decisions
  get no luck correction (its strategy isn't known in closed form), so expect more noise. Each A/B variant plays
  against its own copy, since the copies learn from hero's play. With solver opponents the warm-up puts the solver
  (variant A's code) in hero's seat too, so the copies' reads of hero come from solver-like play; with a simple
  player there instead, self-play came out about +70 bb/100 for hero, because the copies read hero wrong.
* `typical`, `station`, `maniac`, `mixed`: the old simulators' bots (same decisions), for continuity.
* `--agent baseline`: the old simple solid regular, as a yardstick.

Stacks default to 150bb with friend bots (like the real lobby) and 100bb otherwise; big blind 2 chips.

## Tuning sweeps

`--a-patch` / `--b-patch` change solver settings that are constants in `src/engine.js`, by exact text edits to a copy
of it (`knobs.js`, written to `test/out/tune/<hash>/src`), so a sweep needs no change to the engine until a setting
wins. Knobs: `exploit` (scales the read's weight against balanced play), `robust` (weight of the worst opponent
variant, 0.35), `betSizes` (flop/turn bet menu, x pot), `raiseSizes` / `preRaiseSizes`, `riverSizes` (river solver,
at most 3), `shovePre` ([bb, x pot] below which all-in is offered preflop), `shovePost`, `cred` (hero's-story fold
shift, x), `raiseEq` (the lookahead's raise threshold). An edit that no longer matches the engine throws, and the
selftest checks every knob, so a knob can't silently test nothing after the engine changes. Solver inputs that are
already options (iterations, solvers on or off) go in `--a-opts` / an arm's `opts`.

`tune.js` runs arms (`{ name: { patch, opts } }`, the first is the baseline; inline JSON or a file) as separate
single-variant runs tagged `tune-<set>-<arm>`, all to 400 deals, then all to the next stage, and so on
(`--stages 400,1200,2400`; resumable like any tagged run, and a stage can be raised later without replaying). After
each stage it prints every arm's paired difference from the baseline and writes `test/out/tune-<set>.json`;
`--prune Z` stops arms more than Z standard errors behind. `--report` prints the table from what's saved. Picking the
best of many noisy arms overstates it (winner's curse): confirm a winner on fresh deals (`--seed`) before trusting
its number.

## Checking the bots

`validate.js` plays the calibrated bots against each other (4-handed with the hero bot, as in calibration) and
compares every stat `profile.js` measures with the real logs, per friend, in units of the real number's sampling
error (z), fitted and unfitted stats alike. RMS z near 1 and about 5% beyond 2 SE is as good as the logs can tell.
For a held-out check, fit on half the hands and validate on the other half (`calibrate.js even.json --out p.json
--names n.json`, then `validate.js odd.json --profiles p.json --names n.json`); "per-friend bots vs the pooled bot" is
the log-likelihood gain per observation of each friend's own bot over the average friend's on hands it never saw.
`--sizes` prints the spread of open, re-raise, raise and bet sizes, real vs bots.

## Budgets: play what Marwin plays (`--budget live`)

By default the solver plays with a cheap budget (3,000 Monte Carlo iterations, river solver 120 iterations, no
turn solver). That is not the advice Marwin plays. He plays on the computer (the extension), whose full solve
(`extension/offscreen.js`: 24x the Monte Carlo, the turn solver on for 1-1.5 s per worker, river solver 16x,
preflop solver 4x) lands before he acts on nearly every decision since #51-#53. (In the logs he acts in a median
2.4 s.)
The phone, and the computer's quick read, use 24,000 Monte Carlo iterations (16,000 against 3+ opponents) and
the engine's solver defaults.

| `--budget` | Monte Carlo | Turn solver | River / preflop solver | Same action as the full solve (292 logged decisions) |
|---|---|---|---|---|
| none (default) | 3,000 | off | 120 / 300 | flop 53% heads-up, 79% multiway; turn 36-42%; preflop and river 98-100% |
| `phone` | 24,000 / 16,000 | off | 250 / 300 | flop 87% / 95%; turn 36-42%; preflop and river 98-100% |
| `live` | 24,000 / 16,000 | 100 iterations | 250 / 300 | flop 87% / 95%; turn 100% (44 of 44); preflop and river 98-100% |

The full solve's bigger preflop and river budgets changed no decisions (measured with preflop at 4,800 iterations,
before #53 cut it to 1,200 with the same picks), and 100 turn-solver iterations pick what the full solve's
averaged workers pick (8 workers at 100 iterations each, about what 1-1.5 s gives on a fast computer). With the default budget the simulator mostly measures a weaker
player on the flop and a different one on the turn. Confirm a change with `--budget live` before trusting it.
It costs about 6x the default's time per decision (781 ms against 133 ms; `phone` 348 ms), mostly the turn solves.
`--iters` and `--river-iters` override the budget's numbers, and `--a-opts` / `--b-opts` go on top. Runs without
`--budget` keep their old results and block keys.

How far apart the budgets play (4-handed friends, 150bb, 1,000 deals, seed 61, main after #53; the two runs paired
with `diff.js`):

| Budget | bb/100 (AIVAT) | Paired with the default |
|---|---|---|
| default | 216.7 ± 30.1 | |
| `phone` (`--budget live --a-opts '{"turnSolver":false}'`) | 269.0 ± 31.6 | +52 ± 20 |
| `live` | 262.7 ± 27.7 | +46 ± 21 |

So the default plays well below what Marwin plays (an earlier run on an older main had 3,000 against 24,000
Monte Carlo iterations at -4.8 ± 21; pooled about +25 ± 15), and the turn solver at the real budget is
-6.3 ± 21.1 against the same budget without it (on the default budget it measured about +12 ± 15 pooled).

## Speed

All cores by default (`--workers`). Results depend only on `--seed` and `--block`, not on the number of workers.
With the WebAssembly kernels the solver costs ~50-150 ms per decision at sim settings (`--iters 3000`,
`--river-iters 120`, preflop solver at its phone default; the preflop solver is most of it). On 4 cores a paired
A/B of 2,000 deals takes about 18 minutes 4-handed (16,000 hands) and 7 minutes heads-up. With `--tag name`, every finished block is appended to `test/out/sim-name.blocks.jsonl`; starting the same
command again (same settings, solver commit and profiles) skips those blocks, so a run cut off by a container
restart loses at most one block per worker. The old flags PF=0, PFIT=n, TURN=1, TURNIT=n work as environment variables (they apply to both variants;
`--a-opts`/`--b-opts` override).
