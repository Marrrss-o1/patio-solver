#!/bin/bash
# Train one blueprint in chunks, keeping a copy of each chunk's checkpoint and export.
#   blueprint/run.sh <3max|4max|5max|hu> <total-minutes> [threads] [keep-dir] [chunk-minutes]
# Resumes from blueprint/out/<name>.ckpt (or the keep-dir copy). Touch blueprint/out/<name>.stop
# to stop after the current chunk. Exports go to blueprint/out/<name>.bin.
set -e
cd "$(dirname "$0")/.."
NAME=$1; TOTAL=${2:-60}; THREADS=${3:-1}; KEEP=${4:-}; CHUNK=${5:-30}
case "$NAME" in
  hu)   CFG=(--players 2 --stack 1500 --sizes "0.5,0.75,1.25/0.8,1.3/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/" --flop 32x6 --turn 32x6 --river 160) ;;
  3max) CFG=(--players 3 --stack 1500 --sizes "0.75,1.25/1/0.6/|0.33,0.75/0.8/|0.6/0.8/|0.5,1/0.8/" --flop 32x4 --turn 24x4 --river 64) ;;
  4max) CFG=(--players 4 --stack 1500 --sizes "1/1/0.6/|0.5/0.8/|0.5/0.8/|0.5/0.8/" --flop 16x4 --turn 16x4 --river 48 --export-streets 3) ;;
  5max) CFG=(--players 5 --stack 1500 --sizes "1/1/0.6/|0.5/|0.5/|0.5/" --flop 12x4 --turn 8x4 --river 32 --export-streets 2) ;;
  *) echo "unknown blueprint $NAME"; exit 1 ;;
esac
SCHED=(--disc-every 20000000 --lcfr-until 1000000000000 --prune-after 30000000 --prune -3e6)
mkdir -p blueprint/out
[ -x blueprint/train ] || ${CC:-cc} -O3 -ffp-contract=off -pthread -o blueprint/train blueprint/trainer.c -lm
CK=blueprint/out/$NAME.ckpt; BP=blueprint/out/$NAME.bin
if [ ! -f "$CK" ] && [ -n "$KEEP" ] && [ -f "$KEEP/$NAME.ckpt" ]; then cp "$KEEP/$NAME.ckpt" "$CK"; fi
START=$(date +%s)
while [ $(( ($(date +%s) - START) / 60 )) -lt "$TOTAL" ] && [ ! -f "blueprint/out/$NAME.stop" ]; do
  ./blueprint/train "${CFG[@]}" "${SCHED[@]}" --threads "$THREADS" --minutes "$CHUNK" --checkpoint "$CK" --out "$BP"
  if [ -n "$KEEP" ]; then
    mkdir -p "$KEEP"
    cp "$CK" "$KEEP/$NAME.ckpt.tmp" && mv "$KEEP/$NAME.ckpt.tmp" "$KEEP/$NAME.ckpt"
    cp "$BP" "$KEEP/$NAME.bin.tmp" && mv "$KEEP/$NAME.bin.tmp" "$KEEP/$NAME.bin"
  fi
done
echo "finished $NAME"
