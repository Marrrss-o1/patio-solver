// Hand-log exports, merged into one list. Exports from v1.8.21 on hold only the hands since the last
// export (or one session), so a full history is several files; older exports held every stored hand,
// so they overlap. loadHands reads files and folders (every .json in a folder, oldest name first),
// keeps each hand once (same time and hero cards), and sorts by time. When two files have the same
// hand, the fuller copy wins (one with its result, then the one with more raw events), else the later
// file's. The newest hand of an export can still change: its result comes when the next hand starts,
// and its raw events keep coming in until then (31 Oct - 5 Nov exports: three session-end hands had
// 70 / 81 / 30 events in one export and 65 / 90 / 23 in another).
//
//   const { loadHands } = require('./merge-logs.js'); loadHands(['logs/'])  // or a list of files
//   node test/merge-logs.js <out.json> <exports or folders...>              // writes one merged file
const fs = require('fs');
const path = require('path');

const keyOf = (h) => h.t + ':' + (h.hero || []).join('');
const fuller = (a, b) => (!!a.net - !!b.net) || ((a.raw ? a.raw.length + 1 : 0) - (b.raw ? b.raw.length + 1 : 0));

function listOf(data) {
  return Array.isArray(data) ? data : data && Array.isArray(data.history) ? data.history : null;
}

function files(paths, skip) {
  const out = [];
  for (const p of [].concat(paths || [])) {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).filter((x) => x.toLowerCase().endsWith('.json')).sort()) out.push({ file: path.join(p, f), inDir: true });
    } else out.push({ file: p, inDir: false });
  }
  return out.filter((x) => !skip || path.resolve(x.file) !== skip);
}

// opts.quiet: no warning for files in a folder that aren't hand logs. opts.skip: a resolved path
// to leave out (the merged file itself). opts.info: filled in with { files, read, dupes } counts.
function loadHands(paths, opts = {}) {
  const byKey = new Map();
  const info = opts.info || {};
  info.files = 0; info.read = 0; info.dupes = 0;
  for (const { file, inDir } of files(paths, opts.skip)) {
    let list = null;
    try { list = listOf(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { if (!inDir) throw e; }
    if (!list) {
      if (!inDir) throw new Error(file + ' is not a hand-log export');
      if (!opts.quiet) console.error('skipped ' + file + ': not a hand-log export');
      continue;
    }
    info.files++;
    for (const h of list) {
      if (!h || h.t == null) continue;
      info.read++;
      const k = keyOf(h);
      const was = byKey.get(k);
      if (was) info.dupes++;
      if (!was || fuller(h, was) >= 0) byKey.set(k, h);
    }
  }
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

// The export format: one hand per line (extension/handlog.js toFile).
const toFile = (hands) => '[\n' + hands.map((h) => JSON.stringify(h)).join(',\n') + '\n]\n';

module.exports = { loadHands, toFile, keyOf };

if (require.main === module) {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || !inputs.length) {
    console.log('usage: node test/merge-logs.js <out.json> <exports or folders...>');
    process.exit(1);
  }
  const resolved = path.resolve(out);
  const info = {};
  const hands = loadHands(inputs, { info, skip: resolved });
  fs.writeFileSync(out, toFile(hands));
  const day = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${hands.length} hands from ${info.files} files (${info.dupes} copies of the same hand dropped)` +
    (hands.length ? `, ${day(hands[0].t)} to ${day(hands[hands.length - 1].t)} UTC` : '') + ` -> ${out}`);
}
