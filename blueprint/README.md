# Blueprint (self-play strategy for 3, 4 and 5-handed 150bb)

A blueprint is a strategy for the whole game computed by self-play, the way Pluribus started: the solver plays
millions of hands against copies of itself and keeps the average of what it learns. On the computer the panel
shows what the blueprint would do in hero's spot (how often a balanced player folds, calls or raises there). It
can also be blended into the advice as a base strategy that the reads move away from, but that is off by default
because it lost against the friends in the simulator (see the end of this file).

```
blueprint/trainer.c   the trainer (C, no dependencies)
blueprint/run.sh      trains one table size in chunks that save and resume
blueprint/publish.sh  copies finished blueprints into the extension and rebuilds
src/blueprint.js      the lookup (rebuilds the same betting tree and card buckets, follows a real hand down it)
extension/blueprint-3max.bin.gz ...   the trained files the extension loads (Load unpacked; the dist zip leaves them out)
```

## How it learns

External-sampling Monte Carlo CFR with Linear CFR discounting and negative-regret pruning (the Pluribus recipe):

* Each iteration deals a random hand and walks the tree once for one player, trying every action at that player's
  decisions and sampling everyone else's. Regrets (how much better each action would have done) accumulate per
  decision point and hand bucket; the strategy is regret matching on them, and the blueprint is the average.
* Every 20M iterations the regrets and averages are scaled by k/(k+1), so the random early play fades out.
* After 30M iterations, 95% of iterations skip actions with very negative regret (except on the river and for
  actions that end the hand). That is most of the speed later on.

### Abstraction

The real game is far too big, so the trainer plays a smaller one:

* **Bets**: a few sizes per street and raise level, plus all-in, set by `--sizes` (`|` between streets, `/`
  between raise levels, `,` between sizes, in pot fractions; a raise is "to" the current bet plus that fraction of
  the pot after calling). Real bets are mapped to the nearest abstract size with pseudo-harmonic translation; a raise
  that is not all-in is never read as all-in.
* **Cards**: preflop is exact (169 hands). Flop and turn hands go into buckets by hand strength over every runout
  and by current strength; river buckets by strength percentile, finer at the top. Boards are reduced by suit
  symmetry first.
* **Stacks**: everyone starts at 150bb (the friends' lobby). The overlay uses the blueprint fully from 0.65x to 1.5x
  that depth, fades it out down to 0.35x and up to 2.2x, and does not use it beyond.

| name | players | sizes (preflop / flop / turn / river)      | buckets flop / turn / river | training memory |
|------|---------|--------------------------------------------|-----------------------------|-----------------|
| 3max | 3       | 2.9 and 4.1bb opens, pot 3-bets / 33, 75% / 60% / 50, 100% | 128 / 96 / 64 | 0.3 GB |
| 4max | 4       | pot opens and 3-bets / 50% / 50% / 50%     | 64 / 64 / 48                | 0.6 GB          |
| 5max | 5       | pot opens and 3-bets / 50% / 50% / 50%     | 48 / 32 / 32                | 1.4 GB          |

Raise levels after the listed ones are all-in only. 4max exports preflop to turn and 5max preflop and flop (later
streets fall back to the normal solver), which keeps the files small.

## Training on the MacBook

Needs Xcode's command line tools (`xcode-select --install`), nothing else.

```
cd patio-solver
blueprint/run.sh 3max 600 4           # 600 minutes on 4 threads, in 30-minute chunks
blueprint/run.sh 5max 600 4 ~/bp 60   # same, copy each chunk's checkpoint to ~/bp, 60-minute chunks
touch blueprint/out/3max.stop         # stop after the current chunk
blueprint/publish.sh                  # copy blueprint/out/*.bin into the extension and rebuild
```

* It resumes from `blueprint/out/<name>.ckpt`, so a run can be stopped any time (Ctrl-C loses at most the current
  chunk) and continued later with the same command. The checkpoint only works with the same flags; change the sizes
  or buckets and it starts over.
* Each chunk writes the blueprint to `blueprint/out/<name>.bin`. More iterations are better, with diminishing
  returns: the log line `ev by seat` settles down as it converges.
* The first start computes card buckets (seconds for 3max, a few minutes for 5max) and caches them in
  `blueprint/out/buckets-*.bin`.
* Threads share the tables without locks, so throughput scales with cores. Leave a core or two free if you are
  using the laptop. Memory stays at the figure in the table above, so all three fit at once in 24 GB.
* `--tree` prints the tree size and hash without training; `--dump-buckets N` prints N random hands with their
  buckets (that is how `test/fixtures/blueprint-buckets.txt` was made, and `npm test` checks the JS against it).

## How the overlay uses it

Computer mode only (the offscreen solver loads `blueprint-<n>max.bin.gz` on the first full analysis, about a
second each; the phone userscript does not load them). When the table size has a blueprint, the stacks are near
150bb and the hand so far maps onto the tree, the panel shows the blueprint's own frequencies on the
"Blueprint (self-play)" line, and the hand log keeps them with each advice (`advice[].bp`). The advice itself is
**not** changed by default, because blending it in lost in the simulator (below).

The blend is there for experiments: `input.blueprint = true` turns it on (`false` skips the lookup entirely). In
`createAnalysis` (engine.js, `blueprintBlend`):

```
freq(option) ~ (blueprint(option) + floor) x exp((EV(option) - best EV) / tau)
tau = (pot + to call) x (thin 0.15 with thin reads ... solid 0.03 with solid reads)
```

EV is the existing Monte Carlo / solver EV against the reads. `input.blueprintTemp = { thin, solid, floor }` sets
the constants (floor 0.01: the blueprint can overrule an EV edge of up to tau x ln(1 / floor)),
`input.blueprintStreets` ('0123') limits the streets, and `input.blueprintOverSolver = false` keeps a solver's
answer where one ran.

### What the simulator says

Paired A/B in `test/sim/run.js` against the bots fitted to the friends (150bb, duplicate deals, AIVAT), blend on
minus off, with the first exports (80-90M iterations each):

| table     | blend                                  | deals | B - A (bb/100) | where it loses               |
|-----------|----------------------------------------|-------|----------------|------------------------------|
| 3-handed  | default (thin 0.15, solid 0.03)        | 3,000 | -9.6 ± 18.9    | small blind -17, premiums -6 |
| 4-handed  | light (thin 0.05, solid 0.01, floor 0.05) | 3,000 | -25.5 ± 13.7 | blinds -34, premiums -8      |

The blueprint is balanced play for a 150bb game among equals. The friends limp, call and defend far wider than
that, and the reads already exploit it; pulling toward balance folds the blinds more than these opponents
deserve and slow-plays big pairs against players who would have paid off a raise. It could still help against
tougher or adapting players, which the bots don't model; the hand log's `bp` field makes that checkable on real
hands later.
