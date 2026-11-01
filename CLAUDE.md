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
src/tracker.js           Socket events -> hand state, opponent tallies, solver input. Pure JS, unit-tested.
src/userscript-core.js   iPhone/userscript UI + in-page socket hook + Web Worker solver.
extension/               Chrome MV3 extension (Load unpacked on this folder).
  hook.js                MAIN-world script: attaches socket.onAny, posts events + state snapshot via postMessage.
  overlay.js             Isolated-world panel (shadow DOM), owns the tracker, stores reads in chrome.storage.
  background.js          Service worker. Forwards solves to the offscreen page (falls back to analyzeSync itself).
  offscreen.js/.html     Full-power mode: pool of solver-worker.js Web Workers (cores - 2). Each runs a Monte Carlo
                         share with `partial: true` (and, heads-up on the turn, its own turn solve for `turnMs`:
                         30% of the time left on the game's clock, 2.5-8 s, 6 s if unknown; the clock is 23 s), with
                         its own river-card samples; one final analysis with `merge` adds the tallies, averages the
                         turn solves (`solvedMerge`) and runs the preflop and river solvers. Budget = POWER x the
                         phone's (24x MC, 8x plan samples, 16x river and preflop iterations). One more worker answers
                         `quick` requests with the phone's budget: the overlay shows that within ~1 s ("Quick read")
                         and replaces it with the full solve; if hero acts first, the quick one is logged
                         (`advice.quick`). The tracker's `turn` event carries `timeLeftMs` for this. With
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
- Preflop solver (`preflopSolve`): heads-up preflop spots (one opponent left, any action so far) and opens with
  2-8 players still to act (all pending; they are one "field" whose hand is the strongest continuing one,
  `fieldMax`; no open-limp option there). Discounted CFR over the 169 classes, compatible-pair counts from
  `preflopCompat`, O(169) blocker totals in `classMass`. Tree: hero's scenario sizes at the root, then pot-size
  raises and all-ins, up to 4 raises. Leaves: fold, all-in (table equity), flop (pot split by realized shares,
  `shares`: equity x 0.92 + strength, suited/connected/pair bonus, +-0.06 position, faded toward raw equity below SPR
  4). The opponent's fixed strategy uses the Monte Carlo's `sc.opp` cont rates at the first response and
  `continueRule` deeper; 3-bets from `stats.threeBet`. Phone 300 iterations, computer 4800 / 2.5 s.
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
  (1,000 deals 4-handed, turn solver on in both, v1.7.4). ~25-45 ms per iteration in the cloud sandbox; each
  offscreen worker solves for `turnMs` and the results are averaged.
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
  loops), with about 50-230 MB of kernel memory per solve. Still off: on v1.7.4, 4-handed, 1,000 deals, flop solver
  with a 24,000-iteration Monte Carlo -37.2 ± 24.6 against the same Monte Carlo alone, and about -33 with the sim's
  3,000 (speed thread). The sim's 3,000 Monte Carlo iterations against 24,000: -4.8 ± 21 (the 64 ± 38 gap at 400 deals
  was noise).
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
- Range noise (`applyAction`): each line keeps a share `rangeNoise` (home prior 0.45, MAP per player from showdown
  likelihoods `nl` over `NOISES`) of hands that take it whatever their strength; on bets it scales with bluff share
  and bet size (`rangeNoiseAgg`). Without it shown hands scored worse than a random guess.
- Raise wars: 4-bet/5-bet ranges are the narrowed range plus ordinary hands (VPIP range); the ordinary share is
  clamp(2.2 x PFR/VPIP, 0.1, 1) x the narrow range's mass (`WAR_MIX` 2.2), so it differs per player.
- Turn and river raises keep only a quarter of the range noise, with no extra for small raises (8 of 10 shown river
  raises were strong).
- Limpers facing a raise: tally `limpFaceN`/`limpFold`, `stats.limpFold` (prior 0.52, k 6; friends 29-86%);
  continueRule's preflop base for callers is 1 - limpFold (was 0.5). Simulator vs the limp-aware bots: -1.3 ± 20.7.
- `betcall` street action (bet, then called a raise): buildRange applies the call after the bet; counts as aggressor.
- Tilt: home prior agg 0, pas -0.15 (betting lines fit +0.15 but showdowns over-sample value there).
- Read accuracy: showdowns (`scoreShow`, `FIT_VERSION` 2, stale fits rescored a few per hand by `rescoreStale`) and
  every action (`tracker.predictor` = `makePredictor`, tally `pred` {n, read, pop}: log-loss of the read vs an
  average player). Trust = showdown hit rate x action score; exploitWeight = clamp((0.5 + 0.4 n/120) x trust, 0.3,
  0.95). The opponent's fixed strategy in the solvers gets weight exploitWeight, an adaptive one the rest.
- `test/reads-bench.js <logs>`: sequential prediction benchmark (log-loss by seen-hands bucket, open responses,
  shown-hand likelihood). `--engine=a,b` compares engines, `--from=<ISO>` scores only later hands. v1.4.0 vs the
  rebuild on three logs: actions 0.831 -> 0.787, seen 0-9 0.958 -> 0.879, open responses 1.31 -> 1.00, shown hands
  x0.73 -> x1.72 (on the 100 hands the priors never saw: 0.809 -> 0.776, x0.92 -> x1.45). Simulator: about +8 ± 12.
- `foldAfterAgg` (tally `aggVsN`/`aggVsFold`): folding to a bet after having bet or raised earlier in the hand.
  When an opponent has an aggressive line (`aggroLine`), plans and the river solver scale fold rates by
  foldAfterAgg / foldToBet. Without it the solver floated turn bets with air planning river bluffs.
- Close spots return `mix` (two options with frequencies) and `best` is picked from it with the input `seed`, which
  the tracker randomizes per decision. Pass `mix: false` and a fixed `seed` for deterministic tests.
- `db.history` keeps the last 150 hands for the "Hand log" export. Each entry has `log` (every action in order with
  `amt` added, `to`, `pot` before it, `facing`, `stack` before it, `potPct` for bets/raises, blinds as `sb`/`bb`),
  each player's starting `stack`, `advice` (pot, price, equity, hand, top 5 options with EVs, reads, hero's actual
  action in `did` and `followed`), and `net`/`heroNet`/`heroNetBB`, filled in from the next hand's starting stacks.
- Preflop shoves and big raises (8+ bb): opponents continue at least at `stats.callBig` (tally `pfBigOpp`/`pfBigCall`,
  prior 0.75 x VPIP, clamped 0.18-0.45). The old size math had them folding 85%+ to a shove, so it shoved 9-5 at 25bb.
  Players already in the pot (limpers, raisers) get a higher floor. Hand log players carry `fit` and `accuracy`
  (`accuracySummary` in tracker.js); advice `reads` carry trust, accuracy, strengthBias and callBig.
- Raw recorder (`recordRaw` in tracker.js): each hand-log entry has `raw`, every game event of the hand
  (`{ t: ms since set_blinds, ev, d, s?: [id, name, stack, pos, state] }`), for the newest 100 hands (60 on the
  userscript, whose localStorage is shared with the game; `save` drops raw first when full). Both hooks forward all
  `game:`/`player:game:`/`admin:game:` events and `game_log` chat for this; the tracker ignores unknown ones.
  Replay a raw hand by feeding `d` back through `handle`.
- Extra tally fields: `limpOpp/limp`, `f3betOpp/f3bet`, `donkOpp/donk`, `xrOpp/xr`, `wonSD/wonNoSD` (from stack
  changes), `tt` (think time per action kind). Shows carry `ms` per action. Not used by the engine yet.
  `node test/analyze-log.js <export.json>` prints hero results by kind of spot.
- Showdown reads only see hands that were shown, so they over-sample hands that got called. Bluffs that won
  uncontested are invisible unless the player shows voluntarily.
- Tally format (tracker.js `blankTally`): flat counts plus `st` (per street), `vs` (reaction by facing-bet size),
  `betSize`, 3-bet / c-bet counters, `sawFlop`/`wtsd` and `shows` (last 40 revealed hands with their bets).
  `upgradeTally` fills in fields for reads saved by older versions.
- Joining mid-hand: tracking starts at the next `set_blinds`.
- Reads are keyed by `authUserId` (anonymous guest ids can change if a friend clears their browser).
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
  tie-break -6.2 ± 12.7.
- Check-line reads (#47): facing a bet after checking on that street, friends fold more (fold odds x1.25) and check-
  raise half as often as their raise rate says; facing a bet before acting on the street (a lead) they raise 1.4x as
  often (READ_PRIORS.home.line; computeStats ctx.line / ctx.street moves only that street's foldToBet and raiseFreq,
  statsHU too; predictAction and the tracker's predictor take d.checked). Facing-bet log-loss: old session 0.895 ->
  0.877, new 0.869 -> 0.857, each session alone fits about the same. Bots fold the same way (after checking 59%, old
  read 54%). Simulator -9.5 ± 14.2 and +15.0 ± 14.1 on two seeds (neutral).
- Multiway fold structure (logs, first bets of 25-110% pot answered by 2+ friends, 128 hands): the first to answer
  folds 47%, the last 52% when the rest folded but 69% when someone stayed, and two players both fold 21% (three:
  26%). Multiplying each player's multiway fold rate gave about 38% for two. Since v1.7.2 players answer a bet in turn
  (those still to act first, then those who acted before hero): until someone stays each answers with their heads-up
  read (`sc.oppHU`, `respOrder` in `decide`), after that with the multiway one; the field solvers fold with the
  product of heads-up reads (`fieldStats(list, base, foldList)`). Against the old bots, which over-folded multiway
  the same way as the model (two fold together 38%), this lost -27 ± 20; against the refit bots (#36: 53% / 53% /
  63%, two together 31%) it gained +32.8 ± 21.2 (1,000 deals 4-handed; weak hands +30 ± 10, SB +33 ± 13).
  Open lead: after someone has called, the logs fold 54% where the multiway read says 47% (37 spots; no caller yet:
  52% vs 57%, 93 spots, before #39's heads-up first answers).
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
  16). Bots are simple; this is a regression check, not proof
  of an edge against real players.
- Tuning sweep (sim thread, fresh-deal confirmations vs current constants, 4-handed refit bots): robustWeight
  0.35->0.7 -13.8 ± 11.5 (2,400 deals; +21.9 in the sweep), exploitWeight x0.75 +2.8 ± 12.7, credibility off
  +18.1 ± 13.9 (not taken: bots ignore hero's line; logs fold 58% after an aggressive hero line vs 46% after a passive one,
  n 24/50), postflop raise sizes [0.6, 1] -> [0.6, 1, 1.5] +9.5 ± 11.7 on v1.7.1 but -3.1 ± 8.6 over 4,000 deals on
  v1.7.4. Bet menus, river sizes, shove thresholds and the 0.8 raise-equity cut lost or stayed flat by 1,200 deals.
  No constants changed. Knobs: test/sim/knobs.js, tune.js.
- Monte Carlo budgets (speed thread): against a 384,000-iteration reference on 104 logged postflop spots, 24,000
  (phone) picks the same 97% of the time (0.001 bb per decision), 48,000 97%, 96,000 100%. No build needs a bigger
  budget. The sim's --iters 3000 picks differ more often, but over 1,000 deals it plays about as well (-4.8 ± 21).
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
