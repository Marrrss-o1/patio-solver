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
1. Install **Userscripts** (free) from the App Store and open it once. It asks you to pick a folder for scripts: pick
   (or make) a **Userscripts** folder in Files, On My iPhone.
2. Settings → Apps → Safari → Extensions → **Userscripts**: turn it on and allow it on all websites (or pokerpatio.com).
3. Save `dist/patio-solver.user.js` into that folder (from the Files app, or Safari's download button → Save to Files).
   To update later, save the new file over the old one.
4. Open your lobby in **Safari**. Tap the bar to expand it, and drag it to move it. The bottom line of the panel says
   the version.

The phone runs the computer's full solve on its own cores (two Web Workers on an iPhone), so a decision takes about
2-8 seconds instead of under one; the bar counts the seconds while it thinks. If you act before it is done, nothing is
shown for that decision. Reads and the hand log (newest 1,000 hands) are kept in the site's storage in Safari.

**Copy the computer's reads to the phone:** on the computer's panel click **Export reads**, get the file to the phone
(AirDrop, or iCloud Drive), then on the phone tap **Reads file → Import**, pick the file, and tap **Replace this
phone's reads**. Back the other way after a phone session: **Reads file → Export reads** on the phone (Share… →
AirDrop), then **Import** on the computer's panel and **Replace these reads**. Each side keeps its own reads otherwise,
so copy them over before switching, or the reads you replace lose the hands played since.

Also works with Tampermonkey / Violentmonkey on desktop browsers and Firefox for Android.

## How it works

1. **Listen.** Poker Patio sends your browser a socket.io message for every blind, card, bet and street. The
   overlay listens to those same messages (read-only), so it has exact amounts instead of reading the screen.
2. **Track.** It rebuilds the hand (pot, amount to call, who's folded or all-in, position, each player's action per
   street) and counts every action into a per-player profile: VPIP, PFR, 3-bet, c-bet, aggression and fold-to-bet
   per street, how often they fold to small, medium and large bets, their usual bet size, and how often they go to
   showdown. When a player's cards are shown, it checks each bet they made in that hand and logs it as value or a
   bluff, and checks how well its range guess matched the hand. Players whose shown hands keep coming out weaker
   or stronger than predicted get their ranges shifted, and reads that keep missing get trusted less. Recent hands
   count more than old ones. Small samples are blended with table defaults (the Tight / Typical / Loose setting)
   and, while a read is thin, partly with balanced play so one lucky read can't push it into a big mistake.
   Reads belong to a player's account, so a name change keeps them. When a friend comes back on a new account
   under a name the reads already know, the panel asks "Same player as the older read?" and joins the two only
   if you say so; "Link reads" joins or splits any two players by hand (never two who played the same hand).
3. **Range.** The solver turns each opponent's stats into a weighted range over all 1,326 starting hands, then
   narrows it by what they did this hand on each street, using that street's numbers, the size they bet and how
   often their bets of that size turned out to be bluffs. When someone bets into you, the panel says how likely
   that bet is a bluff. In your pots, a player who only checked or called the flop and keeps putting chips in is
   read stronger once the table's own showdowns show that habit (your friends check-call strong hands against you).
4. **Simulate.** For every option (fold, check, call, a few bet and raise sizes) it deals opponents hands from
   their ranges and runs out the board thousands of times, with opponents folding according to their stats and the
   bet size. On the flop and turn, once it's you against one player, it also plays out the later streets: they bet,
   bluff, call and fold the way their reads say, and you follow a sensible plan (value-bet when ahead of their
   calling range, call when the price is right, bluff the river when they fold enough). The option with the
   highest average result is recommended. It also checks each option against versions of the opponent who fold,
   call or bluff more than the read says, and prefers options that hold up. When two options are close it shows a
   mix (for example "Bet 60% · Check 40%") and picks one at random, so your play doesn't become predictable.
5. **River solve.** On the river against one player, it solves your whole range against theirs (the same kind of
   real-time solving the strongest poker bots use), with their tendencies built in. The panel shows how often to
   play each option, so it can tell you to bluff some hands and call down with the right bluff-catchers.
6. **Review.** "Hand log" downloads hands with everyone's actions, shown cards and the advice given. It offers the
   hands since your last export, one session, or every stored hand (it keeps the newest 1,000; on the phone, tap Save
   to Files or Share… once the file is ready). `node test/merge-logs.js all.json <exports or folders>` joins several
   exports into one.

See `docs/protocol.md` for the game's message format and `CLAUDE.md` for developer notes.

## Develop

```
npm run build     # edit src/, then build: updates extension/ and dist/
npm test          # replay tests
npm run test:extension
npm run test:mobile
```
