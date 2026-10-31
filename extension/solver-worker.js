// One solver worker in the offscreen pool.
importScripts('engine.js', 'slim.js');
self.onmessage = (e) => {
  const { id, mode, input } = e.data;
  try {
    if (mode === 'partial') {
      self.postMessage({ id, ok: true, partial: PokerEngine.analyzeSync(Object.assign({}, input, { partial: true })).partial });
    } else {
      self.postMessage({ id, ok: true, result: slim(PokerEngine.analyzeSync(input)) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
