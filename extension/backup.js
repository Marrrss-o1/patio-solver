// A copy of the reads (and the hand log without raw events) in the game site's own storage
// (IndexedDB of pokerpatio.com), so removing and re-adding the extension doesn't start the reads
// from zero. Chrome deletes an extension's chrome.storage when it is removed, but not the site's
// storage, which the panel can reach as a content script. On a fresh install (no reads in
// chrome.storage) the panel loads this copy; every save writes it again.
(function (g) {
  'use strict';
  const KEY = 'reads';
  // Hands in the copy: the newest 150, like the page keeps, without raw events (a few KB each).
  const HISTORY = 150;

  // How much history a set of reads holds: preflop decisions summed over every player.
  function handsOf(players) {
    let n = 0;
    for (const r of Object.values(players || {})) {
      const t = (r && r.tally) || {};
      n += (t.pfFold || 0) + (t.pfCall || 0) + (t.pfRaise || 0);
    }
    return n;
  }

  // IndexedDB of the page's origin, as get(key) -> value | undefined (null if it failed) and
  // set(key, value) -> { ok, error }.
  function idbArea(name, store) {
    let dbp = null;
    const open = () => {
      if (!dbp) {
        dbp = new Promise((res) => {
          try {
            const req = g.indexedDB.open(name, 1);
            req.onupgradeneeded = () => { try { req.result.createObjectStore(store); } catch (e) { /* exists */ } };
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
            req.onblocked = () => res(null);
          } catch (e) { res(null); }
        });
      }
      return dbp;
    };
    const tx = (mode, fn) => open().then((db) => new Promise((res) => {
      if (!db) { res({ failed: true, error: 'the site storage could not be opened' }); return; }
      try {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res({ value: req.result });
        t.onerror = () => res({ failed: true, error: (t.error && t.error.message) || 'site storage error' });
        t.onabort = () => res({ failed: true, error: (t.error && t.error.message) || 'site storage write aborted' });
      } catch (e) { res({ failed: true, error: (e && e.message) || String(e) }); }
    }));
    return {
      get: (key) => tx('readonly', (s) => s.get(key)).then((r) => (r.failed ? null : r.value)),
      set: (key, value) => tx('readwrite', (s) => s.put(value, key)).then((r) => (r.failed ? { ok: false, error: r.error } : { ok: true })),
    };
  }

  // area: { get, set } as idbArea gives. opts.minGapMs: least time between two writes (a later
  // save is written when the gap is over).
  function create(area, opts) {
    const minGap = opts && opts.minGapMs != null ? opts.minGapMs : 15000;
    let stored = null; // hands in the copy now (null until load ran, -1 if it couldn't be read)
    let allowShrink = false;
    let lastWrite = -Infinity, timer = null, pending = null;
    const now = (opts && opts.now) || (() => Date.now());

    // The copy as { reads (the db without its history), history, savedAt, hands }, or null if
    // there is none or it couldn't be read.
    async function load() {
      const v = await area.get(KEY);
      if (v === null) { stored = -1; return null; }
      if (!v || !v.reads || !v.reads.players) { stored = 0; return null; }
      stored = handsOf(v.reads.players);
      return { reads: v.reads, history: Array.isArray(v.history) ? v.history : [], savedAt: v.savedAt, hands: stored };
    }

    async function write(db) {
      // A copy that couldn't be read when the page opened isn't written over; nor is one holding far more
      // history than these reads (a fresh install whose restore failed), unless the reads were reset.
      if (stored == null || stored < 0) return { ok: false, skipped: true };
      const hands = handsOf(db.players);
      if (!allowShrink && stored > 50 && hands < stored * 0.5) return { ok: false, skipped: true };
      lastWrite = now();
      const reads = {};
      for (const k of Object.keys(db)) if (k !== 'history') reads[k] = db[k];
      const history = (Array.isArray(db.history) ? db.history : []).slice(-HISTORY).map((e) => {
        if (!e || !e.raw) return e;
        const { raw, ...rest } = e;
        return rest;
      });
      const r = await area.set(KEY, { v: 1, savedAt: now(), reads, history });
      if (r && r.ok) { stored = hands; allowShrink = false; }
      return r;
    }

    // Writes now, or once minGapMs has passed since the last write (the newest db wins).
    function save(db) {
      pending = db;
      if (timer) return Promise.resolve({ ok: true, queued: true });
      const wait = lastWrite + minGap - now();
      if (wait <= 0) { pending = null; return write(db); }
      return new Promise((res) => {
        timer = setTimeout(() => { timer = null; const d = pending; pending = null; write(d).then(res); }, wait);
      });
    }

    return {
      load, save, handsOf,
      // "Reset reads": the next save may replace the copy with the empty reads.
      reset() { allowShrink = true; },
    };
  }

  const api = { create, idbArea, handsOf, KEY, HISTORY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.PatioBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
