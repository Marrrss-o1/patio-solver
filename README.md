# Patio Solver

A live solver overlay for **Poker Patio private lobbies**. It reads the game as you play, keeps reads on every
player automatically, and shows a recommendation when it's your turn (for example "Raise to $70 · +$67 expected"),
along with your equity, the price of calling, your position, every option ranked, and what each opponent likely holds.

Advice only: it never clicks or acts for you. It also switches itself off at public tables.

## Install

### Computer (Chrome)
1. Download `dist/patio-solver-extension.zip` and unzip it, or clone this repo and use the `extension/` folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. Open or refresh your lobby. The panel appears top-right. Drag it to move it, or press – to shrink it.

### iPhone (Safari)
1. Install **Userscripts** (free) from the App Store and open it once.
2. Settings → Apps → Safari → Extensions → **Userscripts**: turn it on and allow it on all websites (or pokerpatio.com).
3. Save `dist/patio-solver.user.js` into the **Userscripts** folder in Files.
4. Open your lobby in **Safari**. Tap the bar to expand it, and drag it to move it.

Also works with Tampermonkey / Violentmonkey on desktop browsers and Firefox for Android.

## How it works

1. **Listen.** Poker Patio sends your browser a socket.io message for every blind, card, bet and street. The
   overlay listens to those same messages (read-only), so it has exact amounts instead of reading the screen.
2. **Track.** It rebuilds the hand (pot, amount to call, who's folded or all-in, position, each player's action per
   street) and counts every action into a per-player profile: VPIP, PFR, aggression and fold-to-bet. Small samples
   are blended with table defaults (the Tight / Typical / Loose setting).
3. **Range.** The solver turns each opponent's stats into a weighted range over all 1,326 starting hands, then
   narrows it by what they did this hand on each street.
4. **Simulate.** For every option (fold, check, call, a few bet and raise sizes) it deals opponents hands from
   their ranges and runs out the board thousands of times, with opponents folding according to their stats and the
   bet size. The option with the highest average result is recommended.

See `docs/protocol.md` for the game's message format and `CLAUDE.md` for developer notes.

## Develop

```
npm run build     # edit src/, then build: updates extension/ and dist/
npm test          # replay tests
npm run test:extension
npm run test:mobile
```
