# Engine switches

One line per behavioural switch in `createAnalysis`'s input (src/engine.js), so a review can see what is on, what each
was decided on, and what would change the decision. Budget and size knobs (iterations, samples, time limits, bet menus)
are left out. CLAUDE.md has the full story for each (search its name). Written 11 Nov 2026 (v1.8.41). Update a row
when its switch changes.

Columns:
- **default**: what the extension plays.
- **decided on**: the evidence it went in or stayed out on, with "logs" for hand-log evidence and "sim" for the
  simulator (live budget, B - A bb/100, pooled ± SE, unless noted).
- **would change it**: what the notes say to watch for.

Merge bar (5 Nov): a sim win, or clear log evidence with no real loss in the sim when the bots lack the habit.

## Preflop

| switch | default | since | decided on | would change it |
| --- | --- | --- | --- | --- |
| `preflopSolver` | on | | sim multiway +39 ± 18 (2,000 deals); heads-up about neutral (+2 ± 10) | |
| `preflopMultiway` | on | | sim (with the solver, above); refit bots +31 ± 18 | |
| `pfFlopEdge` | 0.06 | v1.8.13 | TD audit 4 Nov (opens +4.7 ± 1.2bb, n 86); sim 12 runs about +44 ± 7 | the flop-edge ledger (audit 10 Nov: added hands won about nothing at the table; 84 of 200 hands) |
| `pfFlopEdgeMw` | 0.10 | v1.8.32 | TD multiway raises +3.18 ± 0.96bb; sim 0.10 vs 0.06 about +45 ± 16. 0.14 (v1.8.36-38) pooled +10 ± 11 over eight runs, so back to 0.10 | measured flop values at the leaves (audit finding 8) |
| `pfFlopEdgeAggr`, `pfFlopEdgeAggrHU` | unset | sim only | raise-or-fold edge: about -8 ± 18 | |
| `pendingTilt` | on at 3+ handed, off heads-up (`pfHeadsUp`) | | off at 3+ handed: -9 ± 17 (6 Nov), -27 ± 15 (8 Nov). Off fits the logs better (10.8 nats, 240 raises) | a sim that matches the friends' folds to hero's opens (table check row C) |
| `pfLimpCurve` | off at 3+ handed, on heads-up (`pfHeadsUp`) | v1.8.24 (off v1.8.26) | logs: limpers' folds by raise size, -222.5 to -180.1; sim five runs +8.2 ± 9.8, 4-handed about -13 ± 15 | as pendingTilt |
| `pfHeadsUp` | on | v1.8.35 | logs two-player tables: -176.1 to -139.1 (n 229); sim about +1 ± 16 (bots don't have Mark's habit) | |
| `vsOpenSplit` | off | v1.8.20 | reads-bench vs-open 0.932 to 0.923; sim neutral (+1.0 ± 2.3; v12 +8 ± 15) | more friends facing 8bb+ opens |
| `pfBigRaise` | on (heads-up only, `pfRaiseHUOnly`, up to `pfRaiseCapBB` 30) | v1.8.6 | sim +5.1 ± 3.9 heads-up; the multiway part isn't trusted | |
| `pfShoveBB` | 25 | | 40 lost: -41.8 ± 6.0 (whole table at 30bb) | |
| `bigCliff` (`bigCliffFloor` 0.25) | on | v1.8.3 | logs (96 spots: continues 67-72% to 35bb, 9% above); sim about +22 ± 10 | |
| `pfRaisedRead` | on (to 30bb, `pfRaisedReadBB`) | v1.8.4 | logs (raisers facing a re-raise fold 16%, n 45); sim with the cliff about +39 ± 8 | `pfRaisedReadBB` 45: neutral (+8.1 ± 9.6), off |
| `bigRaiseRange` | on | v1.8.15 | logs: 5 shown 30bb+ raises with chips behind; sim can't judge | more shown huge raises |
| `pfCommitCall`, `pfCommitRamp` | on | v1.8.15-18 | logs: players a third in called 3 of 3 | |
| `shoveRange` | on | v1.8.17 | logs: 5 shown all-in re-raises, +1.8 nats | |
| `deepShove` (`low` 20) | on, per player | v1.8.27 (low v1.8.30) | logs: Mark's 7 shown deep jams all top 14%; sim with a tight shover about +28 ± 6, plain regulars -3.3 ± 2.3 | |
| `allinTie` | 1bb | v1.8.25 | Marwin's ask; sim +11.7 ± 3.0 | |
| `pfCommit` | off | v1.8.10 | sim -24.5 ± 14.2 and -18.8 ± 18.0 | |
| `pfImplied` | unset | sim only | 0.5: -55.3 ± 18.0 | |

## After the flop: reads of ranges

| switch | default | since | decided on | would change it |
| --- | --- | --- | --- | --- |
| `chipTilt` | on, per player (`CHIP_TILT` slope 0.14) | v1.8.40 | shows: +20.2 nats over the narrow tilts (778); sim no-loss, about +12 ± 11; at 60bb and 300bb about +6 ± 9 | shown hands in big pots; replaces the three below |
| `heroPotTilt` | replaced by chipTilt | v1.8.9 (per player v1.8.32) | logs: shows in hero's pots at 0.74 (n 23); sim -4 ± 5 on bots that don't trap | only with `chipTilt: false` |
| `overbetTilt` | replaced by chipTilt | v1.8.14 | logs: 9 shown 3x+ river bets at 0.68 | only with `chipTilt: false` |
| `riverRaiseTilt` | replaced by chipTilt | v1.8.19 (per player v1.8.32) | logs: 21 shown river raises at 0.64-0.69 | only with `chipTilt: false` |
| `checkBetTilt` | on, per player, showdowns only, 0.3 | v1.8.28 (v1.8.36) | logs: hero's heads-up river check-calls won 0 of 11; sim no-loss, about +2.7 ± 3.5 | `tree` (off): -7 ± 11 |
| `afterCall` | on | v1.8.7 | shows: turn leads after a call x2.07 to x3.30; sim +8.1 ± 6.4 | more shown leads; phone budget not run |
| `bigBetMedium` | on | v1.8.2 | shows: pot-size bets x1.08 to x1.26; sim about +7 ± 6 | |
| `flopBigRaise` | off | | shows after big flop raises fit worse | more shown big raises |
| `raiseCallLine`, `reraiseLines`, `checkersFace` | on | v1.8.10 | logs (2 Nov); sim 13 runs about -0.8 ± 3.4 | |
| `initiative` | off | | logs: check-or-bet log-loss better out of sample; sim six runs about +1 ± 9 | |

## After the flop: answers to bets

| switch | default | since | decided on | would change it |
| --- | --- | --- | --- | --- |
| `storyCentre` | 0.05 (heads-up) | v1.8.34 | logs: -295.5 to -290.4 (465 answers); sim no-loss, about -7 ± 9 | |
| `mwBetFold` | odds x2, per player | v1.8.28 (v1.8.29) | logs: everyone-folds at 40%+ pot 0.28 to 0.47 predicted, 0.47 done (n 34); sim +9.1 ± 14.3 | |
| `riverMadeCall` (`turnMadeCall`, `planMadeCall`) | 0.55 | v1.8.19 | logs: hero's heads-up river bets -21.8 to -13.5 (n 30); sim on bots with the habit +31 ± 13 | |
| `checkLine` | on | #47 | logs: face log-loss 0.895 to 0.877; sim neutral | |
| `aggroFold` | 'unacted' | | sim +9.9 ± 17.7 against 'all' | |
| `overcallFold` | 1.3 | v1.7.7 | logs (37 spots); sim +16.6 ± 9.9 | |
| `commitFold` (`commitHUOnly`) | on, heads-up only | v1.8.10 | logs (750 decisions); sim heads-up-only 33 runs +5.2 ± 3.0 | |
| `nearAllIn` | 0.9 | v1.8.10 | sim five runs +1.0 ± 2.7 | |
| `reraiseRaiserFold` | 0.25 | v1.8.10 | logs: 0 of 9 folded; sim nine runs -1.6 ± 2.3 | |
| `reraiseModel` (`reraiseAgg` 2x) | on | v1.7.3 | sim about +28 ± 16 (4-handed), +14 ± 23 heads-up | |
| `raiseAggFold` | 0.55 | v1.7.4 | logs: raised bettors folded 6 of 19; sim +22.6 ± 20.6 4-handed | |
| `raisePrice` | on | v1.8.13 | the 4 Nov QQ spot (a 1-chip all-in read as a full raise); 2 of 1,017 decisions change | |
| `riverRaiseFold` | off | | sim about neutral; changes no logged decision | |
| `respDraw` | off | | logs fit better; sim pooled -6 ± 12 (v9), +13 ± 16 (v12) | |
| `mwRaiseEq` | unset | sim only | three runs about neutral | |

## Solvers and lookahead

| switch | default | since | decided on |
| --- | --- | --- | --- |
| `riverSolver` | on | | |
| `turnSolver` | computer only | | sim heads-up neutral at the live budget (+3 ± 11) |
| `flopSolver` | off | | sim 4-handed -39.4 ± 16.7; heads-up +1.0 ± 28.8 |
| `lookahead`, `lookaheadChecked` | on | lookaheadChecked v1.7.9 | lines by what each player did (v1.7.0) +27 ± 15 4-handed; checked lines about +9 ± 10 |
| `blueprint` | off | | sim 3-handed -9.6 ± 18.9, 4-handed -25.5 ± 13.7 |

## Not built

- A "facing hero" level in the read's fold fits (audit finding 3, 11 Nov): no better out of sample.
  /mnt/project-files/patio-solver/scripts/2026-11-11-facehero/.
