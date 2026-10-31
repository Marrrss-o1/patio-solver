# Patio Solver: notes for Claude

Live solver overlay for **Poker Patio private lobbies** (pokerpatio.com/mp). The owner plays with a small group of
friends who all use helpers; everyone has agreed to it. The overlay is **read-only advice**. Keep it that way:
never add code that clicks, sends `player:game:perform_action`, or otherwise plays for the user. Keep the
`tableType === "private"` gate, so it never runs at public tables with strangers.

## Layout

```
src/engine.js            The solver (exploitative Monte Carlo). Pure JS, no deps. Shared by both builds.
src/tracker.js           Socket events -> hand state, opponent tallies, solver input. Pure JS, unit-tested.
src/userscript-core.js   iPhone/userscript UI + in-page socket hook + Web Worker solver.
extension/               Chrome MV3 extension (Load unpacked on this folder).
  hook.js                MAIN-world script: attaches socket.onAny, posts events + state snapshot via postMessage.
  overlay.js             Isolated-world panel (shadow DOM), owns the tracker, stores reads in chrome.storage.
  background.js          Service worker that runs engine.analyzeSync (keeps the page thread free).
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
npm test                 # node replay tests: real recorded hand + synthetic 3-handed hand
npm run test:extension   # loads the real extension in Chromium on a fake pokerpatio page, replays a hand
npm run test:mobile      # runs the userscript on an iPhone-sized fake table, replays a hand
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
  can raise once per street (hero raises with about 80%+ equity against the betting range); with 2+ opponents
  there are no raises. Hero only bluffs the river. Preflop has no lookahead (a flop-by-flop playout is too slow
  for a phone). Instead `realize` there depends on position, suitedness, connectedness, pairs, opponent count and
  stack depth.
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
- River solver (`riverSolve` in engine.js): heads-up river spots only. Discounted CFR over hero's range vs the
  opponent's, with hero bets of 50/100/200% pot, the opponent's usual bet size and one raise. The opponent plays
  their read's strategy with weight `exploitWeight` and an adaptive one with the rest. Hero's range comes from
  `input.heroActions` (passed by the tracker) run through `buildRange` with typical-player stats. When it runs, its
  frequencies and EVs replace the Monte Carlo ranking, and the Monte Carlo is cut to 6000 iterations (equity only).
- Counts decay 1% per hand a player is dealt into (`DECAY` in tracker.js), so they are floats. Round before display.
- Close spots return `mix` (two options with frequencies) and `best` is picked from it with the input `seed`, which
  the tracker randomizes per decision. Pass `mix: false` and a fixed `seed` for deterministic tests.
- `db.history` keeps the last 150 hands (actions, shown cards, advice) for the "Hand log" export.
- Showdown reads only see hands that were shown, so they over-sample hands that got called. Bluffs that won
  uncontested are invisible unless the player shows voluntarily.
- Tally format (tracker.js `blankTally`): flat counts plus `st` (per street), `vs` (reaction by facing-bet size),
  `betSize`, 3-bet / c-bet counters, `sawFlop`/`wtsd` and `shows` (last 40 revealed hands with their bets).
  `upgradeTally` fills in fields for reads saved by older versions.
- Joining mid-hand: tracking starts at the next `set_blinds`.
- Reads are keyed by `authUserId` (anonymous guest ids can change if a friend clears their browser).
- Extension and userscript keep separate read databases (chrome.storage vs page localStorage).
- Ideas: river solver for multiway pots, multi-street CFR on the turn, raises in the multiway lookahead.
  (Syncing reads between devices is not wanted: the owner keeps phone and computer separate.)

## Testing limits in the cloud sandbox

The cloud sandbox network usually cannot reach pokerpatio.com, so live testing has to happen in the owner's
browser. Use the recorded fixtures plus the Playwright harnesses for everything else. When you add support for a
new event shape, add a fixture and a test in `test/replay.test.js`.
