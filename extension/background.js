// Runs the solver off the page's main thread so the table never stutters.
// On a computer it hands the work to an offscreen page with a pool of Web Workers (one per
// spare CPU core), so each decision gets many times the phone's thinking budget.
importScripts('engine.js', 'slim.js');

let offscreenReady = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (!offscreenReady) {
    offscreenReady = (async () => {
      try {
        const has = chrome.runtime.getContexts ? (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0 : false;
        if (!has) {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Run the poker solver on several CPU cores.',
          });
        }
        return true;
      } catch (e) {
        return /single offscreen/i.test(String(e && e.message));
      }
    })();
  }
  const ok = await offscreenReady;
  if (!ok) offscreenReady = null;
  return ok;
}

function runHere(input) {
  const t0 = Date.now();
  const r = PokerEngine.analyzeSync(input);
  return { ok: true, result: slim(r), ms: Date.now() - t0, workers: 1 };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 'analyze' || msg.target === 'offscreen') return false;
  (async () => {
    try {
      if (await ensureOffscreen()) {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'analyze', input: msg.input });
        if (r && r.ok) { reply(r); return; }
      }
      reply(runHere(msg.input));
    } catch (e) {
      try { reply(runHere(msg.input)); } catch (e2) { reply({ ok: false, error: String((e2 && e2.message) || e2) }); }
    }
  })();
  return true;
});
