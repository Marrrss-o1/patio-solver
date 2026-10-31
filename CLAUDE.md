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
- Side pots are not modelled (the engine treats all chips as one pot).
- Lookahead (`makePlan` / `playOut` in engine.js) only runs on the flop and turn once hero is heads-up. Preflop and
  multiway pots still use the `realize` fudge factor. Inside the lookahead nobody raises, and hero only bluffs the river.
  It plays each runout against 4 opponent versions (`VARIANTS`: as read, foldier, stickier, more aggressive) and
  blends in the worst one by `robustWeight` (larger when reads are thin).
- Confidence-pinned exploitation: `computeStats` blends fold rates and value shares toward balanced play with weight
  `exploitWeight` (0.5 with no hands up to 0.9, scaled by read accuracy). The 0.5 floor is a deliberate choice: the
  default read is a typical amateur, which is a better guess for a home game than balanced play.
- Read accuracy: when an opponent shows cards, `tracker.scorer` (set by both UIs to `PokerEngine.scoreShow`) stores
  `fit = { top, lr, sq }` on the show. `computeStats` turns these into `accuracy`, a trust factor, and
  `strengthBias`, which tilts that player's ranges weaker or stronger in `buildRange`.
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
- Ideas: real-time river range-vs-range solver (CFR), raises inside the lookahead, lookahead for multiway pots and
  preflop, a model of hero's own range, side pots, syncing reads between devices.

## Testing limits in the cloud sandbox

The cloud sandbox network usually cannot reach pokerpatio.com, so live testing has to happen in the owner's
browser. Use the recorded fixtures plus the Playwright harnesses for everything else. When you add support for a
new event shape, add a fixture and a test in `test/replay.test.js`.
