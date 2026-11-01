// The hand log in chrome.storage.local, one key per hand. A hand with its raw events is about
// 22 KB, and the old layout (reads and the whole log under one key) rewrote all of it two or three
// times a hand. Now a save writes the reads and the newest few hands, storage keeps the newest
// KEEP hands with their raw events for the "Hand log" export, and the page keeps only what the
// tracker keeps in memory (150 hands, raw events for the newest 100), so memory doesn't grow.
(function (g) {
  'use strict';
  const PREFIX = 'patioSolverHand:';
  const KEEP = 1000;
  // Hands a save rewrites even if they are already stored: shown cards and fits reach the newest
  // hand after it ends, and the one before it gets its result when the next hand starts.
  const REWRITE = 3;

  // area: chrome.storage.local wrapped in promises,
  //   get(keys | null) -> items (null if reading failed), set(items) -> { ok, error },
  //   remove(keys) -> { ok, error }, keys() -> every key without the values, null if reading
  //   failed (optional: chrome.storage.local.getKeys, Chrome 130).
  // dbKey: the key the reads are under.
  function create(area, dbKey, opts) {
    const keep = (opts && opts.keep) || KEEP;
    const keyOf = new WeakMap(); // hand-log entry -> its key
    let stored = []; // keys in storage, oldest first
    let storedSet = new Set();
    const used = new Set(); // every key handed out, stored or not
    let n = 0;
    const isHand = (k) => k.slice(0, PREFIX.length) === PREFIX;
    const baseKey = (e) => PREFIX + (e && e.t != null ? e.t : 'x' + Date.now() + '-' + n++);
    const keyTime = (k) => parseInt(k.slice(PREFIX.length), 10) || 0;
    const byTime = (a, b) => keyTime(a) - keyTime(b) || (a < b ? -1 : a > b ? 1 : 0);
    const firstError = (rs) => rs.find((r) => r && !r.ok) || { ok: true };
    const allKeys = async () => {
      if (area.keys) return area.keys();
      const all = await area.get(null);
      return all ? Object.keys(all) : null;
    };
    // If the saved reads couldn't be read at start, nothing is saved over them.
    let unreadable = false;
    const UNREADABLE = "the saved reads couldn't be read when the page opened, so nothing is saved over them. Reload the page.";

    // The reads, with the newest `memKeep` hands as their history (raw events kept on the newest
    // `rawKeep`). Only those hands are read: all 1,000 (about 22 MB) took seconds. Reads saved by
    // older versions carry the whole log; those hands are moved to their own keys here.
    async function load(memKeep, rawKeep) {
      const keys = await allKeys();
      const handKeys = keys ? keys.filter(isHand).sort(byTime) : [];
      const got = keys && (await area.get([dbKey].concat(handKeys.slice(-memKeep))));
      if (!got) { unreadable = true; return { db: { players: {}, history: [] }, error: UNREADABLE, hands: 0 }; }
      const db = got[dbKey] || { players: {} };
      const fromStore = new Set(handKeys);
      const byKey = new Map();
      for (const k of handKeys.slice(-memKeep)) if (got[k]) byKey.set(k, got[k]);
      const moved = {};
      for (const e of Array.isArray(db.history) ? db.history : []) {
        let k = baseKey(e);
        if (fromStore.has(k)) continue; // moved already
        while (byKey.has(k)) k = baseKey(e) + '-' + n++;
        byKey.set(k, e); moved[k] = e;
      }
      const list = [...byKey.entries()].sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
      for (const k of handKeys) used.add(k);
      list.forEach(([k, e]) => { keyOf.set(e, k); used.add(k); });
      let error = null;
      if (Object.keys(moved).length) {
        const r = firstError([await area.set(moved)]);
        if (!r.ok) error = r.error; // they stay in the reads key; the first save that works moves them
      }
      stored = handKeys.concat(error ? [] : Object.keys(moved)).sort(byTime);
      storedSet = new Set(stored);
      const mem = list.slice(-memKeep).map((x) => x[1]);
      for (let i = 0; i < mem.length - rawKeep; i++) delete mem[i].raw;
      db.history = mem;
      return { db, error, hands: stored.length };
    }

    // Write the reads and the hands that are new or may have changed, then drop the oldest beyond
    // `keep`. A hand counts as stored only once a write with it worked, so after a failed save
    // (storage full, extension reloaded) the next one writes every hand still missing.
    function save(db) {
      if (unreadable) return Promise.resolve({ ok: false, error: UNREADABLE });
      const items = {};
      const reads = {};
      for (const k of Object.keys(db)) if (k !== 'history') reads[k] = db[k];
      items[dbKey] = reads;
      const list = db.history || [];
      const fresh = [];
      list.forEach((e, i) => {
        let k = keyOf.get(e);
        if (!k) {
          k = baseKey(e);
          while (used.has(k)) k = baseKey(e) + '-' + n++;
          keyOf.set(e, k);
          used.add(k);
        }
        if (!storedSet.has(k)) { items[k] = e; fresh.push(k); } else if (i >= list.length - REWRITE) items[k] = e;
      });
      return Promise.resolve(area.set(items)).then((r) => {
        if (!r || !r.ok) return r || { ok: false, error: 'no answer from storage' };
        for (const k of fresh) if (!storedSet.has(k)) { stored.push(k); storedSet.add(k); }
        const drop = stored.length > keep ? stored.splice(0, stored.length - keep) : [];
        for (const k of drop) storedSet.delete(k);
        return drop.length ? Promise.resolve(area.remove(drop)).then((r2) => firstError([r2])) : r;
      });
    }

    // Every stored hand, oldest first. Hands still in memory come from memory (newest fields),
    // with their stored raw events where memory has dropped them.
    async function exportAll(db) {
      const all = (await area.get(null)) || {};
      const byKey = new Map();
      for (const k of Object.keys(all)) if (isHand(k) && all[k]) byKey.set(k, all[k]);
      for (const e of db.history || []) {
        const k = keyOf.get(e) || baseKey(e);
        const s = byKey.get(k);
        byKey.set(k, !e.raw && s && s.raw ? Object.assign({}, e, { raw: s.raw }) : e);
      }
      return [...byKey.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
    }

    // Hands from an imported hand log, written under their own keys like any other. Hands already
    // stored (same start time) are left alone. Storage still keeps only the newest `keep`, so an
    // import of older hands into a full log keeps the newest of both.
    async function addHands(entries) {
      if (unreadable) return { ok: false, error: UNREADABLE, added: 0 };
      const items = {};
      const keys = [];
      for (const e of entries || []) {
        if (!e || e.t == null) continue;
        const k = baseKey(e);
        if (used.has(k) || items[k]) continue;
        items[k] = e;
        keys.push(k);
      }
      if (!keys.length) return { ok: true, added: 0 };
      const r = await area.set(items);
      if (!r || !r.ok) return Object.assign({ added: 0 }, r || { ok: false, error: 'no answer from storage' });
      for (const k of keys) { used.add(k); stored.push(k); storedSet.add(k); }
      stored.sort(byTime);
      const drop = stored.length > keep ? stored.splice(0, stored.length - keep) : [];
      for (const k of drop) storedSet.delete(k);
      const r2 = drop.length ? firstError([await area.remove(drop)]) : { ok: true };
      return Object.assign({ added: keys.length - drop.filter((k) => items[k]).length }, r2);
    }

    return { load, save, exportAll, addHands, count: () => stored.length };
  }

  const api = { create, PREFIX, KEEP, REWRITE };
  g.PatioHandLog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
