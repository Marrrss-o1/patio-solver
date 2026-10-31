#!/bin/bash
# Copy the latest exported blueprints into the extension (gzipped) and rebuild.
#   blueprint/publish.sh [dir]   (default blueprint/out; reads 3max.bin, 4max.bin, 5max.bin)
set -e
cd "$(dirname "$0")/.."
DIR=${1:-blueprint/out}
for n in 3max 4max 5max; do
  [ -f "$DIR/$n.bin" ] || continue
  node -e "const b=require('./src/blueprint.js').load(require('fs').readFileSync('$DIR/$n.bin'));console.log('$n ok:', b.head.iterations, 'iterations,', b.tree.nodes.length, 'nodes')"
  gzip -9 -c "$DIR/$n.bin" > "extension/blueprint-$n.bin.gz"
done
ls -la extension/blueprint-*.bin.gz
node scripts/build.js
