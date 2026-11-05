# Patio Solver: notes for Claude

Live solver overlay for **Poker Patio private lobbies** (pokerpatio.com/mp). The owner plays with a small group of
friends who all use helpers; everyone has agreed to it. The overlay is **read-only advice**. Keep it that way:
never add code that clicks, sends `player:game:perform_action`, or otherwise plays for the user. Keep the
`tableType === "private"` gate, so it never runs at public tables with strangers.

## Layout

```
src/engine.js            The solver (exploitative Monte Carlo + CFR solvers). Pure JS, no deps. Shared by both builds.
                         Holds the 169x169 preflop equity table (`PF_EQ_B64`, written by scripts/preflop-equity.js).
                         The river, turn, flop and preflop solvers' inner loops also run as WebAssembly SIMD kernels
                         assembled at load time (`cfrK`, `terminalK`, the turn solver's showTurn/foldTurn kernels and
                         per-card data, the flop solver's river-bet sweep; JS fallback, `useKernels(false)`),
                         bit-identical to the JS loops. Any change to CFR or leaf code in riverSolve/turnSolve/
                         flopSolve/preflopSolve (cfr loop, showAdd, foldValues, riverExtra) needs the same change
                         there; the "kernels: ... bit-identical" test catches drift for the spots it covers.
                         The manifest allows 'wasm-unsafe-eval' for this.
src/tracker.js           Socket events -> hand state, opponent tallies, solver input, linked reads. Pure JS, unit-tested.
src/userscript-core.js   iPhone/userscript UI + in-page socket hook + Web Worker solver.
extension/               Chrome MV3 extension (Load unpacked on this folder).
  hook.js                MAIN-world script: attaches socket.onAny, posts events + state snapshot via postMessage.
                         The socket is GameManager.roomConnectionManager.socket since the game's 3 Nov 2026 update
                         (GameManager.socket before; v1.8.10 and older never attach to the new game and the panel
                         stays on "Connected. Advice starts with the next hand."). Since v1.8.12 a watchdog posts
                         `hook:health`: 'nosocket' (a table on screen, no socket for 15 s) or 'silent' (the chips move
                         twice over 20 s with no socket event); both panels show a red dot and say Poker Patio may
                         have changed (advice still runs). test/harness-watchdog.js checks both builds.
  overlay.js             Isolated-world panel (shadow DOM), owns the tracker, stores reads in chrome.storage.
  handlog.js             Hand log storage: one chrome.storage key per hand (unlimitedStorage), newest 1,000 kept.
  backup.js              A copy of the reads (and the newest 150 hands, no raw events) in pokerpatio.com's IndexedDB,
                         which survives removing the extension; a fresh install loads it (v1.8.5).
  background.js          Service worker. Forwards solves to the offscreen page (falls back to analyzeSync itself).
  offscreen.js/.html     Full-power mode: pool of solver-worker.js Web Workers (cores - 2). Each runs a Monte Carlo
                         share with `partial: true` (and, heads-up on the turn, its own turn solve for `turnMs`:
                         10% of the time left on the game's clock, 1-1.5 s, 1.5 s if unknown; the clock is 23 s), with
                         its own river-card samples; one final analysis with `merge` adds the tallies, averages the
                         turn solves (`solvedMerge`) and runs the preflop and river solvers. Budget = POWER x the
                         phone's (24x MC, 8x plan samples, 16x river and 4x preflop iterations). The overlay shows
                         only the full solve: the quick read (phone budget on one more worker, shown first) was
                         dropped in v1.8.0 at Marwin's request; if hero acts before the full solve, nothing is shown
                         or logged for that decision (older logs may carry `advice.quick`). The tracker's `turn`
                         event carries `timeLeftMs` for `turnMs`. With
                         `FLOP_SOLVER` on, flops get the same treatment as turns (`flopSolver`, `flopTimeMs`).
  slim.js                Shrinks a result for the overlay (used by background and workers).
  engine.js, tracker.js  COPIES of src/ written by the build (blueprint.js too). Edit src/, then run the build.
  blueprint-{3,4,5}max.bin.gz  Trained self-play blueprints (150bb), loaded by the panel; not in the dist zip.
dist/patio-solver.user.js       Built userscript (Userscripts app on iOS Safari, Tampermonkey, Violentmonkey).
dist/patio-solver-extension.zip Built extension zip.
docs/protocol.md         What the game's socket sends. Read this before touching tracker.js.
src/blueprint.js         Blueprint lookup (history, seats, heroName, startStack from solverInput).
blueprint/               trainer.c (MCCFR self-play trainer), run.sh (chunked training that resumes), publish.sh,
                         coverage.js, README.md (training runs and numbers).
test/                    replay.test.js and blueprint.test.js (node), fuzz.js (random spots and random socket hands
                         for property tests), Playwright harnesses, recorded + synthetic fixtures
                         (synth-showdown.json: heads-up hand that ends with the opponent's cards shown;
                         real-multiway-flops.json: three real 3-4 way flop inputs, names removed).
                         sim/exploit.js: friend bots with one tendency pushed hard (river bluffs, light 3-bets,
                         overbets, barrels, `sticky`: punishes hero's postflop raises, or `adapt`: all pushed as far as hero over-folds) and what calling each
                         bet hero faced would have been worth.
```

## Commands

```
npm run build            # copies src/ into extension/, builds dist/ (bumps manifest version from package.json)
node scripts/preflop-equity.js   # rebuilds the preflop equity table in src/engine.js (~1 min on 4 cores)
npm test                 # node replay tests: real recorded hand + synthetic 3-handed hand
npm run test:extension   # loads the real extension in Chromium on a fake pokerpatio page, replays a hand
npm run test:mobile      # runs the userscript on an iPhone-sized fake table, replays a hand
node test/sim/run.js ...  # THE simulator for measuring changes: duplicate deals, AIVAT luck correction, paired A/B
                         # (--a-opts/--b-opts JSON or --a-ref/--b-ref), bots fitted to Marwin's friends. Read
                         # test/sim/README.md. Read aivatBB100 ± aivatSE100 (diff.* for A/B).
                         # --budget live (the computer's full solve: phone budget + turn solver at 100 iterations)
                         # and --budget phone: judge every solver change at live, and run both for any change
                         # touching flops or turns. The default (3,000 Monte Carlo, 120 river) is for quick checks.
node test/bench.js       # engine speed; --ref <git ref> checks results are bit-identical (speed changes must be)
node test/reads-bench.js <logs>  # how well reads predict actions and shown hands (see Known gaps)
node test/fit-priors.js <logs>   # refits the home-game read prior (READ_PRIORS.home) from hand-log exports
node test/replay-log.js <log> [hands] [--vs <checkout>]  # re-runs the solver at every hero decision of an export
npm run sim              # old heads-up simulator (kept for continuity); see test/sim.js for args
node test/sim-multi.js <hands> <solver|baseline> <3-6 players> <station|typical|maniac|mixed> <seed>
                         # multiway simulator; DUP=1 (default) replays each deal from every seat, DIAG=1 logs decisions
                         # both sims: PF=0 (preflop solver off), PFIT=n, TURN=1 (turn solver on, TURNIT=n), TAG=name;
                         # sim.js DUP=1 plays every deal twice with seats and cards swapped
```
Playwright harnesses write screenshots to `test/out/` (gitignored). Always rebuild before the browser harnesses.

## Things that are true about the game (see docs/protocol.md)

- `makeBetValue` = chips added by that action. First bets on a street arrive as `actionType: "raise"`.
- `socket.onAny` fires before the game's handlers, so snapshots are pre-event. Stacks in the snapshot at
  `game:player_turn_started` are current.
- Hero's hole cards: ids from `game:cards_dealt_to_player` for hero's `posType`, values from `game:update_card_data`.
- Board: `game:cards_deal_to_stack` with `stackID: "community_stack"`.
- New hand = `game:stage_began` with `stageType: "set_blinds"`. End = `showdown` stage / `game:game_ended`.

## Known gaps / ideas

- Seat order (verified on Marwin's live 3-5 handed tables): seats run in ascending number, except `s3_v2`, which
  sits between s9 and s10 (seatKey 9.5). `seatOrder()` pins SB, BB and UTG from `game:dealer_updated`
  (`h.sbPos/bbPos/utgPos`); 111 of 111 logged hands match the server's action order.
- Chip accounting: inputs `heroBet`, `opponents[].bet` and `opponents[].heroIP` (hero acts after them). `potWin` (in
  the result) is the pot minus the part of a bigger bet hero can't match (`uncalledChips`); potOdds and every solver
  use it. Opponents with stack 0 can't fold; `realize` isn't applied when nobody can bet any more; calls and raises
  charge only what each opponent still owes on the street; `playOut` takes a `room` cap for the opponent's chips.
- Side pots: modelled at showdown when the tracker passes `heroCommitted` and each opponent's `committed`/`stack`
  (`sidePotWin` in engine.js; `hasSidePots`). The multiway solvers and the multiway lookahead use `multiwayStack`:
  they still run when hero can match the bets it faces and every player with fewer total chips (committed + behind)
  has at least 1 (river), 2 (turn) or 3 (flop) pots behind, with the stack capped at what the shortest can match;
  otherwise the Monte Carlo with sidePotWin decides. (Gating on hasSidePots alone blocked every multiway turn and
  river in Marwin's 5-6 handed log: a player who had just bet counts as shorter by chips behind.)
- Lookahead (`makePlan`, `playOut`, `playOutMulti` in engine.js) runs on the flop and turn. Heads-up, either side
  can raise once per street (hero raises with about 80%+ equity against the betting range). Multiway is a betting
  round in seat order (hero first OOP, last IP) with one raise per street; after hero checks with players still to
  act, the current street is played first (checking is not a free card); once one opponent is left it hands over to
  `playOut` (with `from`). Hero only bluffs the river. Preflop has no lookahead; the preflop solver (below) covers
  the spots it can, and the Monte Carlo's `realize` (position, suitedness, connectedness, pairs, opponent count and
  stack depth) the rest. An opponent's thresholds on later streets come from the hands that would have played
  their line so far in the lookahead (called, checked, or bet: `plan.at(s, m)` with 2-bit `LINE_*` masks per
  street; the current decision's callers count as called, at their actual continue rate, `lineCont`), so each
  line folds, bets and raises at about the read's rate. Callers are only half narrowed (`LINE_SOFT` 0.5: the
  survivors are the continuing share plus half of the rest), because the logs show players who called once fold
  less than their read: after calling the flop friends fold 33% to a turn bet (27 spots), 51% after a checked flop
  (41); on the river 71% after calling the turn (21), 60% after a checked turn (48). The lookahead now gives about
  30% after a call and 62-68% on the river after a check. With whole-range quantiles (v1.6.0 and before) a player
  who had called the flop folded only 14% to a turn bet, so weak multiway stabs and raises looked good (J-high bet
  12 into 24 four-way); with full narrowing (read rate after every call) hero bluffed turns and checked top sets.
  On the current street players who already checked can't open the betting again.
  On later streets of the lookahead, a player who checks and then faces hero's bet answers from the hands that
  checked (below their betting cut, less the bluffs), at the after-check read (`stats.line.checkedFold`, #47), with
  hero's value and bluff checks against those hands too (makePlan `checked()`, `input.lookaheadChecked`; v1.7.9).
  Before, the cut was a quantile of their whole range on that street, and almost all the hands under it had checked,
  so checkers folded about 80% where the read said 63-68% (stab fixtures), which overpaid hero's IP bets and river
  bluffs after a call. Live budget, on vs off: 4-handed +17.9 ± 18.7, +18.2 ± 19.7 (Mac, seeds 301/302) and
  -2.5 ± 14.9 (cloud, seed 7), pooled about +9 ± 10 over 3,000 deals; heads-up +8.0 ± 27.5 and +29.5 ± 20.3 (pooled
  about +19 ± 17).
  Tried and dropped: narrowing a player who checks a later street and then calls hero's bet from the hands that
  checked (instead of their whole range on that street) for the next street. Live budget, on vs off, 1,000 deals each:
  4-handed +23.6 ± 15.4, +20.7 ± 14.5 (Mac) and -7.7 ± 16.1 (cloud), heads-up +22.6 ± 22.7, -52.0 ± 22.1 (Mac) and
  -25.0 ± 18.5 (cloud); all six pooled +1.6 ± 7.1 (rule set before the last runs: merge at +1 SE). The bots check-call
  with capped ranges anyway; in the logs, hands shown after a check-call are polarized (19 shows, quantiles in the
  predicted range mostly under 0.25 or over 0.75), so real check-callers keep more strong hands than that model.
  Tried and dropped: hero bluffing the turn heads-up in the lookahead, with the river's rule. It broke the
  multiway-stab guard test (a weak stab came out 4.9 chips over checking, from turn bluffs after getting called).
  Building the reads' check-call ranges from the checking hands (applyAction 'check' before 'call' in buildRange)
  scored shown hands on those lines worse (x1.64 -> x1.40, 19 shows; other lines unchanged).
- Preflop solver (`preflopSolve`): heads-up preflop spots (one opponent left, any action so far) and opens with
  2-8 players still to act (all pending; they are one "field" whose hand is the strongest continuing one,
  `fieldMax`; no open-limp option there). Discounted CFR over the 169 classes, compatible-pair counts from
  `preflopCompat`, O(169) blocker totals in `classMass`. Tree: hero's scenario sizes at the root, then pot-size
  raises and all-ins, up to 4 raises. Leaves: fold, all-in (table equity), flop (pot split by realized shares,
  `shares`: equity x 0.92 + strength, suited/connected/pair bonus, +-0.06 position, faded toward raw equity below SPR
  4, plus hero's postflop edge `PF_FLOP_EDGE` x t of the pot since v1.8.13, see Preflop flop edge). The opponent's fixed strategy uses the Monte Carlo's `sc.opp` cont rates at the first response and
  `continueRule` deeper; 3-bets from `stats.threeBet`. Phone 300 iterations, computer 1,200 / 0.8 s (4,800 / 2.5 s
  until v1.7.6: on all 103 logged preflop spots 600-2,400 iterations pick the same action as 4,800 and 300 differs on
  one near-tie, while 4,800 takes about 1.2 s against 0.33 s, so the full read now arrives before he acts).
  `vsOpenRead` reads `stats.vsOpen` ({small <=2.5bb, medium <=3.5bb, large} x {cont, threeBet}) when the tracker
  provides it, so learned defence by open size feeds both the Monte Carlo (`continueRule` via `kind.openTo`) and the
  preflop solver's first response. Without it the old size-blind rule (VPIP-based) is used.
  Every other multiway spot (limpers, a raise with callers, players behind; `fieldOther`) is solved against the field
  too: `preflopMulti` samples boards and opponents' hands once per decision and gives `kappa` per hero class (hero's
  K-way showdown share over the share against the field's strongest hand, same samples). At a flop or all-in leaf
  with k of K players in (kCall after hero's call, kRaise(amount) after hero's first raise, 1 deeper) hero's share is
  scaled by kappa^((k-1)/(K-1)) and the field's chips count k times. `preflopMultiway: false` sends those spots back
  to the Monte Carlo.
- Turn solver (`turnSolve`, computer only: `input.turnSolver === true`, heads-up, effective stack): turn and river in
  one Discounted CFR. Turn: hero 33/66/100% pot, opponent their size, one raise; each line that reaches the river gets
  a river subgame per card (built lazily; OOP first, hero 33/66/100% (was 50/100%: +17 ± 12 bb/100 pooled over two
  seeds of 1,000 4-handed deals, about 13% fewer iterations per second), one raise); each iteration samples 6 river cards
  (`turnRiverSamples`), the final pass uses all 48. Hero and opponent hands are indexed separately and pruned
  (hero < 3% of max weight, opponent < 1%). The opponent's river fixed strategy uses their read's reach along that
  line. Sizes are `turnBets`/`turnRiverBets`/`turnRaises` in the input (at most 3 bets or 2 raises, so a node has
  at most 4 actions). A half-pot raise for hero next to the pot-size one (`turnRaises` [0.5, 1]) lost -24.2 ± 15.1
  (1,000 deals 4-handed, turn solver on in both, v1.7.4). With the kernels about 50-100 iterations in 1.5 s in the
  cloud sandbox under load (more on simple spots); each offscreen worker solves for `turnMs` and the results are
  averaged. `turnMs` was about 7 s until v1.7.5, but Marwin acts in a median 2.4 s on the turn (p90 about 4.5 s, raw
  logs), so he almost always played the quick read; the solve picks the same action as 1,600 iterations 97% of the
  time by 100 (0.003 bb per decision; speed thread), so 1-1.5 s now gets him the full read in about 2 s. On the 43
  turn-solver spots of the 128-hand log against a 1,600-iteration solve: 40 iterations pick the same 38 (0.066 bb per
  decision lost), 75 the same 41 (0.020), 150 the same 42 (0.008); averaging 8 workers' solves of 40 or 75 picks
  exactly like one solve, so the workers add river-card samples, not convergence. 1.5 s is about 75 iterations on a
  hard spot here (uncontended, one core), 1 s about 40.
- Flop solver (`flopSolve`, computer only: `input.flopSolver === true`; the offscreen pool's `FLOP_SOLVER` turns it
  on, currently off): flop and turn betting in one Discounted CFR with the river checked down (leaves average the
  showdown over sampled rivers; `flopRiverBet` = beta replaces that with a crude river: the hand that is ahead bets
  beta x pot with probability b (its river strength in its range, `betCut`) and the other calls with c (opponent: the
  read's fold rate at that size, hero: pot odds), `riverExtra`). Each iteration samples 3 turn and 4
  river cards (`flopTurnSamples`, `flopRiverSamples`), turn subgames are built lazily per line and card, and the final
  pass uses every turn card with 10 rivers each. Hero bets 33/75% pot on the flop and 50/100% on the turn
  (`flopBets`, `flopTurnBets`), the opponent their size, one pot-size raise per street. Heads-up, or against the
  field (2-4 opponents, no side pots; `turnField` works on the flop too) with kappa^(0.4^bets) as on the turn.
  WebAssembly kernels (#24): in a 6 s worker budget 3-way 311-369 iterations, heads-up 303-528 (3.1-4.3x the JS
  loops), with about 50-230 MB of kernel memory per solve. Still off: on v1.7.4, 4-handed, 2,000 deals, flop solver
  with a 24,000-iteration Monte Carlo -39.4 ± 16.7 against the same Monte Carlo alone, and about -40 with the sim's
  3,000 (speed thread); heads-up (v1.7.7, 1,000 deals) +1.0 ± 28.8, so neutral there. The sim's 3,000 Monte Carlo
  iterations against 24,000: +1.4 ± 14.6 (the 64 ± 38 gap at 400 deals was noise).
- Hero's story: with `heroActions`, the engine builds hero's range as a solid regular's (`HERO_STYLE`). If that range looks
  stronger than average on the board, opponents' fold rates shift up (`credibility`, up to ±8%), on both the
  multiway and the heads-up reads (`o.statsHU`, which multiway first answers use since #39; #41 put the shift back
  there after #39 had dropped it; sim -13.3 ± 21.8, as expected with bots that ignore hero's line). The river solver
  models hero's range directly, so it does not take the shift.
  It plays each runout against 4 opponent versions (`VARIANTS`: as read, foldier, stickier, more aggressive) and
  blends in the worst one by `robustWeight` (larger when reads are thin). Scenarios with `sc.stress` (hero all-in,
  or every caller all-in) also shift the current fold decision in those variants; other bets don't.
- Multiway river (2-5 opponents, no side pots): `riverSolve` against the field as one opponent whose range is the
  strongest live hand, sampled jointly; it plays like the aggressor or the stickiest caller, with `fieldStats`: the
  field folds only if every player folds (`foldAtSize` multiplies each player's own heads-up curve, see Multiway fold structure; before v1.5.0 it used one
  player's fold rate and bluffed multiway pots far too often) and bets or raises if any of them does.
- Multiway turn (computer, 2-4 opponents, no side pots): `turnSolve` against the field (`turnField`: the live hand
  with the most turn equity, sampled jointly), with `fieldStats`. Hero's showdown share is scaled by
  kappa^(0.4^bets) (`cfg.multi`, `showMulti`): kappa is hero's river share against every live hand over the share
  against the field's hand, and each bet or raise on the way leaves only part of the other players in.
- River solver (`riverSolve` in engine.js): heads-up river spots (and multiway as above). Discounted CFR over hero's range vs the
  opponent's, with hero bets of 33/66/100% pot, the opponent's usual bet size and one raise. The opponent plays
  their read's strategy with weight `exploitWeight` and an adaptive one with the rest. Hero's range comes from
  `input.heroActions` (passed by the tracker) run through `buildRange` with `HERO_STYLE` stats. When it runs, its
  frequencies and EVs replace the Monte Carlo ranking, and the Monte Carlo is cut to 6000 iterations (equity only).
- River boards that are a straight or better by themselves: hands that only play the board call any bet
  (`boardPlayers`; Monte Carlo, river solver, turn solver's river subgames). They used to fold like air, so the
  advice bluffed into players who could only chop (Marwin's log, 2d7h on Jd Qc Tc 9h 8c).
- Counts decay 0.3% per hand a player is dealt into (`DECAY` = 0.997 in tracker.js, about 330 hands of memory; it
  was 1%, which forgot everything after ~100 hands), so they are floats. Round before display. Last 80 shows kept.
  On the 1 Nov session faster decay predicts facing-bet answers better (0.9: 0.861 -> 0.840) but preflop actions
  and shown hands worse; nearly all of that gain comes through the table size step (below), which the simulator
  needs, so DECAY stays.
- Preflop ranges are soft (`topClassWeights` uses a sigmoid edge, plus a small floor for every hand). Hard top-X%
  cut-offs gave zero weight to hands people really play (KQo raises at 8% PFR), which made reads predict shown
  hands worse than a random guess in the simulator and led to bad turn/river calls.
- Reads model (`computeStats` in engine.js): hierarchical Bayesian. VPIP, PFR (share of VPIP), bet, fold and raise
  (share of continues) are logistic random-effects fits (`fitFamily`): rate = sigmoid(mu_context + u + v_context),
  player effect u with a Student-t(3) prior (scale `tau`), per-context effects v (`tauC`). Contexts: position, street,
  c-bet, heads-up vs multiway (fold only; tally `stMw`, older tallies keep `stOld`). Other rates are beta-shrunk
  (`betaRate`). Priors live in `READ_PRIORS`: `home` (= `typical`, fitted on Marwin's three logs, 278 hands, with
  `node test/fit-priors.js <logs>`), `tight`/`loose` (shifted home), `solid` (the old typical; `HERO_STYLE`, used for
  hero's own range). `pool` (tracker `poolTally()`, every known player's counts) adds the table's own rates to the
  prior (`POOL_K` 120 pseudo-counts, minus the player being read). With the home prior the solver reads friends'
  ranges as wider and weaker than before: it opens more, re-raises more in min-raise wars and calls wider on the river.
- Multiway pots: `computeStats(..., { multiway })` uses multiway fold rates (friends fold more with others still in);
  createAnalysis also builds `statsHU` and `planFor` (playOut) uses it once everyone else has folded.
- `ctx.reraised` (opponent 3-bet or more preflop): fold rates x0.65 in odds (`reraisedFold`).
- `stats.vsOpen` { small <=2.5bb, medium <=3.5bb, large } x { cont, threeBet, n }: counted by the tracker only for
  players who had not acted yet; prior fitted on 78 responses (cont .75/.72/.49, 3-bet .30/.25/.17).
  Since v1.8.20 (`input.vsOpenSplit`, on unless false) answers to opens of 8bb or more (shoves included) go to a fourth
  tally bucket, `huge`, and are read with `callBig`; `large` holds 3.5-8bb opens only, and vsOpenRead blends the large
  rate into callBig from 5bb to 8bb. Before, one bucket covered 4bb opens and shoves, which friends answer very
  differently (all logs to 5 Nov, first answers: 3.5-5bb fold 49%, n 205; 5-8bb 54%, n 67; 8-15bb 65%, n 17; 15-30bb
  71%, n 14; 30bb+ 89%, n 28). In the 5 Nov heads-up session the two averaged out: 4bb opens read as folded 69%
  (actual 51%), shoves 68% (actual 88%). Reads benchmark, every log: vs-open log-loss 0.932 -> 0.923 (each seen-hands
  bucket better), nothing else moves. Log replay (1-5 Nov): 21 of 942 decisions change, all preflop near-ties
  (short-stack shoves with strong aces become raises, open sizes move a step). `stats.vsOpen.largeAll` is the old
  bucket (vsOpenSplit false is bit-identical to v1.8.19). Older reads keep their past shoves in `large`.
  Simulator, live budget, v10 bots, 1,000 deals each, on vs off: 4-handed 100bb +13.8 ± 16.7, 150bb +1.4 ± 22.1, 30bb
  -4.1 ± 6.2, 20bb +0.6 ± 3.0, heads-up 20bb +4.1 ± 4.9 (pooled +1.0 ± 2.3: neutral). At 20bb it shoves less first in
  (heads-up small blind 27% -> 21%, raises 49% -> 55%); at 30bb it mostly moves raise sizes (button isolation over a
  limper 3bb -> 6.5bb, -5.0 ± 2.4 bb a hand, n 22: the bots re-raise hero's iso-raises 19-36% at every size, while
  friends re-raise 8% of 3.5-5bb opens, 7% at 5-8bb and 0 of 17 at 8-15bb). Files:
  /mnt/project-files/patio-solver/sims/2026-11-05-opensplit/ (SHORT-STACKS.md).
- Range noise (`applyAction`): each line keeps a share `rangeNoise` (home prior 0.45, MAP per player from showdown
  likelihoods `nl` over `NOISES`) of hands that take it whatever their strength; on bets it scales with bluff share
  and bet size (`rangeNoiseAgg`). Without it shown hands scored worse than a random guess.
- Raise wars: 4-bet/5-bet ranges are the narrowed range plus ordinary hands (VPIP range); the ordinary share is
  clamp(2.2 x PFR/VPIP, 0.1, 1) x the narrow range's mass (`WAR_MIX` 2.2), so it differs per player.
- Turn and river raises keep only a quarter of the range noise, with no extra for small raises (8 of 10 shown river
  raises were strong).
  `input.flopBigRaise` (off) does the same for flop raises of pot or more: in the 31 Oct + 1 Nov logs 5 of 6 shown
  postflop raises of pot or more were top pair or better, and a 6.7x-pot flop check-raise shove (Aura Qd7d on Qs 7h 8s)
  was read as 31% no-pair hands. On that spot it only moves hero's equity 0.69 -> 0.67 (still a call). Not judged on
  the simulator: the bots pick postflop raise sizes independently of their hand (`raiseShove`), so they would score it
  against an assumption the logs contradict. On the reads benchmark (187 hands) it made shown hands after raises of
  pot or more fit worse (x1.25 -> x1.13, 6 shows; all shows x1.63 -> x1.62), so it stays off. Revisit with more
  shown big raises.
- Limpers facing a raise: tally `limpFaceN`/`limpFold`, `stats.limpFold` (prior 0.52, k 6; friends 29-86%);
  continueRule's preflop base for callers is 1 - limpFold (was 0.5). Simulator vs the limp-aware bots: -1.3 ± 20.7.
- `betcall` street action (bet, then called a raise): buildRange applies the call after the bet; counts as aggressor.
- Tilt: home prior agg 0, pas -0.15 (betting lines fit +0.15 but showdowns over-sample value there).
- Showdown-based reads move slowly (#60): `SHOW_VALUE_K` 30 pseudo-shows behind a player's value share of bets
  (`stats.valueShare`, was 5) and the home prior's range tilt penalty k 30 / kUp 100 (was 6 / 20). Per-player
  showdown fits overfit: shown hands were predicted worse the more a player was seen. Shown-hand likelihood on
  simulated bot hands x1.75 -> x1.80, real logs x1.69 -> x1.70 (players seen most x1.65 -> x1.70). Simulator
  +26.7 ± 14.5 (2,000 deals 4-handed). Ignoring showdowns in the reads altogether was +16.6 ± 16.5; per-bot action
  reads vs the table average came out about even over three seeds (+24 ± 20, +9 ± 21, -4 ± 21 for dropping them).
- Read accuracy: showdowns (`scoreShow`, `FIT_VERSION` 2, stale fits rescored a few per hand by `rescoreStale`) and
  every action (`tracker.predictor` = `makePredictor`, tally `pred` {n, read, pop}: log-loss of the read vs an
  average player). Trust = showdown hit rate x action score; exploitWeight = clamp((0.5 + 0.4 n/120) x trust, 0.3,
  0.95). The opponent's fixed strategy in the solvers gets weight exploitWeight, an adaptive one the rest.
- `test/reads-bench.js <logs>`: sequential prediction benchmark (log-loss by seen-hands bucket, open responses,
  shown-hand likelihood). `--engine=a,b` compares engines, `--from=<ISO>` scores only later hands. v1.4.0 vs the
  rebuild on three logs: actions 0.831 -> 0.787, seen 0-9 0.958 -> 0.879, open responses 1.31 -> 1.00, shown hands
  x0.73 -> x1.72 (on the 100 hands the priors never saw: 0.809 -> 0.776, x0.92 -> x1.45). Simulator: about +8 ± 12.
  Held-out on the 1 Nov session (59 hands, v1.7.9, read after the older logs): all actions 0.879 (v1.4.0) -> 0.851,
  facing bets 0.899 -> 0.861, shown hands x0.67 -> x1.41 (#60 alone x1.31 -> x1.41). Folds against hero's bets are
  on target there (residual +0.02 ± 0.31 log-odds heads-up). Refitting READ_PRIORS.home on all four logs moves
  nothing out of sample (vsOpen fitted on one session scores worse on the other than the hand-set prior, both
  ways: 1.026 -> 1.084, 1.011 -> 1.036); the full refit also made top set check 3-way (pfr blinds .258 -> .291).
  Not refitted. POOL_K 60/240, SIZE_K 32-512, SHOW_VALUE_K 15/60, fold tau 0.1-0.35: all within 0.003.
  Think time: slower checks show stronger hands (r -0.19 ± 0.09 per show, both sessions) but check speed does
  not predict folding to a bet afterwards (slope -0.17 ± 0.27, n 165), so it is not used.
- `foldAfterAgg` (tally `aggVsN`/`aggVsFold`): folding to a bet after having bet or raised earlier in the hand.
  When an opponent has an aggressive line (`aggroFold` in analyzeSync), plans and the river, turn and flop solvers
  scale fold rates by foldAfterAgg / foldToBet (about x0.7). Without it the solver floated turn bets with air
  planning river bluffs. The tally mixes a bettor facing a raise (folds about 25%; continueRule's raiseAggFold
  covers that) with players who bet an earlier street, and those fold MORE than the plain read once they check
  on the current street: friend bots 63% vs 49% (n 96; river 79% vs 53%), logs 67% vs 44% (n 9), where the scale
  said about 35%. Before they act on the street the plain read fits (bots 40% vs 43%, n 174; logs 50% vs 54%, n 10).
  So now (`input.aggroFold`, default 'unacted') the scale is skipped once they checked on this street;
  'all' is the old rule, 'none' drops it. Live budget, 4-handed, 1,000 deals: 'unacted' vs 'all' +9.9 ± 17.7,
  'none' vs 'all' -0.1 ± 23.4. Sticky exploiter (600 deals): +19.5 ± 15.0 and +12.0 ± 31.9; 'none' also dropped
  the scale in the plans' later streets and brought the floats back (51 river bets after a turn call with under 30%
  equity, against 14; 'unacted' 19). In the turn solver's river subgames after an in-tree turn bet
  (`aggScaleIfAgg`) the scale still applies when they check the river: skipping it there too lost -23.1 ± 13.8
  4-handed (Mac, live, seed 311) against +16.8 ± 20.6 heads-up (seed 312), so it stays.
- Close spots return `mix` (two options with frequencies) and `best` is picked from it with the input `seed`, which
  the tracker randomizes per decision. Pass `mix: false` and a fixed `seed` for deterministic tests.
- `db.history` keeps the last 150 hands in the page; the extension stores each hand under its own key
  (extension/handlog.js, unlimitedStorage), keeps the newest 1,000 with raw events, and the "Hand log" export has all
  of them (#59). Each entry has `log` (every action in order with
  `amt` added, `to`, `pot` before it, `facing`, `stack` before it, `potPct` for bets/raises, blinds as `sb`/`bb`),
  each player's starting `stack`, `advice` (pot, price, equity, hand, top 5 options with EVs, reads, hero's actual
  action in `did` and `followed`), and `net`/`heroNet`/`heroNetBB`, filled in from the next hand's starting stacks.
- Preflop shoves and big raises (8+ bb): opponents continue at least at `stats.callBig` (tally `pfBigOpp`/`pfBigCall`,
  prior 0.75 x VPIP, clamped 0.18-0.45). The old size math had them folding 85%+ to a shove, so it shoved 9-5 at 25bb.
  Players already in the pot (limpers, raisers) get a higher floor. Hand log players carry `fit` and `accuracy`
  (`accuracySummary` in tracker.js); advice `reads` carry trust, accuracy, strengthBias and callBig.
  Big-raise cliff (v1.8.3, `bigFade`): the first time a friend faces a raise to 8bb+ in a hand they continue
  72/69/67% at 8-12/12-20/20-35bb, then 9% at 35-60bb and 4% above (96 spots, three logs; players already in the
  pot: 0 of 24 above 35bb). The callBig floors (pending, limper/raiser, BB seat, vsOpenRead's large opens) were
  size-blind above 8bb, so a 3-bettor facing a 4-bet to 50bb was read as continuing 75% like one to 26bb. Above a
  raise-to of 30bb the floors are multiplied by (30bb / raise-to)^2.5, never below 0.25 (`input.bigCliffFloor`;
  `input.bigCliff: false` turns it off). Simulator, live budget, 2,000 deals 4-handed: +26.3 ± 19.8 and +6.0 ± 19.6
  (bots with the cliff, seeds 501/502, vs v1.8.1), +22.9 ± 17.1 and +34.3 ± 19.2 (v1.8.3 bots, seeds 511/512, vs
  v1.8.2), +27.9 ± 20.0 on the old bots; pooled over the four about +22 ± 10, mostly good and medium hands opening
  and isolating bigger (a --diag run: small blind raises medium hands 43% instead of 15%, weak hands unchanged).
  On the logs it changes 20 of 331 decisions, all preflop (KK's 4-bet 86 -> 59 chips, JJ 58 -> 41, AA's 4-bet to
  111bb into three players unchanged: with the 0.25 floor a 3-bettor still continues about 19% there).
- Raisers facing hero's re-raise (`input.pfRaisedRead`, on since v1.8.4): the first time a raiser faces a
  re-raise in a hand the logs show fold 16%, call 42%, re-raise 42% (45 spots), and below 35bb fold 3% (n 39); the
  bots answer the same (25/32/43%). continueRule's raised branch had them folding 30-45% and re-raising about 12%
  (`0.55 x mdf / 0.5`, floor by callBig), and the reads' `foldTo3bet` / `fourBet` (home prior 13% / 50%) were
  computed but unused. Up to a raise-to of 30bb they now answer with those reads; bigger re-raises keep the old
  rule. Letting the read fade with size instead ((1 - foldTo3bet) x bigFade: 87% up to 30bb, 22% at 50bb+) scored
  +117 ± 38 against the bots but was an artifact: the preflop solver opened 93-98% of weak hands and 4-bet bluffed
  to 35bb+ into bots that fold to big raises and never adapt (--diag). The 30bb version plays like the cliff alone
  (weak hands unchanged). Simulator, live, 2,000 deals 4-handed, v1.8.3 bots, against the cliff alone: +43.7 ± 14.8
  (seed 512; premium +11.1 ± 4.6, good +17.5 ± 8.2, every seat up) and +45.5 ± 12.8 (seed 511; blinds +36, good
  +22.2 ± 7.7, weak +2.4 ± 3.4). On the old bots (no cliff: a raiser facing a re-raise above 35bb calls 64% where the
  friends folded 6 of 6) -10.1 ± 21.0 (seed 521, 1,000 deals; big blind -20.4 ± 10.3, medium -15.2 ± 10.7). Both bot
  sets answer re-raises up to 35bb alike (fold 28/25%, re-raise 46/43%), so the difference is in the tree below:
  re-raised about half the time, hero meets more 4-bets and shoves over them more (--diag, phone: good hands 9 -> 19%
  of those spots, medium 0 -> 11%), which pays only if big re-raises get folded as in the logs. Seed 513 (Mac):
  +27.0 ± 14.7 (button +12.7 ± 6.2, early +17.1 ± 9.1, weak -6.7 ± 4.1); the v1.8.3 bots without the cliff
  (BOTCLIFF=0, seed 514): +8.0 ± 15.0 (premium and strong flat). Pooled: with the cliff about +39 ± 8 (three seeds),
  without it about +2 ± 12 (two), so it costs nothing where big re-raises get called and gains where they get
  folded, as the friends do. Heads-up (seed 515, Mac): +16.1 ± 14.2.
  The 30bb step moves 4-bet EVs by up to 8bb a chip either side of it (1 Nov, multiway AKo in the big blind: a
  re-raise to 29.5bb +55.6, to 30.5bb +38.7 chips; the opener went from continuing 93% / re-raising 36% to 72% / 11%).
  `input.pfRaisedReadBB` (v1.8.17; default `PF_RAISED_READ_BB` 30, the step) above 30 fades the read into the old rule
  from 30bb, gone at that raise-to. All logs (519 hands): friends continued against all 5 re-raises to 30-45bb (call 3,
  re-raise 2) and folded to 7 of 9 above 45bb. With 45, 22 of 1,017 logged decisions change, all preflop and nearly
  all near-ties among open sizes (the solver's 4-bets deeper in the tree get answered more); KK's 5-bet over Aura and
  Jagger (#152) 41 -> 59 chips. Off until the simulator has judged it.
- Raw recorder (`recordRaw` in tracker.js): each hand-log entry has `raw`, every game event of the hand
  (`{ t: ms since set_blinds, ev, d, s?: [id, name, stack, pos, state, authUserId] }`; the account id since
  v1.8.1), for the newest 100 hands (60 on the
  userscript, whose localStorage is shared with the game; `save` drops raw first when full). Both hooks forward all
  `game:`/`player:game:`/`admin:game:` events and `game_log` chat for this; the tracker ignores unknown ones.
  Replay a raw hand by feeding `d` back through `handle`.
- Import (v1.8.1, panel button "Import"): removing the extension in Chrome deletes its storage, so a fresh install
  starts with no reads and no hand log (1 Nov: Marwin deletes and re-adds it for every version, so the reads started
  from zero although Jagger and PermPetch were 31 Oct's phuketdemon and MaPokerrk). Updating in place (same folder,
  reload arrow on chrome://extensions) keeps everything. Import adds the hands of hand-log exports to the stored log
  (`handLog.addHands`, newest 1,000 kept) and rebuilds the reads by replaying every stored hand with raw events
  (`PatioTracker.rebuildReads`, about 15 ms a hand). Older logs have names only: a name maps to the account id its
  chat lines carried that day, else to the id the current reads use for that name, else "name:<name>". A current
  read with clearly more hands than the rebuilt one (history beyond the stored log) is kept. The tracker takes its
  time from `now()` (`tracker.clock` if set); the rebuild replays each hand on its recorded times, so think times
  (`tt`, shows' `ms`) come out as played (they were about 0 in v1.8.1's rebuild).
  Since v1.8.5 the panel also keeps a copy of the reads in the site's own storage (extension/backup.js: IndexedDB
  "patio-solver" of pokerpatio.com, which Chrome keeps when the extension is removed), written at most every 15 s.
  A fresh install (no reads in chrome.storage) loads it and says so on the panel, so Import is only needed for a new
  computer or browser profile. A copy that couldn't be read isn't written over, nor one with far more history than
  the reads replacing it (under half, unless "Reset reads" was pressed). `REINSTALL=1 npm run test:extension` wipes
  the extension's storage after the replay and checks the reads come back.
- Bet-size flag (v1.8.5): when hero bets or raises under 60% of the advised chips (the tracker's `sizeRatio`), the
  stale advice says so ("Smaller than advised: you put in $22 of the advised $42") and the panel counts it for the
  session. In the 31 Oct + 1 Nov logs hero's smaller bets cluster at a third of the pot and at the minimum bet, often
  with strong hands (min-bets with 94-96% equity against advised 50-150% pot); in the simulator, 4 in 10 strong bets at
  0.4x the advice cost about -87 ± 25 bb/100 (cliff bots, live, 1,000 deals).
- Bigger preflop raise heads-up (v1.8.6): with one opponent left, the preflop menu (toCall + f x (pot + toCall), f =
  0.6 / 1 / 1.6) also has f = 2.6 (`input.pfBigRaise: false` drops it), offered only while the raise-to stays at or
  under 30bb (`input.pfRaiseCapBB`), where friends stop calling raises. Logs: friends answer opens of 3.5-5bb and
  5-7bb alike (continue 55%, n 31; 50%, n 6) and limpers facing 3-5bb and 5-8bb alike (57% / 58%), so bigger value
  raises should get paid; nothing above 7bb was ever opened. Simulator, live budget, on vs off: 4-handed +3.7 ± 8.1,
  +13.5 ± 7.0, +2.7 ± 6.2 and 3-handed -10.2 ± 13.1, pooled +5.1 ± 3.9 (3-4% of hands change). Offering it multiway
  too (`input.pfRaiseHUOnly: false`) scored about the same in the first runs (4-handed +25.5, -4.5, +30.1, 3-handed
  +28.0, heads-up table 0.0; pooled +13.6 ± 9.7), but that minus unopened multiway pots (opens with 2+ players to act)
  scored -7.7, -23.6, -17.8 and -22.9 (pooled about -19 ± 9), which can't both hold, so the multiway part isn't
  trusted. Its field hand is the strongest continuing hand at the pot-size raise's continue rates for every size
  (`fieldMax` with `mid`'s conts), so it doesn't get stronger as the raise grows; a fix for that is its own thread.
  Without the 30bb cap the 2.6 size also went into 4-bets past the cliff (premiums 4-bet to 60bb+ 39% vs 9%, -13.2
  ± 4.7 premium on seed 652); uncapped 4-handed +13.2, +1.2, -14.3. Adding 4x and a 2.5x-pot option bet: -1.3 ± 20.4.
  `pfRaiseFracs` / `pfBetFracs` replace the menus for simulator runs.
- Bets after calling (v1.8.7, `READ_PRIORS.home.afterCall`; `input.afterCall: false` turns it off, an object replaces
  it): a turn or river bet by a player who only called the street before (a lead into that street's bettor, or a bet
  once checked to) is read with that line's bet rate (odds x0.43 on the turn's rate, x0.48 on the river's), no range
  noise and half the bluff share (`buildRange` passes `afterCall` to `applyAction`). Friends bet the turn after
  calling 13% of the time (87 chances) and the river 26% (77), against 25% / 48% after a checked street and 43% / 55%
  after betting it (all logs, 369 hands); the read used the street's whole rate (prior 26% / 42%) with about half the
  range random. Every turn lead after a flop call in the new logs was shown (4 of 4, none unshown: Q8 and T8 two pair,
  J8 turned top pair, J9 turned straight, all made by the turn card). Shown turn bets after a call fit x2.07 -> x3.30
  of a random guess (8 shows, mean quantile 0.78 -> 0.63), river x1.51 -> x1.54 (11 shows, 0.64 -> 0.50; river leads
  after a call also include unshown pot-size bets and one fold to hero's raise). Two pair or better in leballs' range
  on 2 Nov's K3o hand (Qs Kh 2s Td, 55% lead after calling hero's flop raise; he had J9) 25% -> 53%; the advice there
  went from all-in (equity 0.48) to fold (0.38 with the first version), and JJ calls instead of raising Jelonte's two
  pair. Simulator, live budget, against v1.8.6, 1,000 deals each, this version: 4-handed -15.1 ± 13.9, +10.2 ± 14.5,
  +32.7 ± 12.1, 5-handed +0.7 ± 11.2 (pooled +8.1 ± 6.4; premium hands -4.4 / -7.2 / +2.8 / -1.0 of it). The first
  version (noise x0.25, bluffs as read) pooled -0.1 ± 5.8 over seven runs (4-handed +19.7, -6.7, -2.7, +7.1, -29.5;
  3-handed -3.7; 5-handed +12.4), phone -13.4 ± 16.6; turn only +6.1 ± 15.8, -10.1 ± 15.6. The merged version's runs
  had the first version's prior in the showdown fits (scoreShow); not run at the phone budget. The bots' bets after a
  call are value-heavy too (`lineBet` -2.6 in log-odds). Results in /mnt/project-files/patio-solver/sims/
  2026-11-02-aftercall/ (results.txt). Revisit with more shown leads, and check the phone budget.
- Tried and dropped (2 Nov): no raise against a bet after the flop with 2+ opponents while hero's showdown share is
  under 0.5 (`input.mwRaiseEq`, kept as a simulator option): 4-handed +2.6 ± 8.2 and -0.1 ± 7.2, 5-handed -3.1 ± 8.6
  (4-5% of hands change). The exploit.js spot table had multiway raises at about -30 bb a hand against -8 for calls,
  but that compares hands, not choices.
- Tried and dropped (2 Nov night, live budget, bots refit on 458 hands with the commitment habits, profiles-v5):
  the preflop field by raise size (`pfFieldBySize`, `pfOpenMulti`, `pfCallField`, with `pfFieldRange: false`,
  `pfMeasuredFlop: false`; each root raise meets the strongest hand that calls that size, hero's multiway share
  measured on preflopMulti's samples): 4-handed +2.1 ± 15.2, 5-handed +11.7 ± 15.6 and +20.0 ± 18.4, 6-handed
  -19.5 ± 18.5 and -7.3 ± 20.0 (pooled +1.4 ± 7.9; preflop decisions nearly unchanged in --diag). On top of it
  the 2.6x raise multiway (`pfRaiseHUOnly: false`): 6-handed -53.0 ± 24.5 and -7.1 ± 30.4, 5-handed -20.2 ± 24.2
  and -34.1 ± 26.5 (pooled about -29 ± 13; raises move from 3-8bb to 8-20bb, early seats and medium hands lose).
  An in-pot fade (`pfBigInPot`: players already in the pot continue x (30bb / raise-to)^2.5 above 30bb like players
  yet to act, fully below a twentieth of the raise-to in, not at all from a fifth; logs: under a tenth in, 4 of 53
  continued, a quarter or more 4 of 5), with `bigCliffFloor` 0.1: +192 ± 49 at 6-handed on the v4 bots, an artifact
  (weak hands first in folded 24% instead of 95%, raised 64% instead of 0): with the bots' reads players with little
  in were read as folding about 97% to big raises deeper in the tree, so raising and then shoving over a 3-bet paid
  with any hand; with real reads it changes 2 of 361 decisions (2 Nov export) and 4 of 207 (31 Oct session 2).
  Code on the heroPotTilt PR's history (f7989af to 3972560), reverted there. The night's regression checks (v1.8.1
  vs v1.8.7, v4 bots, live): 6-handed +34.7 ± 21.2 and +106.7 ± 23.1, 5-handed +61.8 ± 23.5 and +42.6 ± 23.1
  (pooled +60 ± 11). At 6-handed (exploit none) no bet hero faced would have been better folded (every
  foldsWouldWin <= 0).
- 2 Nov night (v1.8.10, all from the 2 Nov log, -300 bb in 86 hands; hands where hero went against the advice at least
  once lost -188 of it, test/analyze-log.js). Every switch is a simulator option; results are live budget, B - A
  aivat bb/100, pooled with inverse variance, files in /mnt/project-files/patio-solver/sims/2026-11-02-commit/
  (RESULTS.md). None cleared the merge bar (a sim win); Marwin merged it on the log fixes (#83, 3 Nov).
  - Commitment read (`READ_PRIORS.home.commitFold` -1.8, `stats.commitOdds` in foldAtSize; `input.commitFold`): fold
    odds x exp(-1.8 x share of their stack already in), fitted on 750 friend decisions facing a bet after the flop
    (heads-up -2.3, multiway -0.9). On every decision: v6 bots 8 runs +0.7 ± 7.2, v7 2 runs -3 ± 14. On heads-up
    decisions only (`input.commitHUOnly`, default true): 33 runs +5.2 ± 3.0, by table size heads-up +35.8 ± 9.7,
    3-handed -0.8 ± 12.0, 4-handed +12.1 ± 5.4, 5-handed -2.5 ± 5.1, 6-handed -6.6 ± 7.1; weighted to Marwin's tables
    (3/4/5/6-handed 15/107/207/38 logged hands) +1.4 ± 3.4. The deep diagnosis thread's caveat: in big real pots,
    players passive on the flop hold stronger hands than the read (shown at about the 0.71 quantile), so "committed
    players fold less" may partly be "committed players are stronger", and this read keeps the range.
  - Raise then call a re-raise (`raisecall`, `checkraisecall`; `input.raiseCallLine`): the range is the raising range
    that continues, like betcall. Changed no hero decision in 5,000 hands (v5).
  - Re-raise wars after the flop (`betraise`, `reraise` from the tracker; `input.reraiseLines`) and players who checked
    and still owe the bet face hero's call (`input.checkersFace`): together 13 runs about -0.8 ± 3.4 (v6 and v7).
    2 Nov's K6 on 4-6-7 against a flop 4-bet: 0.61 -> 0.42 equity, shove -> call (Marwin folded).
  - Near-all-in bets (`input.nearAllIn` 0.9: a bet leaving under 10% of the effective stack is an all-in): 5 runs
    +1.0 ± 2.7.
  - A raiser facing hero's re-raise after the flop folds x0.25 (`input.reraiseRaiserFold`; friends folded 0 of 9): 9
    runs -1.6 ± 2.3.
  - Preflop chips-in (`input.pfCommit`, now off by default): -24.5 ± 14.2 and -18.8 ± 18.0 alone (v6), mostly the BB.
  - All of it together (pfCommit off, commitment heads-up only) against all of it off: 14 runs +1.2 ± 4.9 (4-handed
    +3.7 ± 8.3, 5-handed -0.6 ± 6.5, 6-handed +2.5 ± 17.4). Log replay against main: 17 of 361 decisions change on
    1-2 Nov, 5 of 207 on 31 Oct (replay-proposal-*.txt).
  - Friend bots v5/v6/v7 (test/sim/profiles-v5/v6/v7.json; README). v7's bigCall 0.18 makes their folds to bets in
    15bb+ pots match main's read as the friends' do (act - pred about 0; v6 bots were 8-10 points too sticky there,
    which flatters any read that lowers folds). Shown hands by the largest bet called (quantile in the read's range)
    match the friends at every size, so no v8 for call strength. What no bot setting reproduced: friends' hands in
    hero's 15bb+ pots after a passive flop show at 0.74 of the read's range (n 23), bots 0.50-0.59.
- Extra tally fields: `limpOpp/limp`, `f3betOpp/f3bet`, `donkOpp/donk`, `xrOpp/xr`, `wonSD/wonNoSD` (from stack
  changes), `tt` (think time per action kind). Shows carry `ms` per action. Not used by the engine yet.
  `node test/analyze-log.js <export.json>` prints hero results by kind of spot.
- Showdown reads only see hands that were shown, so they over-sample hands that got called. Bluffs that won
  uncontested are invisible unless the player shows voluntarily.
- Tally format (tracker.js `blankTally`): flat counts plus `st` (per street), `vs` (reaction by facing-bet size),
  `betSize`, 3-bet / c-bet counters, `sawFlop`/`wtsd` and `shows` (last 40 revealed hands with their bets).
  `upgradeTally` fills in fields for reads saved by older versions.
- Joining mid-hand: tracking starts at the next `set_blinds`.
- Reads are keyed by `authUserId` (anonymous guest ids can change if a friend clears their browser), so a name
  change on the same account keeps them (PermPetch -> PermPocket, mkorn777 -> SPECTATEMK in the logs).
- Linked reads (v1.8.8): a new account id is a new read. On 2 Nov Jagger came back as rM09... after 96 hands as
  fqJt... (31 Oct phuketdemon, 1 Nov Jagger), so his read restarted; Dew666 did the same on 1 Nov (63 hands as
  fphhq..., then J4Up...). On the 77 hand (2 Nov 14:31, his 17th hand on the new id) the joined read (112 hands)
  still says maniac (VPIP 65%, PFR 32% vs 64% / 36%) and still 4-bets preflop (raise 17.4 vs call 12.8, was 21.2 vs
  11.6, live budget); the flop changes from check to bet. Over the 2 Nov session from his first hand on the new id,
  joining from that hand changes 6 of 97 hero decisions with Jagger in the hand (phone budget, mix off). Records stay per id; `db.same[id] = root` puts
  ids in one group and every reader of a player (solver input, `scorePrediction`'s read, `scorer`, `rescoreStale`,
  the panels, the log's `pred`/`accuracy`) uses `readTally(id)`: the group's counts added up (`mergeTallies`,
  oldest id first, newest 80 shows). An unlinked player's readTally is its own tally object, so nothing changes
  for them (sim A/B against main is identical). Each id keeps counting into its own record and every id of a
  player dealt in decays once a hand, so a link can be split (`unlink`) without losing hands. Links are made only
  by hand (Marwin, 3 Nov: friends change names on a whim, so he approves): at each new hand `askLinks` lists
  players dealt in whose name (now or before, `seen[id].names`) another read used (`linkMatches`; generic
  Guest/Player names never match), and the panel asks "Same player as the older read?" (`link` / `refuseLink`).
  Two ids dealt into the same hand (`db.seen[id].met`, also learned from stored hands' raw snapshots by
  `learnSeats` for reads saved before v1.8.8) can never be linked; "Different players" and splits go in
  `db.notSame` and aren't asked again. "Link reads" on both panels joins any two (Dew999 -> Dew666 style changes
  of both name and id) or splits them. Import passes the links into `rebuildReads` and takes them back
  (`absorbLinks`). `tracker.linkReads = false` turns the seat notes and questions off. On the 31 Oct - 2 Nov logs
  replayed in order it asks exactly twice: Dew666 (1 Nov) and Jagger (2 Nov).
- Extension and userscript keep separate read databases (chrome.storage vs page localStorage).
- Blueprint (self-play MCCFR, 3/4/5-handed 150bb, 270-320M iterations; 4-handed exports preflop to turn, 5-handed
  preflop and flop): shown on the panel's "Blueprint (self-play)" line and in each hand-log advice as `bp`. It does
  not change the advice unless `input.blueprint === true`: blending it in lost in the friends simulator (3-handed
  -9.6 ± 18.9, 4-handed -25.5 ± 13.7 bb/100; blinds and premium hands lose; flop-to-river only, 4-handed,
  -31.5 ± 13.1 over 3,000 deals). See blueprint/README.md.
- Safety and legality (audit round 2): the private-table gate fails closed (a missing `tableType` counts as not
  private); the tracker takes the big blind from `admin:game:new_hand_started` (settingsBB), so a short-posted big
  blind doesn't shrink it; solver bets are at least the big blind. `test/fuzz.js` property tests: random spots give
  legal advice with EVs inside what can be won or lost and a solver's check EV >= 0; random socket hands through the
  tracker report the table's pot, price, stacks and seats.
- Solver EVs: when the root EVs are read, hero plays its best action at every decision below the root (average
  strategies there stayed near uniform where hero's hand rarely goes), and turn/flop subgames no iteration sampled
  play the current strategy. Frequencies and the chosen action are unchanged; only rarely played options' EVs rise.
- Re-raises in the Monte Carlo (v1.7.3, after the flop): when an opponent re-raises hero's bet, raise or call
  (`decide`'s `reraisedBy`), hero calls a pot-size re-raise (capped by both stacks) and the hand goes to showdown,
  or folds, whichever wins more over the deals that got re-raised (`rrN`/`rrCall` tallies, picked in `result()`;
  hero's hand is fixed, so it is one choice; `sc.callsReraise`). Before, hero folded everything under 0.8 strength
  (`heroStandsReraise`, still used preflop and with side pots) and played the rest as if just called, so a re-raise
  could only cost hero chips. A player who bet and gets raised re-raises at 2x their raise rate (`ctx.rrAgg`,
  `input.reraiseAgg`; logs: 3 of 11 flop bettors and 4 of 22 overall re-raised, against about 8% facing a first bet).
  Found by the audit thread: blocking flop raises with under 50% showdown share when called was +29 ± 12 on an older
  main, about +13 ± 10 pooled on d8e866e. This fix instead: 4-handed +40.5 ± 22.9 and +14.9 ± 22.2 on two seeds of
  1,000 deals (pooled about +28 ± 16), heads-up +14.2 ± 22.9 (1,500 deals; the gate was -17 ± 13 heads-up). Re-raise rate 1x instead of 2x:
  -20.8 ± 21.2 (4-handed, 1,000 deals). `input.reraiseModel: false` turns it off.
- Raised bettors fold less (v1.7.4): continueRule scales a raised bettor's fold-to-bet by 0.55 (was 0.75;
  `input.raiseAggFold`). Logs: a bettor who got raised folded 6 of 19 times (32%), called 9, re-raised 3; x0.75 gave
  about 45-50% at the usual raise sizes, so hero's raises (weak ones most) looked better than they are. Simulator
  against 0.75: 4-handed +22.6 ± 20.6 (1,000 deals), heads-up +11.7 ± 18.6 (1,500 deals). This is the cause behind
  the audit thread's flop-raise gate (pooled about +15 ± 9 on 3+ handed tables, -17 ± 13 heads-up), which is not merged:
  on top of 0.55 a multiway-only gate lost -18.6 ± 14.4.
- Friends' big bets are not stronger (`READ_PRIORS.home.bigBetMedium` {size 0.9, floor 1}; `input.bigBetMedium:
  false` turns it off): on bets of 0.9 pot or more every hand of medium strength or better (hs >= 0.35) bets at
  least at the player's bet rate (the `MEDIUM_BET` floor elsewhere is 0.3 of it), so a pot-size bet is no longer read
  as the top of the range plus bluffs. Logs (31 Oct + 1 Nov, 87 shown first bets after the flop): mean made-hand
  percentile 0.84 under 0.45 pot, 0.78 at 0.45-0.85, 0.70 at 0.85-1.2, 0.61 above, and 10 of 23 shown bets of
  0.85 pot or more were medium pairs. Shown hands after a pot-size or bigger bet x1.08 -> x1.26 of a random guess
  (22), all shows x1.58 -> x1.63 (both sessions up), action log-loss unchanged. Hero's own range (solid) keeps the
  old polarized rule. Less noise, a lower value share or a wider bet rate on big bets did not fit (the shown big
  bets were mostly medium pairs, not the draws and air the bluff slot picks). It changes 2 of 416 logged hero
  decisions (a pot-size flop bet called with bottom pair, a bigger preflop raise). The simulator's bots bet big
  with weaker hands only with `--bot-params '{"sizeTell":-0.6}'` (test/sim/README.md); at the default they are flat.
  Simulator, on vs off, 1,000 deals each: with sizeTell -0.6, 4-handed live +14.5 ± 13.0 (cloud) and -1.0 ± 13.4
  (Mac), phone -7.0 ± 15.6, heads-up live +20.1 ± 23.6 (Mac); default bots 4-handed live +12.6 ± 11.1. Pooled about
  +7 ± 6: neutral to slightly positive, as expected from a change that moves few decisions (v1.8.2).
- Bet sizes are capped at 1.5x pot (flop to river) and 1x pot in the river solver. 2x overbets lost real money in
  the owner's home game: friends call big bets far more than the old fold curve assumed. Against a raise, opponents
  continue only with the top of their range (`vsRaise` in `riverSolve`, `raiseCallCut` in `makePlan`).
- Fold-by-size curve (#35): `modelFold` is log-odds linear in the bet size, logit(fold) = logit(ftb) +
  0.9 ln(min(f, 0.8) / 0.33) + 0.2 ln(f / 0.8) above 0.8 pot (`FOLD_CURVE`); `ftb` is read as the fold rate against
  a third of the pot. Fitted on the logs' first responses to postflop bets: 20% folds to min-bets, 35% at
  0.15-0.25, 44% at 0.25-0.4, 52% at 0.4-0.55, 67-74% at 0.55-0.9, about 68% above (the old curve, elasticity 0.8
  around 0.6 pot, said 33% at a third and 49-56% at 0.55-0.9). Face log-loss 0.903 -> 0.894 on three logs. Size
  buckets keep the sizes seen (`vs.<bucket>.fs`/`fn`); `stats.sizeAnchor[bucket]` = (fs + 2 x center) / (fn + 2)
  is where the bucket's rate sits in `foldAtSize` (min-bets used to pull the small bucket down). Sim vs v1.7.0:
  +16.8 ± 14.5. Tried and dropped: calls as noisy as `rangeNoise` (-42 ± 16); taking the best-EV bet size instead
  of the smallest within noise (+19 ± 14 alone, but 1.5x-pot overbets went from 4% to 9% of postflop bets, some
  with weak hands: the winner's curse of an argmax over noisy sizes); exploit-weight scaling (already at its 0.95
  cap for regulars).
- Size reads: table first, then the player (#37). Each size bucket's fold rate is the size curve
  (`modelFold(stats.foldToBet, anchor)`), moved in log-odds by how the rest of the table answers that size compared
  with the curve (`prior.poolRest` from `pooledPrior`: pool counts minus the player, `TABLE_SIZE_K` 20 pseudo-counts),
  then by the player's own folds (`SIZE_K` 64 pseudo-counts, was 4). On three logs a friend's answer to one size
  compared with the others was noise: facing-bet log-loss 0.894 -> 0.883 (table average alone 0.886). k 64 without the
  table step lost -34 ± 16 on the #36 bots (they call small bets more than the curve says). predictAction's raise
  share divides by the fold rate raiseFreq was built from (multiway raises predicted 12%, real 9%, now 10%). Sim
  +48.3 ± 14.6 vs v1.7.2 (2,000 deals 4-handed). Tried and dropped: linking families (bet effect -> raise prior,
  VPIP -> fold), more shrinkage on vsOpen / 3-bet / foldAfterAgg (all under 0.003 log-loss); EV - 1 SE size
  tie-break -6.2 ± 12.7. Dropping the table step predicts unseen hands better (facing-bet log-loss on the 1 Nov
  session 0.861 -> 0.848; the 31 Oct and 1 Nov sessions read after the older logs 0.858 -> 0.851; bots' hands
  0.829 -> 0.831), but it loses at the live budget (1,000 deals 4-handed each): -28.5 ± 15.9 on the #36 bots (mostly
  button, strong hands), +10.2 ± 18.8 and -31.8 ± 17.4 on the refit bots (profiles-v3, seeds 502 and 503; small blind
  and weak hands, as hero stabs more weak flops without it), pooled about -17 ± 10. It changes no preflop decision
  (preflop never reads the size buckets), and folds against hero's bets stay on target either way (all logs, heads-up:
  predicted 0.47 with it, 0.48 without, actual 0.46, n 65). So it stays: the bots answer each size the same way all
  night and answer hero like each other, the friends don't (heads-up they fold less to each other's bets than the
  read at every size, about 0.05-0.10). A level-neutral table step (shape only) scored no better (0.863).
  Fewer pseudo-counts predict the logs worse (facing hero's bets 0.912 at 64, 0.915 at 32, 0.920 at 16, 0.928 at 8).
  Tried and dropped: a Student-t prior on each bucket's shift (same curvature as 64 pseudo-counts at 0, so it learns
  only a big, steady habit): the same on the logs within 0.001, +11.8 ± 10.2 on plain friend bots (v4, 2,000 deals),
  -5.1 ± 30.6 against the elastic exploiter. That exploiter's leak (about -52 ± 17 bb/100 against `none`, v4 bots,
  600 deals) can't be learned from size reads: it is elastic only against hero, and the reads pool every bettor's
  bets (one block: it folded 17% to hero's small bets, 35% to the others', read 0.31), so SIZE_K 8 was -19.5 ± 19.3.
  Real friends would give far too few answers to hero's bets per bucket in a session for a hero-only read.
  exploit.js `--xp elasticall` gives the same size answers to every bettor, which a read can learn.
  The friends are not elastic against hero (all logs, reads replayed in order, first answers to hero's postflop
  bets): under 45% pot they fold 36% heads-up (read 35%, n 39) and 46% multiway (44%, n 37); 45-85% pot 65% (55%,
  n 17) and 86% (64%, n 14); 85%+ 56% (66%, n 9). So no hero-only size read was built.
- Shown-hand strength (all live hands are shown at showdown, 127 of 127 in the logs, so a called river bet's shown
  hand is a fair sample of the betting range): the shown hand's strength quantile in the predicted range on the full
  board is 0.55 ± 0.05 after a river bet (n 34; 31 Oct 0.61, 1 Nov 0.40), 0.52 ± 0.06 after a river call (n 15),
  0.53 ± 0.04 after a river check (n 53); 0.5 is on target. Script: rb-hero.js in
  /mnt/project-files/patio-solver/scripts/ (reads-bench-lines.js with these two tables).
- Hero's pots read stronger (v1.8.9; `HERO_POT_TILT`, `input.heroPotTilt`; false turns it off, a number sets a fixed tilt):
  after the flop, an opponent in hero's pot who did not bet or raise the flop gets extra strength tilt on their range
  (`stats.tiltHero`, added to the bias in buildRange), ramped in from 10bb to 25bb of pot. The tilt is learned from
  the table's own shows (`heroPotLearned`): shows record whether hero was still in and the big blinds the player put
  in (`show.hp`); the tracker sums scoreShow's tilt log-likelihoods of flop-passive shows with 15bb+ in, in hero's
  pots and in the rest (`heroPotShows`), and the engine takes the tilt that fits hero's pots on top of the one that
  fits the rest, shrunk to the prior 0 by 15 pseudo-counts, so there is no tilt until the table's shows ask for one.
  Without `heroPotShows` it is off.
  Shown hands, all six logs (308 hands, reads from earlier hands only; quantile 0.5 = on target): in hero's pots
  with 15bb+ in after a passive flop the shown hand sits at 0.74 of the predicted range (n 23; per session 0.78 /
  0.65 / 0.76, best tilt 0.5 / 0.15 / 0.3, and 0.3 beats no tilt in every session), after a flop bet or raise 0.52
  (n 6), under 15bb 0.50 (n 15), in pots hero is not in 0.51 (n 110). Likelihood of those shows x2.30 -> x2.93 of a
  random guess. Folds to hero's bets are on target (predicted 0.47, actual 0.50, n 109) and more range noise does
  not fit, so the friends continue as often as read but with stronger hands: they check-call strong hands in hero's
  pots. Outcomes agree: hero's turn and river decisions against flop-passive opponents came back 9.8 ± 2.7 bb below
  the advised EV (16.4 ± 4.6 in 15bb+ pots), against flop aggressors 1.9 ± 12.0; in the simulator both are on
  target (+4.7 / +0.2). Rebuilding the reads from the logs' raw events, the learned tilt is 0.35 after 50 hands and
  0.3 from 150 on (23 shows in hero's pots, 61 in the rest). The bots can't be made to trap (a knob gave 0.53-0.58),
  so on them a fixed 0.3 is pure cost: v6 bots, live, on vs off, 6-handed -31.3 ± 24.9 and -55.4 ± 23.2, 5-handed
  +24.9 ± 21.7 and -44.8 ± 20.2, 4-handed +17.9 ± 26.0 and -36.0 ± 22.4, 3-handed +29.3 ± 31.1 (pooled -18 ± 9,
  6-handed -44 ± 17; premium and strong hands value-bet less). Learned (212fe7d), vs off on bots that don't trap,
  live: v6 6-handed -20.2 ± 18.9, -9.7 ± 18.9, -2.5 ± 15.8, 5-handed +2.4 ± 19.2, -4.3 ± 19.5, -22.2 ± 19.1,
  4-handed +0.4 ± 17.0, -21.2 ± 19.0, +3.3 ± 21.0, 3-handed +3.7 ± 21.8; v7 6-handed -2.4 ± 15.7, 5-handed
  +7.5 ± 14.3, 4-handed +3.0 ± 20.8 (pooled -4 ± 5). With the floor at 0 (`min`) and 1,200 warm-up hands (v7):
  6-handed +0.2 ± 10.7, 5-handed -25.2 ± 14.5 and +14.2 ± 15.3, 4-handed -6.9 ± 18.6; with the floor and the usual
  300, 5-handed -21.6 ± 15.9 (all 18 runs pooled -5 ± 4). A sim block
  sees only 7-33 tagged shows in hero's pots, so the learned tilt sits at 0 or 0.15 (TILTS nodes; the curve is
  interpolated linearly) about half the time each, never at the friends' 0.3. On the logs it learns 0.3.
  Prior 0 (the default since a3daaeb; the runs above had a prior of 0.3): rebuilding the logs' reads, the tilt is 0.15
  for the first 150 hands, 0.22 at 200 and 0.3 from 250 (13 shows in hero's pots); with the prior of 0.3 it was
  0.30-0.35 throughout. Shows recorded before v1.8.9 carry no `hp`: the panel fills them in once at start from every
  stored hand (`tagHeroPot`: the hand where the same cards were shown on a board starting with the show's; flag
  `db.hpTagged`), the userscript from its 150 at every load, so reads built from earlier sessions start at their
  learned tilt (on the 31 Oct - 2 Nov logs every one of 308 shows gets the same `hp` as a rebuild, tilt 0.3). Live budget, 1,200 warm-up hands, off vs prior 0, v7 bots:
  6-handed +4.8 ± 11.9 and -8.2 ± 11.9, 5-handed +6.9 ± 14.5 and -3.9 ± 16.6, 4-handed -15.1 ± 18.7 (pooled
  -2 ± 6); bots that tighten up in hero's big pots (`--bot-params '{"hpCall":0.3,"hpFlop":1}'`, which also makes
  them fold more than read there, and their shows only reach about 0.59) 6-handed -9.2 ± 10.5, 5-handed
  +15.7 ± 13.4, 4-handed +17.3 ± 12.6 (+5 ± 7). On those bots the prior of 0.3 lost -8.8 ± 17.9 and -31.4 ± 14.2
  (5-handed), -40.5 ± 16.1 (6-handed) and +6.5 ± 16.6 (4-handed), pooled -20 ± 8, mostly in flop bets; the fixed 0.3
  -22.8 ± 15.3. Tried and dropped: the tilt on the turn and river only (`street: 4`, prior 0.3), plain 5-handed
  -11.5 ± 11.8 and 6-handed -25.1 ± 16.2, tightening bots -17.8 ± 10.8, -0.3 ± 12.8, -7.8 ± 16.1; on the 2 Nov
  export it differs from the full tilt only on 7 flop decisions.
  On the 2 Nov hand-log export (180 hands of 1-2 Nov) the fixed tilt changes 26 of 361 decisions, all postflop in
  10bb+ pots (a 44 turn barrel into AA becomes a check, QQ stops betting and calling into AA, three losing calls
  fold; an AK river value bet halves, an A4 turn raise that won becomes a call). Fold rates don't move, so a few
  river checks become bluffs. Scripts and tables: /mnt/project-files/patio-solver/sims/2026-11-03-night/heropottilt/.
- River overbets read stronger (v1.8.14, `OVERBET_TILT` {tilt 0.3, size 2.99, street 5}; `input.overbetTilt: false`
  turns it off, a number sets the tilt): a river bet or raise of 3x the pot or more (the tracker caps sizes at 3, so
  `sizes.river` 3 is 3x+) adds 0.3 of strength tilt to that player's range in buildRange. It does not stack with the
  hero-pot tilt (the larger applies), because the shows it was fitted on carry both. Logs (31 Oct - 4 Nov): all 9 shown
  river bets and raises of 3x+ sat at 0.68 of the read's range (7 two pair or better, one top pair, one bluff); best
  tilt 0.3, 1.85 nats over none. Flop and turn overbets of 3x+ are on target (0.56, n 10), and so are 1.5-3x bets
  (0.42, n 20). On 4 Nov's #382 (Q7o on Jh 5s 7s 3d 5h, Jagger bets 21x the pot) it calls instead of raising to 192bb
  (call +12, raise -3 bb; he had trips); replaying every log (1,225 hero decisions) it changes no other decision. The
  friend bots never bet over 2x the pot, so plain runs are identical; red-team presets `xp:riverover` (overbets 3-10x
  with strong hands half the time, air 5%, like the shows) and `xp:riverbluff` (air 30%). Live budget, v7 bots, on vs
  off: riverover 4-handed +3.3 ± 3.3 and -4.4 ± 3.9, 5-handed +6.1 ± 6.5, heads-up +10.0 ± 14.9, 3-handed
  +9.6 ± 11.4 (pooled +1.4 ± 2.3); riverbluff 4-handed -3.3 ± 13.8, 5-handed -6.1 ± 6.8, heads-up +12.7 ± 23.1
  (pooled -4.4 ± 5.9, the cost if a friend's overbets were bluffier than the shows). So the simulator is neutral; it is on for the log evidence.
  Files: /mnt/project-files/patio-solver/sims/2026-11-04-overbet/.
- Huge preflop raises read tight (v1.8.15, `BIG_RAISE_RANGE` {width 0.12, toBB 30, behind 0.25}; `input.bigRaiseRange:
  false` turns it off, a number sets the width): an open or isolation raise to 30bb+ that keeps at least a quarter of the
  raise-to behind is read as the top 12% of hands (or the raiser's range, if narrower). The tracker passes the raise-to
  and the chips behind in big blinds (`sizes.preTo`, `sizes.preBehind`); older inputs have neither, so it is off for them.
  Friends' shown preflop raises of 30bb+ (31 Oct - 4 Nov): the 9 all-ins were wide (Q2o, T9o, J8o, A2o...; best fit top
  45%, A9s 60% against them), the 5 that kept chips behind were KTo, A9s, AA, AQs, KK (best fit top 12%, A9s 36%; 2 opens,
  3 re-raises, which read narrow already). Jagger raised to 50bb+ in about 2.5% of his hands (opens to 117, 102, 51, 50
  and 131bb, a 135bb shove with A2s). 4 Nov's #390 (A9s in the big blind vs his 131bb open, half his stack; he had KK)
  goes from all-in +65bb to fold; 2 Nov's A4o vs his 102bb open from all-in to fold; 1 Nov's AJo vs Dew666's 32bb open
  from all-in to a raise (a tie); no other of 1,018 logged decisions changes. The bots never raise that big with chips
  behind, so the simulator can't judge it; Marwin chose it on the logs (4 Nov).
  With it, a preflop raiser with a third or more of their stack in continues against hero's raise at 0.97
  (`input.pfCommitCall: false` for the old rule; continueRule's `opp.behind` is the input's `stack`): #390's rule had
  Jagger folding 23% to the shove with 131 of 255bb in and needing 24%; friends with a third of their stack in called all
  3 logged spots. It changes no logged decision on its own (#390's shove +65 -> +53bb). Since v1.8.16 callers too (any
  player already in with a third of their stack): on 1 Nov Jagger called Dew666's 32bb open with 92bb and was read
  folding 56-73% to hero's re-raise (he called it with Q5o); AJo there goes from a raise to 128bb (tied with the
  shove) to all-in (+46 vs +29bb), the only one of 1,018 logged decisions that changes. The bots don't model it (their
  `pfCommit` is opt-in), so a sim would score them folding where friends call. Files: analysis/2026-11-04-session.md
  ("Your two questions"), scripts/2026-11-04-session/questions/.
  Since v1.8.18 it ramps in from a fifth of the stack in (`PF_COMMIT_RAMP` [0.2, 1/3]: continue and re-raise move
  linearly from the usual rule to 0.97 / 0.11; `input.pfCommitRamp: false` keeps the old step at a third). The step
  moved a logged re-raise's EV by 14.6bb for one chip (leak hunt). Friends with 15-20% in continued 1 of 3 times, 20-33%
  1 of 1, a third or more 3 of 3. Example, a raiser facing hero's shove: 0.43 continue at a fifth in, 0.63 at a quarter,
  0.93 just under a third, 0.97 from a third. On the 18 logged preflop spots with an opponent 15-40% in no decision
  changes (88 at #62: all-in EV 49.7 -> 40.9, still the pick).
- All-in preflop re-raises read wide (v1.8.17, `SHOVE_RANGE` {behind 0.1, vpip 0.7, min 0.15}; `input.shoveRange: false`
  turns it off, a number sets the share of VPIP): a 3-bet, 4-bet or 5-bet that leaves under a tenth of the raise-to
  behind (`sizes.preTo` / `preBehind`) is read as the narrow re-raise range plus the top 0.7 x VPIP of hands. Friends'
  shown all-in re-raises (reads from earlier hands): Jagger Q6o (25bb), Dew666 J8o (39bb) and T9o (17.5bb), etestraight
  A2s (36.5bb), jamaleatkid ATo (50bb), each at about the 0.04-0.06 quantile of the old read; log-likelihood against a
  random guess -7.1 nats over the five, +1.8 at 0.7 x VPIP (best of 0.3-1.5). Synthetic heads-up spots (hero opens
  late, a 0.65-VPIP friend shoves from the big blind): the old read folded hands that should call, about 1.0 / 1.6 /
  2.1 / 3.2 / 4.8bb a shove faced at 15 / 25 / 40 / 60 / 100bb. It changes none of the 7 logged hero decisions facing an
  all-in re-raise (equity up to +0.07: ATo heads-up 0.54 -> 0.60, A2o 3-way 0.22 -> 0.29) and no other logged decision.
  The bots re-raise by hand strength, so the simulator would score it against shoves as tight as the old read.
- Leak hunt (5 Nov, /mnt/project-files/patio-solver/leakhunt-2026-11-05/, REPORT.md, scripts/): every logged decision
  re-solved with 1-chip changes (pot, stack, a bet, an opponent's stack) and with bet-size, preflop-size and depth
  sweeps, against seed-to-seed noise, plus shown hands against the read by line. Steps found: pfRaisedRead at 30bb
  (above), the 1/3-committed rule (pfCommitCall: 0.55 -> 0.97 continue; a ramp since v1.8.18), the 25bb preflop shove-menu gate
  (shoveMakesSense), bigBetMedium at 0.9 pot, and the 2.6x raise dropped above pfRaiseCapBB. The first two that the
  simulator can judge are options, off by default: `pfRaisedReadBB` (above) and `input.pfShoveBB` (25: all-in is on the
  preflop menu up to that stack or 3 pots). 15 of 499 logged preflop decisions had 25-40bb and no all-in offered; 2 Nov
  TT in late position with 25.5bb behind a limper: best raise +9.5 chips, with a chip less the shove at +23.0. With 40,
  6 of the 15 shove (AA 40bb in the big blind over three limpers, AKs/AKo 36-40bb, A3o 28.5bb, TT). The simulator needs
  `--stack 30` or so for it. The other steps have too few logged spots to place a ramp.
- River raise fold (`RIVER_RAISE_FOLD` 0.5, off: `input.riverRaiseFold: true` turns it on, a number sets it): in
  riverSolve's fixed strategy a bettor facing hero's root raise folds at least that share of its betting range, x
  min(1, raise / pot). The read folds only the bluffs, 0.9 x (1 - value share), about 25-35%; in the logs river bettors
  who got raised folded 14 of 28 (hero's raises 4 of 7), flop and turn bettors 3 of 38 and 3 of 17; the v7 bots fold
  32 of 46. On the bots hero's river raises with 55-80% equity were valued 10.3 bb over calling and brought -3.8 ± 9.6
  (river-check.js). It changes none of the 54 logged river decisions facing a bet; live budget on vs off: 4-handed
  -4.9 ± 15.3 and +5.5 ± 15.6, 5-handed +2.6 ± 8.6, heads-up -11.9 ± 17.3; the raises it turns into calls, valued on
  the bots' real hands, +1.1 ± 3.2 bb/100. So it stays off. The same dump has river calls overvalued against the bots
  (solver eq 0.295, real share 0.167, n 93, mostly facing bets under 0.6 pot), where friends' river bets show on
  target in the logs, so that reads as a bot artifact.
- Made hands call hero's river bets (v1.8.19, `RIVER_MADE_CALL` 0.55; `input.riverMadeCall: false` turns it off, a
  number sets it; `turnMadeCall: false` / `planMadeCall: false` turn off the turn solver's river subgames / the
  lookahead's river): facing hero's river bet, an opponent's hand that beats at least 55% of all hands on the board
  continues whatever its place in the read's range (the fixed strategy's fold is x sigmoid((0.55 - a) / 0.03), a = the
  hand's share of all hands it beats; the lookahead caps callCut and foldHero at that strength, `heroCallCut`). Raises
  and friends' bets are untouched. Logs (31 Oct - 4 Nov, reads replayed from earlier hands, each responder's range
  rebuilt at every river bet; scripts/2026-11-05-river-bluffs/): friends answer each other as read (heads-up n 154,
  predicted .47, folded .46; calibration slope 0.88 ± 0.20), but answer hero by absolute strength: heads-up n 30, read
  .51 vs .47 overall, .57 vs .29 where the read needed made hands to fold (n 17), .44 vs .69 where folding the weak
  hands was enough (n 13); by size (under 45% / 45-85% / 85%+ pot) .54 / .43 / .40 against a read of .37 / .54 / .67.
  Every shown heads-up caller of a hero river bet beat 59%+ of all hands. Log-likelihood of hero's heads-up spots:
  read -21.8, this -13.5; multiway (n 16) -21.3 -> -19.6; friends' own bets get worse with it (-115.5 -> -119.1), so it
  is hero-only. Pot type is not the driver (the called bluffs were mostly in limped pots; in 3-bet pots friends fold to
  each other more than read). The riverFoldCurve (size elasticity) and riverFoldShrink (fold rates pulled to the mean)
  threads aimed at the same gap: on hero's heads-up bets they scored -17.1 and -18.3, and on top of this -13.9 and
  -13.0, so only this was landed. The river solver's own fold at hero's actual size (24 heads-up bets): main .483, this
  .387, actual .458 (log-lik -17.4 -> -16.0). Log replay (every hero decision, live budget): 17 of 120 river decisions
  change (bluffs into Q8, JJ/88, Q3, A8 become checks; #369 and #475's bluffs get smaller; value bets grow, which
  lose more against QQ and AT and win more against QT), 24 of 155 turn decisions (#66's raise -> call, #189 and #479's
  semi-bluffs -> check), 39 of 243 flop decisions (mostly weak multiway stabs, equity .07-.2, become checks, most of
  which were called or raised). Simulator, live budget, all three on vs off, 1,000 deals each, v9 bots (v8 plus
  `heroRiverAbs` 0.55: facing hero's river bet a bot continues iff its made-hand percentile is 0.55+, as the friends
  do): 4-handed +48.8 ± 22.5, 5-handed +6.8 ± 23.0, 6-handed +36.8 ± 21.7 (pooled +31 ± 13); heads-up river air bets
  84 -> 44 (5-handed) and their TD -4.8 ± 4.3 -> +9.8 ± 3.9 chips, turn air bets 89 -> 55. On v8 bots, which fold far more than the friends to river bluffs and big
  bets (audit, 4 Nov), 4-handed -23.8 ± 20.7 (strong hands -17.5 ± 11.6: the bigger value bets get folded). Files:
  /mnt/project-files/patio-solver/sims/2026-11-05-rivermade/, analysis/2026-11-05-river-bluffs.md.
- River raises read stronger (v1.8.19, `RIVER_RAISE_TILT` {tilt 0.3, street 5}; `input.riverRaiseTilt: false` turns it
  off, a number sets the tilt): a river raise of any size (raise, check-raise, re-raise lines) adds 0.3 of strength tilt
  to the raiser's range in buildRange, like `OVERBET_TILT` (the larger of the two applies; neither stacks on the
  hero-pot tilt). Shows, all logs (leak hunt's rbl.js sweep, reads from earlier hands): 21 shown river raises at 0.69
  of the read's range for plain raises (n 17), 0.64 for raises under 3x the pot (n 19); log-likelihood by tilt 0 / 0.15
  / 0.3 / 0.5: 20.4 / 23.1 / 23.5 / 21.2 nats over a random guess. River bets fit best untilted (n 220). Log replay:
  2 of the 9 river decisions facing a raise change, both calls -> folds that the shows back (31 Oct #25 QT vs mkorn777's
  AA, #126 AK vs MaPokerrk's KT full house). Too rare for the simulator to judge.
- Draw-weighted answers to hero's flop and turn bets (`RESP_DRAW` = DRAW_CALL 2, off: `input.respDraw: true` turns it
  on, a number sets the weight): the Monte Carlo's continue decision (qCont), the lookahead's current-street callers
  (`xs.resp` in drawPlan, survivors' LINE_CALL cut on ctx.street) and the turn and flop solvers' fixed strategies facing
  hero's bet (`qTurnR`, `qFlopR`) rank hands by hs + 2 x pot (`respScore`) instead of ehs (hs + pot), as buildRange's
  call ranges already do. Logs (reads from earlier hands, ranges rebuilt at every flop and turn bet, 958 first answers;
  scripts/2026-11-05-river-bluffs/ capture-street.js, ranges-street2.js, fit-draw2.js): friends float with flush draws,
  gutshots, overcards and backdoors that ehs ranks at the bottom (6 of 27 shown heads-up callers of hero's flop bets sat
  below the read's cut). Log-likelihood, ehs -> weight 2: hero's heads-up flop bets (n 62) -59.0 -> -52.3, turn (49)
  -37.3 -> -31.7, hero's multiway flop bets (69) -36.7 -> -40.4, friends' bets to each other flop -87.5 -> -81.7 (HU,
  102) and -161.2 -> -154.2 (MW, 241), turn -87.7 -> -73.8 (121) and -98.8 -> -90.6 (142); weights 3-4 fit about the
  same. A softer edge (w 0.1-0.24 instead of 0.04) fits much better still on every set but hero's multiway flops, which
  says the answer model is noisy, not that the read's fold level is off. Log replay (live budget, with riverMadeCall):
  25 of 243 flop decisions change (medium hands check or bet smaller, a few semi-bluffs grow), 6 of 155 turn decisions
  (near ties). Off is identical to before (80 flop and turn decisions checked). Simulator, v9 bots, on vs off, 1,000
  deals each: live 4-handed -41.7 ± 22.6, 5-handed +16.9 ± 25.3, 6-handed +3.0 ± 15.7 (pooled -6 ± 12), phone
  4-handed +24.2 ± 25.0. No win, so it stays off. The bots keep strong draws (drawCall) but fold weak made hands by a
  fixed strength line, so they are only partly like the friends' floats. Files:
  /mnt/project-files/patio-solver/sims/2026-11-05-respdraw/.
- Check-line reads (#47): facing a bet after checking on that street, friends fold more (fold odds x1.25) and check-
  raise half as often as their raise rate says; facing a bet before acting on the street (a lead) they raise 1.4x as
  often (READ_PRIORS.home.line; computeStats ctx.line / ctx.street moves only that street's foldToBet and raiseFreq,
  statsHU too; predictAction and the tracker's predictor take d.checked). Facing-bet log-loss: old session 0.895 ->
  0.877, new 0.869 -> 0.857, each session alone fits about the same. Bots fold the same way (after checking 59%, old
  read 54%). Simulator -9.5 ± 14.2 and +15.0 ± 14.1 on two seeds (neutral). `input.checkLine: false` turns it off
  (simulator; red team below).
- Multiway fold structure (logs, first bets of 25-110% pot answered by 2+ friends, 128 hands): the first to answer
  folds 47%, the last 52% when the rest folded but 69% when someone stayed, and two players both fold 21% (three:
  26%). Multiplying each player's multiway fold rate gave about 38% for two. Since v1.7.2 players answer a bet in turn
  (those still to act first, then those who acted before hero): until someone stays each answers with their heads-up
  read (`sc.oppHU`, `respOrder` in `decide`), after that with the multiway one; the field solvers fold with the
  product of heads-up reads (`fieldStats(list, base, foldList)`). Against the old bots, which over-folded multiway
  the same way as the model (two fold together 38%), this lost -27 ± 20; against the refit bots (#36: 53% / 53% /
  63%, two together 31%) it gained +32.8 ± 21.2 (1,000 deals 4-handed; weak hands +30 ± 10, SB +33 ± 13).
  After someone has called, the logs fold 54% where the multiway read says 47% (37 spots; no caller yet: 52% vs 57%,
  93 spots, before #39's heads-up first answers). Since v1.7.7 players still to act fold with odds x1.3 once someone
  has called hero's bet or a bet hero called (`OVERCALL_FOLD`, `sc.oppAfter`, `input.overcallFold`; players who acted
  before hero keep the check-line read, #47). Simulator, 4-handed, 1,000 deals per seed: -8.4 ± 20.3, +26.7 ± 21.7,
  +11.2 ± 18.4, +36.9 ± 18.3 (pooled +16.6 ± 9.9). It makes the small multiway stabs a little better through the
  lookahead (fewer overcallers, so more heads-up river bluffs): the test's flop king-high stab went from 1.03 to 1.34
  chips over checking (pot 12); on the spot the stabs still lose about 1.8 chips. The same rule in the lookahead's
  multiway rounds on later streets (heads-up answers until someone calls, then the multiway read with odds x1.3;
  the plans are built from `statsHU`, so every answer there is heads-up) lost -0.8 ± 18.7 and -53.5 ± 20.4 on two
  seeds (pooled -27 ± 14), so later streets keep heads-up answers.
  Joint folds by size, exactly 2 opponents, first bets (both fold / product of heads-up rates): under 40% pot 9% / 5%
  (n 22), 40-75% 16% / 31% (n 19), 75-100% 38% / 48% (n 8), over 100% 60% / 49% (n 5); 3+ opponents at 75%+ 28% / 34%
  (n 18). So the product of heads-up rates holds overall (20% vs about 25% pooled); only mid sizes fall short, on
  thin data. Small multiway stabs that the log replay still flags on d7c8a9f (#35, #101, #112, #125 flops/turns,
  0.06-0.8 chips over check) are not from the fold curve: their immediate all-fold (7-27%) is close to the logs, and
  with `lookahead: false` each is -1.2 to -2.2 chips and checking wins. Their edge is the lookahead's river bluff after
  someone calls; the logs don't contradict it (river bets after a called turn bet took the pot 5 of 6 times
  multiway, 5 of 8 heads-up; hero's own barrels 4 of 5), but every sample is tiny. Scripts:
  /mnt/project-files/patio-solver/scripts/ (mw-stab-calibration.js, barrel-folds.js, mw-joint-folds.js).
- Simulator results (`test/sim/run.js`: duplicate deals, luck-corrected bb/100 ± SE; the old `sim.js`/`sim-multi.js`
  figures were much noisier and are dropped). 4-handed vs friend bots, 150bb: solver 225 ± 32 vs the simple baseline
  bot 97 ± 26 (+128 ± 35, 1,000 deals, v1.4.0). Multiway preflop solver on vs off: +39 ± 18 (2,000 deals; the
  heads-up preflop solver alone adds +2 ± 16 there); gain mostly from the blinds (SB +23 ± 11, BB +26 ± 10), UTG
  −9 ± 8. Heads-up preflop solver on minus off: typical bot −4 ± 13 (2,000 deals), maniac +18 ± 20, friends −2 ± 22,
  so about neutral (+2 ± 10 pooled). Multiway river fixes (fieldStats, overcalls) +3.5 ± 16; turn solver on vs off
  heads-up +1.9 ± 21 and 4-handed +5 ± 20, then +20 ± 22 on the size-aware bots (1,000 deals each; pooled 4-handed
  about +12 ± 15); multiway preflop on the refit bots (limpers fold like the
  friends) +31 ± 18; v1.4.0 vs v1.5.0 main +13 ± 21 4-handed, +12 ± 22 heads-up; side-pot gate (#21) +28 ± 16; reads rebuild about +8 ± 12 over 4 runs; audit fixes (#12) -6.7 ± 12, -3.9 ± 10, +12.7 ± 10
  against three successive mains; flop solver on vs off -3 ± 25 (1,000 deals); lookahead lines (v1.7.0, LINE_SOFT 0.5) +27 ± 15
  4-handed (2,000 deals) and +19 ± 22 heads-up on the log-sized bots (1,500 deals); full narrowing was -16 ± 22; turn solver river
  sizes 33/66/100% vs 50/100% (turn solver on in both) +24.9 ± 18.7 and +12.0 ± 14.8 on two seeds; everything from
  #37, #39, #40 and #42 together (d8e866e vs 90693fb, fresh seed) +30.2 ± 22.2, well under the parts added up (they
  overlap, and the single runs that got merged are biased upward by being picked). Exploiter bots on v1.7.4 (600
  deals 4-handed, seed 7): base friend 262.5 ± 36, adapt 253.1 ± 36, sticky 236.9 ± 36; hero folds 34-38% to river
  bets and 2% to 3-bets, and the base bots answer hero's flop raises fold 37% / call 49% / raise 14% (logs: 32 / 47 /
  16). v1.3.0 (b83d5f1) vs 4ed4335 (v1.7.7 + #59/#60) at `--budget live`: 4-handed +38.3 ± 24.7 and +35.6 ± 26.2
  (seeds 31 and 41, 2,000 deals each; pooled +37 ± 18), heads-up +30.6 ± 29.8 (2,000 deals); the 4-handed gain is
  mostly the 10-25% hands (+32 to +41 of it). Bots are simple; this is a regression check, not proof
  of an edge against real players.
- Tuning sweep (sim thread, fresh-deal confirmations vs current constants, 4-handed refit bots): robustWeight
  0.35->0.7 -13.8 ± 11.5 (2,400 deals; +21.9 in the sweep), exploitWeight x0.75 +2.8 ± 12.7, credibility off
  +18.1 ± 13.9 (not taken: bots ignore hero's line; logs fold 58% after an aggressive hero line vs 46% after a passive one,
  n 24/50), postflop raise sizes [0.6, 1] -> [0.6, 1, 1.5] +9.5 ± 11.7 on v1.7.1 but -3.1 ± 8.6 over 4,000 deals on
  v1.7.4. Bet menus, river sizes, shove thresholds and the 0.8 raise-equity cut lost or stayed flat by 1,200 deals.
  No constants changed. Knobs: test/sim/knobs.js, tune.js.
- Monte Carlo budgets (speed thread): against a 384,000-iteration reference on 104 logged postflop spots, 24,000
  (phone) picks the same 97% of the time (0.001 bb per decision), 48,000 97%, 96,000 100%. No build needs a bigger
  budget. The sim's --iters 3000 picks differ more often, but over 2,000 deals it plays as well (+1.4 ± 14.6).
  The sim's whole default budget (3,000 Monte Carlo and 120 river iterations, no turn solver) is another matter
  (audit thread, #55): it matched the full solve on only 53-79% of flops and 36-42% of turns, and at the real budget
  the solver scored +46 ± 21 bb/100 over the default (4-handed, 1,000 deals); the turn solver at the real budget
  scored -6 ± 21. Results before #55 were measured at the default and may not hold at `--budget live`.
  Audit round 9 checked that: the night's changes together (main before #21 vs main after #67, 4-handed) came out
  about +18 ± 18 at `--budget live` over two seeds, +6 ± 20 at `--budget phone` and +50 ± 28 at the default, while
  the per-PR gains in these notes add up to about +270. Bisecting #35 to #42 found no single culprit; #42 (+30 at
  the default, -9 at phone) and #35 (+25 / -4) differ most between budgets, and #37 is the only one up at phone
  (+26 ± 21). So the single-PR gains measured before #55 are optimistic; nothing was reverted. The heads-up turn
  solver at the live budget is neutral (+3 ± 11).
- Red team (3 Nov night, v1.8.11, live budget, v7 friend bots, 1,000 deals a run; tables and files in
  /mnt/project-files/patio-solver/sims/2026-11-03-redteam/RESULTS.md): one seat played by an exploiter (`xp:<preset>`,
  test/sim/exploiters.js, test/sim/README.md), scored as hero's result against it minus against the same seat played
  by the pool bot on the same cards (`ANY_BOTS=1 diff.js`; part of that is just a different opponent). Pooled over
  4- and 5-handed runs: a player who bets 1-1.5x pot only with strong hands (`bigvalue`) -34 ± 16 bb/100 (three runs;
  premium hands pay it off), one who raises after the flop only for value (`vraise`) -26 ± 15 (three), a trapper in
  hero's pots -16 ± 17, check-raiser -16 ± 14, lead bluffer after a call -8 ± 15, overcaller +21 ± 11 (hero gains),
  loose/tight switcher every 100 hands -34 ± 35 (one run), a 20bb push/fold jammer none (exploit.js: no shove hero folded
  would have been better called). A friend's read deleted every 100 hands (back on an unlinked account): -18 ± 12.
  Turning off the read each exploiter aims at never helped: bigBetMedium off -5 ± 13, flopBigRaise on +10 ± 7, afterCall
  off +13 ± 10, checkLine off +2 ± 12, overcallFold 1 +4 ± 8, decay 0.98 +4 ± 25, and heroPotTilt off -19 ± 11 against
  the trapper (the learned tilt does its job). Tried and dropped: every flop raise at a quarter of the range noise (on
  the logs shows after a flop raise fit x1.12 -> x0.60 of a random guess, 19 shows: the friends' flop raises are not
  value-only); each friend's own rate of bets after calling (`afterCallLearn`, k 48: friend bots -0.5 ± 2.7 over four
  runs, lead bluffer +6 ± 7 over three; on the logs every k predicts the friends' leads worse than the fixed read); a
  per-player showdown tilt for raise lines and 0.9-pot bets (`lineTilt`: bigvalue +10 ± 12 and -22 ± 14, vraise
  -5 ± 12; logs x1.83 -> x1.81 and x1.35 -> x1.32). The friends bet big with medium hands and raise the flop with
  draws, so the two costly profiles are not tonight's table; they are what a friend who changes style would cost
  until something reads size or raise strength per player faster than showdowns do. Logs (419 hands, 765 hero turns):
  the tracker never lost the chips. Short stacks (12bb): hero shoves or folds almost always.
- Preflop flop edge (v1.8.13, `PF_FLOP_EDGE` 0.06, `input.pfFlopEdge`: false turns it off, a number replaces it): at the
  preflop solver's flop leaves hero's realized share of the pot gains 0.06 x t (t = min(1, spr / 4), floor 0.15) for
  every pair of hands. Audit thread, 4 Nov: every hero decision of all logs replayed with reads from earlier hands only
  (/mnt/project-files/patio-solver/audit-2026-11-04/, NOTES.md, scripts/). TD error = EV at hero's next decision (or
  what came back) minus chips put in minus the EV of the action taken. Main's EVs are on target overall (+0.21 ± 0.68 bb
  a decision, 1,018 decisions), but preflop raises sit below the flops they lead to: opens and isolation raises
  +4.7 ± 1.2 bb (z 3.8, n 86), median 0.25 of the flop pot. On the v7 bots (`--diag`, test/sim/td.js) about half that
  (+0.14 of the flop pot after a raise, +0.20-0.30 after a call) with the postflop side on target against what came
  back, so the leaves miss that hero's postflop play exploits the reads. Simulator, live budget, v7 bots, B - A
  (pfFlopEdge 0.06 vs 0, `raisePrice` off in both): 4-handed +68.2 ± 24.6 and +40.3 ± 27.9, 5-handed +74.7 ± 19.7,
  6-handed +45.4 ± 18.6, 3-handed +50.2 ± 25.8, heads-up +42.0 ± 24.7 (pooled +55 ± 9; mostly hands B plays that A
  folds, +63 ± 12 of the 5-handed run, button and blinds, weak to good hands; strong and premium about -3). Fresh seeds,
  v1.8.13 against main (B {} vs A `{"raisePrice":false,"pfFlopEdge":false}`): 5-handed -7.2 ± 24.3 and +28.9 ± 23.1,
  4-handed +40.1 ± 21.2, 6-handed +46.1 ± 19.7 (v7 live pooled +30 ± 11), 4-handed phone -4.4 ± 24.9, 4-handed on the
  v6 bots +81.5 ± 24.5; all twelve runs pooled about +44 ± 7. The short-raise change alone (below) changed 1 of 1,000
  simulated hands. 0.10: 4-handed +94.0 ± 30.0; 0.15: +107.0 ± 35.2 with
  hero's VPIP / PFR 45 / 33% -> 76 / 65% (0.06 at 5-handed: 35 / 25% -> 43 / 32%). The bigger sizes are not taken: bots
  never adapt to a hero who raises two hands in three, the friends might. On the logs 0.06 changes 76 of 499 preflop
  decisions (fold -> raise 25, call -> raise 11, fold -> call 10, check -> bet 8; folds 51% -> 43%), 0.10 150. Tried:
  implied odds at the leaves (`pfImplied`, simulator only; s -> s + implied x t x (s - 0.5)): 0.5 lost -55.3 ± 18.0
  (4-handed) and the preflop gap did not close. At 4-handed the edge moves hero's VPIP / PFR 44 / 33% -> 54 / 42%.
- Short raises (v1.8.13, `input.raisePrice`: false for the old rule): an opponent facing hero's raise that costs them
  under a quarter of the pot over the call (an all-in a chip over the call) folds no more of their range than to a bet of
  that price, in the river, turn and flop solvers' fixed strategies. The 4 Nov log had QQ facing 40 into 208 with 41
  behind: the 1-chip all-in was folded to like a full raise, so it read +1.7 against -25.4 for the call and advised the
  shove (now: fold). 2 of 1,017 logged decisions change. A first version without the size limit broke the "calls a known
  bluffer more often" river test (polarized betting ranges over-continued against full raises).
- Audit findings not fixed (4 Nov, NOTES.md): (1) fold predictions are too extreme against the friends: logistic
  calibration slope 0.57 ± 0.16 on hero's postflop bets (n 213), preflop 0.58 ± 0.20; heads-up flop and turn fine
  (0.96 ± 0.37), heads-up river 0.08 ± 0.48 (n 29), multiway 0.33 ± 0.32; on the bots 1.33 ± 0.14 (the other way), so
  the simulator can't judge a fix. (2) The solver's river bluffs against the friends: 5 since 2 Nov, predicted folds
  .41-.77, all called (second pair, top pair twice, ace-high on a trips board, two pair); all river bets with under 30%
  equity 0 of 9 folded, predicted .43 (z -3.0). On the bots river bluffs make 7.5 bb more than read. (3) Hero's raises
  are overvalued on the bots on every street (river -9.9 ± 2.9, turn -6.5 ± 3.3, flop -2.8 to -10.8 chips TD) because
  the bots fold to them far more than read (river 12 of 13, predicted .40; flop .47 vs .31); the friends fold to flop and
  turn raises 8-13% (n 55) and to hero's flop raises as read (.16 vs .15, n 19).
- Simulator caveat (4 Nov audit): the v7 bots continue by absolute hand strength, so where their range is weak they fold
  far more than any read of their average rate. Hero's heads-up bets of 0.85 pot or more: bots fold 81% (predicted 57%,
  river 96% vs 67%, n 26), friends 49% (50%; river 55% vs 61%, n 11); small bets the other way (bots 28% vs 42%). The
  simulator flatters big bets, river bluffs and anything that wins by bots folding to raises.
- Ideas: hero's story (`credibility`) is measured against uniform random hands, so the shift is almost always
  positive (mean +3.3 points over 150 postflop decisions in Marwin's logs, 15 at the +8 cap) while the fitted fold
  rates already describe answers to typical lines. On the logs that does not double-count: over 48 hero postflop bets
  everyone folded 17 times, predicted 14.9 without the story and 16.1-16.5 with it (log-likelihood -31.4 / -30.8), so
  recentring is not supported (thin data; the sim bots ignore hero's line). Real river subgames inside the flop solver (it only has the `flopRiverBet` approximation); multiway
  flops are the biggest pots still on the Monte Carlo (about 35bb on average in Marwin's logs). (Syncing reads between
  devices is not wanted: the owner keeps phone and computer separate.)

## Testing limits in the cloud sandbox

The cloud sandbox network usually cannot reach pokerpatio.com, so live testing has to happen in the owner's
browser. Use the recorded fixtures plus the Playwright harnesses for everything else. When you add support for a
new event shape, add a fixture and a test in `test/replay.test.js`.
