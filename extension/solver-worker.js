// One solver worker in the offscreen pool.
importScripts('engine.js', 'slim.js');
self.onmessage = (e) => {
  const { id, mode, input } = e.data;
  try {
    if (mode === 'partial') {
      const out = PokerEngine.analyzeSync(Object.assign({}, input, { partial: true }));
      self.postMessage({ id, ok: true, partial: out.partial, solved: out.solved, kernels: PokerEngine.kernelsActive() });
    } else {
      self.postMessage({ id, ok: true, result: slim(PokerEngine.analyzeSync(input)), kernels: PokerEngine.kernelsActive() });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
