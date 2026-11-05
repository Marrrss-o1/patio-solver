# Simulator (test/sim)

Plays the real solver, driven through the real tracker exactly like the overlay, against bots on identical deals,
with as much of the luck removed as can be done without bias. Replaces `test/sim.js` and `test/sim-multi.js`
for measuring changes (those two still work and are left as they were).

```
node test/sim/run.js --hands 2000 --players 4 --bots friends                  # solver vs bots fitted to Marwin's friends
BOTPROFILES=test/sim/profiles-v12r.json node test/sim/run.js --hands 1000 --players 4 --bots friends --budget live \
     --a-ref main --b-ref my-branch                                           # the main check: the regulars, live budget
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
node test/sim/range-test.js <hand-log.json> ...                              # do they fold by absolute or range-relative strength?
node test/sim/range-test.js --bots test/sim/profiles-v8.json                 # ... the same test on bots
node test/sim/allin-test.js <hand-log.json> ...                              # preflop all-in re-raises by stack depth (--bots too)
node test/sim/lead-test.js <hand-log.json> ...                               # leads into the aggressor after the flop (--bots too)
node test/sim/fold-cal.js --hands 1000 --players 4 --bots friends --budget live   # do the bots fold to hero's bets as read?
node test/sim/v8-ref.js --out test/sim/v8-ref.json                           # the v8 bots' usual ranges (BOTPROFILES=...)
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

* `friends`: bots fitted to the friends in Marwin's hand logs (`profiles.json`, ids f1..f14, most hands first; the
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
  gives 0.82, 0.78, 0.77, 0.68, slope -0.70 ± 0.07 (0 gives -0.44, -0.8 gives -0.79; 8,000 hands each).
  `--bot-params '{"sizeTell":-0.6}'` plays every friend profile that way; use it for anything that reads bet sizes.
  Since v1.8.3 profiles.json is fitted with `sizeTell` -0.6 held fixed (`calibrate.js --fixed`), so the default
  bots already bet that way (shown-bet slope -0.72 ± 0.07).
* Refit for v1.8.3 (`profiles.json`, 337 hands: the 31 Oct and 1 Nov logs, 14 friends; `calibrate.js ... --hands
  20000 --rounds 18 --fixed '{"sizeTell":-0.6}'`, cliff on): two more things the friends do.
  - Big preflop raises: facing a first raise to 8bb or more, friends continue 72/69/67% at 8-12/12-20/20-35bb and
    then 9% at 35-60bb and 4% above (96 spots; players who had raised or called before: 0 of 24 above 35bb). The
    bots' big-raise rate was size-blind apart from (8bb / to call)^0.25, so they called a 100bb raise about 14% of
    the time. Now the continue rate is also multiplied by (30bb / raise-to)^2.5 above 30bb (`BOTCLIFF=0` turns it
    off): 53/59/75/50/4% (the 35-60bb bucket is mostly players already in the pot, whose threshold is set over all
    hands; the logs' 8-12bb rate is still higher than the bots').
  - Heads-up answers: the first answer to a heads-up bet of 25-110% pot was whatever the street fold rates left
    over once multiway answers were fitted (bots 63%, friends 53%, n 75). `callHu` is a pooled threshold shift for
    heads-up answers (target `huAnsFold`): bots 52%; by size 19/32/52/60/65% at <25/25-45/45-75/75-110/110%+ pot
    against the logs' 13/37/52/61/67%. Multiway small bets are still off (bots fold 17% to bets under a quarter of
    the pot, logs 48%, n 25).
  validate.js on the 337 hands: fitted RMS z 0.70, pooled 1.04, unfitted 1.14. `profiles-v3.json` is the same
  refit with `sizeTell` left at 0.6 (the table-step runs on seeds 502/503 in CLAUDE.md used it). The old bots: `BOTCLIFF=0` with
  `BOTPROFILES=<file>` holding `git show c8d50cb:test/sim/profiles.json` (run.js and exploit.js read BOTPROFILES).
* Friend bots v5, v6 and v7 (2 Nov night; run with `BOTPROFILES=test/sim/profiles-v7.json`, the default profiles.json is
  unchanged). v5: refit on all 458 logged hands with the commitment habit (`commit`, fold odds per hand x exp(commit x
  share of the stack in)). v6: v5 with `commitCut` -1.8 (the same habit on the share that folds, so it moves the fold
  share as much as the read's commitFold; `commit` moved it about a third as much). v7: v6 with `bigCall` 0.18 (facing a
  bet in a pot of `bigPot` 15bb or more, the continue cut moves up 0.18): v6 bots folded to bets in 15bb+ pots 8-10
  points less than main's read, the friends as the read says (against each other act - pred -0.004, n 371; against hero
  +0.021, n 109); v7 -0.009 and -0.018 (seed 17), and showdowns per hand 0.87 -> 0.60 (friends 0.54). Off by default:
  `pfCommit` (preflop chips-in lifts the cliff) and the hero-pot options `hpCall`, `hpWc`, `hpDraw`, `hpBluff`, `hpPut`,
  `hpFlop`, which tried to reproduce the friends' strong hands in hero's big pots after a passive flop (0.74 of the
  read's range, n 23) and never got the bots above about 0.59.
* Friend bots v8 (4 Nov night; `BOTPROFILES=test/sim/profiles-v8.json`): refit on all 519 logged hands (31 Oct to
  4 Nov, the audit's all.json) with answers judged partly by strength within their own range, plus four pooled habits
  the v7 bots lacked. Why: on all logs the v7 bots fold too much (river 64% vs the friends' 53%, heads-up first answers
  65% vs 47%), and against the solver they folded 81% of its heads-up bets of 0.85 pot or more where the friends fold
  49% (audit-2026-11-04/NOTES.md). The pieces, all off by default (a profile without them is a v7 bot, hand for hand):
  - `rel` (v8: 0.5): each bot rebuilds its own range from its line this hand (its own policy replayed over every
    combo; game.js passes `hist` to seats with `rangeAware`), finds its hand's quantile q in that range by made-hand
    percentile, and calls and raises with hp + rel x (REF(q) - hp), where REF(q) is the percentile at quantile q of its
    usual range in that spot (`test/sim/v8-ref.json`, by street and spot: checked to, facing a bet, re-raised; measured on
    the bots' own ranges by `v8-ref.js`). rel 1 answers by the range alone; 0 by absolute strength, as in v7. `relBet`
    does the same for betting when checked to (REF by the bot's line on the street before); unused in v8.
  - `potCall` (0.08): the continue cut moves by potCall x ln(pot / 10bb). At the same fraction of the pot the friends
    fold a little more in bigger pots (25-110% pot: 43% under 10bb, 48% at 20bb+); absolute-strength bots fold less
    there (55% / 41%), because ranges in big pots are strong.
  - `callHuLog` (-0.28): heads-up from the start of the street, the cut also moves by callHuLog x ln(size / 0.5).
    Heads-up first answers to 25-50% pot bets: friends fold 37%, v7-style bots 24%; to 50-110%: 53% and 54%.
  - `w` (0.14, was 0.05): the betting softness, fitted to river bettors' strength at showdown (friends 0.74, v7 bots
    0.80): the bots' bets were too honest, so hero's river calls against them looked good (solver equity 0.27, real share
    0.16).
  - `raisedCut` (-0.06): re-raised after betting or raising on the street (friends fold 19-24%, v7 bots 33%).
  `calibrate.js --fit-raised --fit-husize --fit-betw --fit-pot --fixed '{"sizeTell":-0.6,"commitCut":-1.8,"pfCommit":1,
  "rel":0.5}' --workers 4` (bigCall back to 0), then `--init` for a polish pass. Names: sim-profile-names-v8.json in the
  project folder.
  Why half range-relative: `range-test.js` replays the logs with puppet seats and rebuilds each answerer's range with the
  pooled bot's policy at all 1,013 answers to bets after the flop, then fits fold on size, street, heads-up, re-raised,
  pot size and the range's mean percentile. Friends: range -0.25 ± 0.08 per 0.1 of mean percentile, pot +0.30 ± 0.09
  (log-odds); absolute-strength bots (v7-style refit) -0.50 ± 0.04 and +0.02; fully relative bots -0.04 ± 0.04 and
  -0.06. Without the pot term the friends fold 51/48/45% from the weakest to the strongest third of ranges (bets of
  25-110% pot), absolute bots 63/49/35%, relative 55/49/45%.
  Results. `validate.js` on all 519 hands (RMS z of the fitted / pooled / unfitted stats): v7 0.94 / 1.25 / 1.37, v7
  refit on the same logs without the new pieces 0.81 / 1.20 / 1.16, v8 0.80 / 1.17 / 1.12 (v7 on these logs: river
  fold 64% against 53%, heads-up first answers 65% against 47%, re-raised 33% against 19%). `range-test.js --bots`
  on 3,000 v8 hands: range -0.31 ± 0.04, pot +0.35 ± 0.05, terciles 52/50/42%. Against the solver (4-handed, seed 7,
  default budget; act / pred = the share of the solver's bets everyone folded / the solver's predicted all-fold, and
  the slope of a logistic recalibration of pred, 1 = calibrated; logs = the friends against Marwin's live advice):
  | | logs | v7 | v8 |
  |---|---|---|---|
  | slope, all postflop bets | 0.57 ± 0.16 | 1.05 ± 0.15 | 0.76 ± 0.13 |
  | slope, heads-up flop + turn | 0.96 ± 0.36 | 1.21 ± 0.28 | 0.79 ± 0.26 |
  | slope, heads-up river | 0.08 ± 0.48 | 0.73 ± 0.66 | 0.33 ± 0.61 |
  | slope, multiway | 0.33 ± 0.32 | 1.15 ± 0.30 | 1.36 ± 0.30 |
  | heads-up, under 0.45 pot | .39 / .35 | .25 / .42 | .24 / .35 |
  | heads-up, 0.45-0.85 pot | .40 / .49 | .52 / .62 | .32 / .49 |
  | heads-up, 0.85 pot+ | .49 / .50 | .79 / .62 | .34 / .45 |
  | heads-up river, 0.85 pot+ | .55 / .61 | .92 / .72 | .31 / .45 |
  | river raises | .57 / .32 | .83 / .34 | .42 / .32 |
  | flop raises | .16 / .15 | .38 / .31 | .19 / .20 |
  | all postflop bets | .36 / .35 | .34 / .43 | .23 / .30 |
  So v8 bots no longer over-fold to the solver's big bets, and the slope is closer to the friends'. What it does not
  reproduce: against the solver's heads-up flop and turn bets v8 bots fold 27-29% where the read says 39-43% (the
  friends fold about as read). Among themselves they fold to the same seat's heads-up flop bets 43% (the friends to
  Marwin 48%), so this is probably where the solver bets against bots (into ranges stronger than the friends', mean
  percentile 0.55-0.61 against 0.53-0.56 in the logs, river pots 65bb against 41bb), not a misfit everywhere. Read v8
  results on flop and turn bets as pessimistic and on river calls as about right (hero's heads-up river calls: solver
  equity 0.38, share won 0.26; v7 0.37 / 0.21). Scripts and tables: sims/2026-11-04-v8bots/ in the project folder.
* Friend bots v9 (5 Nov; `BOTPROFILES=test/sim/profiles-v9.json`): v8 plus one habit, `heroRiverAbs` 0.55. On the river,
  facing a bet whose last aggressor is the hero seat, a bot continues iff its hand beats `heroRiverAbs` of all hands on
  the board (`hp`, soft edge `heroRiverW` 0.02), whatever the size or its range; it raises as before among the hands that
  continue (`heroRiverHU` 1 limits the habit to heads-up answers; off by default). Other bots' river bets are answered as
  in v8. Why: on all logs the friends fold to each other's river bets as read (heads-up n 154, predicted .47, actual .46,
  calibration slope 0.88 ± 0.20), but answer hero's by absolute strength: heads-up they continued iff the hand beat
  about 55% of all hands (n 30; every shown caller had second pair or better), with no response to size (river-bluff
  thread). Plain river fold rates already matched in v8 (`range-test.js --river`: first answers to river bets, friends
  0.51, n 230, v8 bots 0.50, n 1,315; by preflop pot type and size within noise), so this is the only change.
  Against the solver (4-handed, live budget, seed 3851, 1,000 deals; act / pred = everyone folded / the solver's
  predicted all-fold): heads-up river bets 0.39 / 0.47 (n 289), calibration slope 0.06 ± 0.14 (friends against Marwin
  0.08 ± 0.48, n 29); hero's heads-up river bets with under 30% equity 0.33 / 0.61 (n 93; friends 0 of 4, 0 of 9 with
  multiway); with 60%+ equity 0.43 / 0.39 (friends 0.54 / 0.46). By size (under 45% / 45-85% / 85%+ pot) the bots fold
  0.46 / 0.36 / 0.49 where the read says 0.35 / 0.63 / 0.61.
  The same deals on v8: heads-up river bets 0.55 / 0.50 (n 299), slope 0.65 ± 0.15; bluffs under 30% equity 0.65 /
  0.63 (n 106), so on v8 the solver's river bluffs paid and on the friends they didn't. Shown river bets sit at about
  the same quantile of the solver's read in both (rb-hero.js's method: v8 0.58-0.59, v9 0.57, friends 0.55 ± 0.05),
  and hero's heads-up river calls win less than their equity in both (v9 0.23 against 0.35, v8 0.23 against 0.34).
  Scripts and tables: sims/2026-11-04-v8bots/ in the project folder (rbv8b.js, slope.js).
* Friend bots v10 (5 Nov; `BOTPROFILES=test/sim/profiles-v10.json`): v9 plus `jam` 0.0413 and `rrShove` 0. Facing one
  raise, a bot goes all-in with a share J = `jam` x (40bb / its chips)^`jamK` (1.52, at most `jamMax` 0.3) of the spots,
  from the hands between its re-raise range and `jamTop` (0.7) x VPIP; its other re-raises shrink by J, so it re-raises
  about as often in all. Why: the friends' preflop all-ins are wide and come from short stacks. `allin-test.js` on all
  logs (519 hands): 8 of 649 first raises faced were jammed, 2 of 25 under 30bb of chips, 2 of 44 at 30-60bb, 2 of 78 at
  60-100bb, 2 of 368 at 100-200bb, 0 of 134 deeper (fit: 12% at 20bb, 4.1% at 40bb, 0.6% at 150bb); the shown jams sit
  at class rank 0.24-0.64 (Q6o, T9o, J8o, A2s twice, Q2o; 0 = AA), where the other shown re-raises have a median of 0.06.
  Over two raises or more they went all-in once in 200 spots (ATo, 50bb). The v8 bots' all-ins were their top hands
  (median 0.06, `rrShove`: a share of every re-raise), as rare when short as deep (30bb: 1.8% of first raises faced).
  Bot play (`allin-test.js --bots`, 6,000 hands, stacks 150/30/60/100bb rotating), friends / v10 / v8: all-in share of
  every raise faced at 30-60bb 0.061 / 0.085 / 0.040, at 60-100bb 0.020 / 0.026 / 0.014, at 100-200bb 0.004 / 0.007 /
  0.005; jams over one raise at 150bb 0.54% / 0.69% / 0.65%; all-in hands' median class rank 0.40 (n 7) / 0.26-0.35 /
  0.06; re-raise share 0.08-0.11 / 0.11-0.125 / 0.10-0.115. The forced shoves stay (a re-raise to 40%+ of the stack is
  all-in), so short bots still shove some value hands. The sim's stacks are 150bb unless `--stack` or `--seat-stacks`
  say otherwise; jams are rare there, as with the friends.
  What it judged: v1.8.17's all-in re-raise read (`SHOVE_RANGE`) lost -10 ± 6 bb/100 on v8 (5-handed, v1.8.13 to
  v1.8.17), mostly calls against v8's tight 150bb shoves. On v10, main d9d23a3 with `{"shoveRange":false}` against
  `{}`, 5-handed, live budget, 1,000 deals each: 150bb (seed 3850) +8.4 ± 8.3, two bot seats at 40bb and 80bb
  (`--seat-stacks 40,80`, seed 3871) +5.2 ± 9.8, pooled about +7 ± 6. Hands whose first difference is calling a jam
  hero used to fold: 5 at +47bb a hand at 150bb, 31 at +7.3 ± 2.9 with the short seats. Files:
  sims/2026-11-05-v10bots/ in the project folder.
* Friend bots v11 (5 Nov; `BOTPROFILES=test/sim/profiles-v11.json`): v10 plus `heroHuCut` 0.12. The first heads-up
  answer to a flop or turn bet by the hero seat moves the continue cut up by 0.12. Why: replaying every log through
  `range-test.js` (first answers to bets, not re-raised), the friends fold to Marwin's heads-up flop and turn bets 46%
  (n 110; under 45% / 45-85% / 85%+ pot: 38 / 50 / 67%) and to each other's 41% (n 187), and they fold about as the
  solver's read says (audit, 4 Nov: slope 0.96 ± 0.36). The v10 bots facing the solver (`fold-cal.js` with
  `--entries`, then `range-test.js` on those hands; 4-handed, live budget, seed 3901, 1,000 deals) folded 33% (n 1,191;
  18 / 43 / 41%) and to each other 34%, and everyone folded to the solver's heads-up flop and turn bets 31% where it
  predicted 43% (n 974). So the sim scored hero's flop and turn bets against players who call them more than the
  friends do. The same deals with v11: first answers to hero 43% (n 1,168; 28 / 53 / 52%), everyone folded 43% against
  46% predicted (n 932, slope 1.06 ± 0.13); answers to the other bots (34%), hero's multiway bets (16 / 18%) and river
  bets (41%, the v9 habit) as before. Plain bot-against-bot play is v10's. `fold-cal.js` prints this table for any
  bot file; `range-test.js` rows now carry `cb` (the bettor raised last before the flop; it explains none of the gap).
  Files: sims/2026-11-05-v10bots/v11/ in the project folder.
* Friend bots v12 (5 Nov; `BOTPROFILES=test/sim/profiles-v12.json`): v11 plus `leadHu` [0.37, 0.49]. Heads-up on the
  flop or turn, a bot that is first to act before the street's aggressor (the preflop raiser on the flop, the flop's last
  bettor on the turn) bets 0.37 / 0.49 times as often, every hand alike. `node test/sim/lead-test.js` on every log to 5 Nov
  (786 hands) and on bots against each other (12,000 hands, 4-handed, 150bb):

  | lead into the aggressor     | friends     | v11 bots     | v12 bots     |
  |-----------------------------|-------------|--------------|--------------|
  | flop heads-up               | 0.112 (89)  | 0.306 (1183) | 0.117 (1183) |
  | flop multiway               | 0.184 (158) | 0.228 (1916) | 0.228        |
  | turn heads-up               | 0.130 (92)  | 0.257 (1233) | 0.128 (1282) |
  | turn multiway               | 0.179 (56)  | 0.143 (746)  | 0.143        |
  | river heads-up              | 0.309 (68)  | 0.309 (985)  | 0.309        |
  | flop after the raiser checked | 0.244 (90) | 0.249       | 0.249        |
  | flop as the raiser (c-bet)  | 0.420 (169) | 0.384        | 0.389        |
  | turn as the flop's bettor   | 0.617 (149) | 0.551        | 0.559        |

  Only the heads-up flop and turn leads were clearly off (z about 5 and 3); multiway and river spots are within noise
  and keep v11's play. The same scale for every hand, not a shift in log-odds: the friends' shown leads are about as
  strong as the bots' (mean made-hand percentile 0.78 vs 0.78 on the flop, 0.76 vs 0.77 on the turn, all lead spots),
  and a log-odds shift (-1.6 / -1.2 fits the same rates) leaves the strong hands leading and makes the leads stronger
  (heads-up shown flop leads at a made-hand percentile of 0.80, against 0.73 with the scale and 0.74 for the friends, n 6). This came out of a slow-play check (do the friends check strong hands
  more than the bots?): by made-hand percentile, their first actions after the flop are about as aggressive as the
  bots' when checked to and facing a bet, in hero's pots and in the rest; the one sign of trapping is strong hands
  (0.9+) on the flop in hero's pots, which bet 31% (n 55) against the bots' 43% (z about 1.7), part of what the
  checked-to-before-the-raiser habit covers. Plain bot-against-bot play is otherwise v11's; the view the bots see now
  has `prevAgg` (the street before's last bettor or raiser) and `prevAggActed`. Files: sims/2026-11-05-v10bots/v12/ in
  the project folder.
* Regulars only, v12r (5 Nov; `BOTPROFILES=test/sim/profiles-v12r.json`): **the main check for solver changes.** The
  seven regulars Marwin usually plays, one bot each (v12's profiles; for a regular seen under several names, the
  profile with the most hands): f1, f2, f3, f4, f5, f11, f23, plus `pool` and `hero`. v12's 24 profiles include 8
  one-session players and several profiles for one account (one regular has five). Regulars were matched by the
  account ids in the raw events (names map in the project folder). All logs to 5 Nov, first answers to heads-up flop and
  turn bets (range-test.js rows, which now carry `who` and `t`): regulars fold to Marwin's 46% (n 74; the v11 target),
  to each other's 38% (196); the other players fold to Marwin's 36% (120), mostly one heads-up opponent on 5 Nov at 24%
  (51). Regulars lead into the aggressor heads-up 15% (48) on the flop and 13% (61) on the turn; v12r bots against each
  other 12% / 11%, multiway 19% / 14% (regulars 18% / 17%). Bot against bot (range-test.js --bots, 3,000 hands), the
  answers to the other bots' heads-up flop and turn bets fold 35% (v12: 40%).
* `solver` (or `solver@REF` for src/ of a git ref): the solver itself in a bot seat, with its own tracker that
  watches the table from that seat (its own hole cards, reads on everyone including hero), like a friend running
  the same overlay. Mix with friends as a comma list, e.g. `--bots solver,home:f4,home:f2`. Use it to check that
  a change does not only exploit the bots. It costs a solve per decision in every solver seat, and its decisions
  get no luck correction (its strategy isn't known in closed form), so expect more noise. Each A/B variant plays
  against its own copy, since the copies learn from hero's play. With solver opponents the warm-up puts the solver
  (variant A's code) in hero's seat too, so the copies' reads of hero come from solver-like play; with a simple
  player there instead, self-play came out about +70 bb/100 for hero, because the copies read hero wrong.
* `xp:<preset>[@<base>]` (red team, 3 Nov): an exploiter seat, a friend bot (`home:pool` unless `@<base>` names
  another) with one tendency pushed hard (test/sim/exploiters.js `PRESETS`): `leadbluff`, `bigvalue`, `xraise`, `trap`,
  `jam`, `overcall`, `vraise`, `riverover` (4 Nov: checked to on the river, bets 3, 5 or 10x pot with strong hands
  half the time and air 5% of the time, like the friends' shown river overbets; the friend bots never bet over 2x),
  `riverbluff` (the same sizes with air 30% of the time), `none` (the plain base, for comparisons), the older
  exploit.js presets, and
  `switch<period>` (loose and tight in turns, every `period` hands, default 100). Seat it with the block's friend
  lineup: `--bots xp:trap,friends`. `--seat-stacks 20,150,...` sets the bots' stacks in big blinds. To see what an
  exploiter costs hero, run `xp:none,friends` on the same seed and pair the two A variants with
  `ANY_BOTS=1 node test/sim/diff.js none.json:A xp.json:A`; to see whether a read assumption is what it beats, run the
  A/B with that assumption turned off. `node test/sim/xp-check.js <preset>` prints the actions a preset changes.
  Solver options for these runs only: `_forget {id, every}` deletes one seat's read every `every` hands (a friend back
  on an unlinked account), `_decay` sets the tracker's per-hand decay.
* `typical`, `station`, `maniac`, `mixed`: the old simulators' bots (same decisions), for continuity.

River EV check (4 Nov): env `RIVERDUMP=<file>` on run.js appends one JSON line per heads-up river decision of hero's
facing a bet (solver input, options and EVs, every seat's hole cards, the hand's log and hero's net), and
`node test/sim/river-check.js <file> [variant]` compares the solver's call and raise EVs with what the bots' real
hands made of them: calls have an exact value once the bettor's cards are known, so the paired gap (what the raise
brought - what a call would have) - (raise EV - call EV) shows whether raise EVs are too high against calling, apart
from how good hero's hand is.
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
