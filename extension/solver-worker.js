// One solver worker in the offscreen pool.
importScripts('engine.js', 'slim.js', 'blueprint.js');
// Blueprint strategies (one per table size, gzipped) are only needed for the final pass, so only
// that worker loads them (offscreen.js asks it to as it starts). A
// missing file just means no blueprint for that size.
const BLUEPRINT_FILES = ['blueprint-3max.bin.gz', 'blueprint-4max.bin.gz', 'blueprint-5max.bin.gz'];
let blueprints = null;
async function loadOne(name) {
  try {
    const r = await fetch(name);
    if (!r.ok) return null;
    const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return PatioBlueprint.load(buf);
  } catch (e) {
    return null;
  }
}
function loadBlueprints() {
  if (!blueprints) {
    blueprints = Promise.all(BLUEPRINT_FILES.map(loadOne)).then((list) => {
      const got = list.filter(Boolean);
      if (got.length) PokerEngine.setBlueprint(got);
      return got.length;
    });
  }
  return blueprints;
}
self.onmessage = async (e) => {
  const { id, mode, input } = e.data;
  // Load the blueprints ahead of the first decision (no answer).
  if (mode === 'warm') { loadBlueprints(); return; }
  try {
    if (mode === 'partial') {
      const out = PokerEngine.analyzeSync(Object.assign({}, input, { partial: true }));
      self.postMessage({ id, ok: true, partial: out.partial, solved: out.solved, kernels: PokerEngine.kernelsActive() });
    } else {
      if (input.blueprint !== false) await loadBlueprints();
      self.postMessage({ id, ok: true, result: slim(PokerEngine.analyzeSync(input)), kernels: PokerEngine.kernelsActive() });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
