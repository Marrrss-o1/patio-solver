# Patio Solver: notes for Claude

Live solver overlay for **Poker Patio private lobbies** (pokerpatio.com/mp). The owner plays with a small group of
friends who all use helpers; everyone has agreed to it. The overlay is **read-only advice**. Keep it that way:
never add code that clicks, sends `player:game:perform_action`, or otherwise plays for the user. Keep the
`tableType === "private"` gate, so it never runs at public tables with strangers.

## Layout

```
src/engine.js            The solver (exploitative Monte Carlo + CFR solvers). Pure JS, no deps. Shared by both builds.
                         Holds the 169x169 preflop equity table (`PF_EQ_B64`, written by scripts/preflop-equity.js).
src/tracker.js           Socket events -> hand state, opponent tallies, solver input. Pure JS, unit-tested.
src/userscript-core.js   iPhone/userscript UI + in-page socket hook + Web Worker solver.
extension/               Chrome MV3 extension (Load unpacked on this folder).
  hook.js                MAIN-world script: attaches socket.onAny, posts events + state snapshot via postMessage.
  overlay.js             Isolated-world panel (shadow DOM), owns the tracker, stores reads in chrome.storage.
  background.js          Service worker. Forwards solves to the offscreen page (falls back to analyzeSync itself).
  offscreen.js/.html     Full-power mode: pool of solver-worker.js Web Workers (cores - 2). Each runs a Monte Carlo
                         share with `partial: true` (and, heads-up on the turn, its own turn solve for TURN_MS with
                         its own river-card samples); one final analysis with `merge` adds the tallies, averages the
                         turn solves (`solvedMerge`) and runs the preflop and river solvers. Budget = POWER x the
                         phone's (24x MC, 8x plan samples, 8x river and preflop iterations).
  slim.js                Shrinks a result for the overlay (used by background and workers).
  engine.js, tracker.js  COPIES of src/ written by the build. Edit src/, then run the build.
dist/patio-solver.user.js       Built userscript (Userscripts app on iOS Safari, Tampermonkey, Violentmonkey).
dist/patio-solver-extension.zip Built extension zip.
docs/protocol.md         What the game's socket sends. Read this before touching tracker.js.
test/                    replay.test.js (node), Playwright harnesses, recorded + synthetic fixtures
                         (synth-showdown.json: heads-up hand that ends with the opponent's cards shown).
```

## Commands

```
npm run build            # copies src/ into extension/, builds dist/ (bumps manifest version from package.json)
node scripts/preflop-equity.js   # rebuilds the preflop equity table in src/engine.js (~1 min on 4 cores)
npm test                 # node replay tests: real recorded hand + synthetic 3-handed hand
npm run test:extension   # loads the real extension in Chromium on a fake pokerpatio page, replays a hand
npm run test:mobile      # runs the userscript on an iPhone-sized fake table, replays a hand
npm run sim              # heads-up simulator: solver (through the real tracker) vs bots; see test/sim.js for args
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

- **Verified heads-up only in a live lobby.** Multiway logic is covered by a synthetic 3-handed test, but the
  assumption that seats run clockwise in ascending number (s1 → s10) has not been confirmed live. If position
  looks wrong in a real 4+ player game, that is the first suspect (`solverInput` in tracker.js).
- Side pots: modelled at showdown when the tracker passes `heroCommitted` and each opponent's `committed`/`stack`
  (`sidePotWin` in engine.js). The multiway lookahead skips spots with a short stack and falls back to that.
- Lookahead (`makePlan`, `playOut`, `playOutMulti` in engine.js) runs on the flop and turn. Heads-up, either side
  can raise once per street (hero raises with about 80%+ equity against the betting range). Multiway is a betting
  round in seat order (hero first OOP, last IP) with one raise per street; after hero checks with players still to
  act, the current street is played first (checking is not a free card); once one opponent is left it hands over to
  `playOut` (with `from`). Hero only bluffs the river. Preflop has no lookahead; the preflop solver (below) covers
  the spots it can, and the Monte Carlo's `realize` (position, suitedness, connectedness, pairs, opponent count and
  stack depth) the rest.
- Preflop solver (`preflopSolve`): heads-up preflop spots (one opponent left, any action so far) and opens with
  2-8 players still to act (all pending; they are one "field" whose hand is the strongest continuing one,
  `fieldMax`; no open-limp option there). Discounted CFR over the 169 classes, compatible-pair counts from
  `preflopCompat`, O(169) blocker totals in `classMass`. Tree: hero's scenario sizes at the root, then pot-size
  raises and all-ins, up to 4 raises. Leaves: fold, all-in (table equity), flop (pot split by realized shares,
  `shares`: equity x 0.92 + strength, suited/connected/pair bonus, +-0.06 position, faded toward raw equity below SPR
  4). The opponent's fixed strategy uses the Monte Carlo's `sc.opp` cont rates at the first response and
  `continueRule` deeper; 3-bets from `stats.threeBet`. Phone 300 iterations (~1 ms each), computer 2400 / 1.5 s.
  `vsOpenRead` reads `stats.vsOpen` ({small <=2.5bb, medium <=3.5bb, large} x {cont, threeBet}) when the tracker
  provides it, so learned defence by open size feeds both the Monte Carlo (`continueRule` via `kind.openTo`) and the
  preflop solver's first response. Without it the old size-blind rule (VPIP-based) is used.
  Limpers plus players behind, or a raise plus players behind, still use the Monte Carlo.
- Turn solver (`turnSolve`, computer only: `input.turnSolver === true`, heads-up, effective stack): turn and river in
  one Discounted CFR. Turn: hero 50/100% pot, opponent their size, one raise; each line that reaches the river gets
  a river subgame per card (built lazily; OOP first, hero 66%, one raise); each iteration samples 6 river cards
  (`turnRiverSamples`), the final pass uses all 48. Hero and opponent hands are indexed separately and pruned
  (hero < 3% of max weight, opponent < 1%). The opponent's river fixed strategy uses their read's reach along that
  line. ~15-30 ms per iteration; each offscreen worker solves for 4 s and the results are averaged.
- Hero's story: with `heroActions`, the engine builds hero's range as a typical player's. If that range looks
  stronger than average on the board, opponents' fold rates shift up (`credibility`, up to ±8%). The river solver
  models hero's range directly, so it does not take the shift.
  It plays each runout against 4 opponent versions (`VARIANTS`: as read, foldier, stickier, more aggressive) and
  blends in the worst one by `robustWeight` (larger when reads are thin).
- Confidence-pinned exploitation: `computeStats` blends fold rates and value shares toward balanced play with weight
  `exploitWeight` (0.5 with no hands up to 0.9, scaled by read accuracy). The 0.5 floor is a deliberate choice: the
  default read is a typical amateur, which is a better guess for a home game than balanced play.
- Read accuracy: when an opponent shows cards, `tracker.scorer` (set by both UIs to `PokerEngine.scoreShow`) stores
  `fit = { top, lr, sq }` on the show. `computeStats` turns these into `accuracy`, a trust factor, and
  `strengthBias`, which tilts that player's ranges weaker or stronger in `buildRange`.
- Multiway river (2-5 opponents, no side pots): `riverSolve` against the field as one opponent whose range is the
  strongest live hand, sampled jointly; it plays like the aggressor or the stickiest caller.
- River solver (`riverSolve` in engine.js): heads-up river spots (and multiway as above). Discounted CFR over hero's range vs the
  opponent's, with hero bets of 33/66/100% pot, the opponent's usual bet size and one raise. The opponent plays
  their read's strategy with weight `exploitWeight` and an adaptive one with the rest. Hero's range comes from
  `input.heroActions` (passed by the tracker) run through `buildRange` with typical-player stats. When it runs, its
  frequencies and EVs replace the Monte Carlo ranking, and the Monte Carlo is cut to 6000 iterations (equity only).
- Counts decay 0.3% per hand a player is dealt into (`DECAY` = 0.997 in tracker.js, about 330 hands of memory; it
  was 1%, which forgot everything after ~100 hands), so they are floats. Round before display. Last 80 shows kept.
- Preflop ranges are soft (`topClassWeights` uses a sigmoid edge, plus a small floor for every hand). Hard top-X%
  cut-offs gave zero weight to hands people really play (KQo raises at 8% PFR), which made reads predict shown
  hands worse than a random guess in the simulator and led to bad turn/river calls.
- Learned range tilt: `scoreShow` stores `tl` (log-likelihood of the shown hand under each `TILTS` step) and `agg`.
  `computeStats` picks `tiltAgg` / `tiltPas` (max likelihood with a 6*t^2 penalty, 3+ shows) and `buildRange` uses
  them by line type, falling back to `strengthBias`.
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
- Bet sizes are capped at 1.5x pot (flop to river) and 1x pot in the river solver. 2x overbets lost real money in
  the owner's home game: friends call big bets far more than the old fold curve assumed. `modelFold` elasticity is
  0.8*sqrt(ftb/0.45) and `foldAtSize` grows only 30% as fast above 1.1 pot. Against a raise, opponents continue
  only with the top of their range (`vsRaise` in `riverSolve`, `raiseCallCut` in `makePlan`).
- Simulator (`test/sim.js`, v1.4.0, DUP=1, 2,000 hands, seed 1, bb/100 won from the bot): typical 46 ± 24 with the
  preflop solver (23 ± 25 with PF=0), maniac 61 ± 35 (104 ± 36 with PF=0), station 171 ± 36 (PF=0). The simple
  solid baseline bot in the same seat: 8 / 41 / 60. Paired PF on minus off: typical +22 ± 20, maniac -44 ± 32 (the
  solver opens 4bb wide and defends the BB less vs limps; the bots' size-blind BB defence is the suspect). Multiway
  4-handed mixed bots (`sim-multi.js`, DUP): +7 ± 40 at v1.3.0. Bots are simple; this is a regression check, not
  proof of an edge against real players.
- Ideas: a flop solver on the computer (three streets; would need card abstraction or much coarser sampling),
  preflop solving for limped/raised pots with players behind. (Syncing reads between devices is not wanted: the
  owner keeps phone and computer separate.)

## Testing limits in the cloud sandbox

The cloud sandbox network usually cannot reach pokerpatio.com, so live testing has to happen in the owner's
browser. Use the recorded fixtures plus the Playwright harnesses for everything else. When you add support for a
new event shape, add a fixture and a test in `test/replay.test.js`.
