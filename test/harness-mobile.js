// Runs the built userscript on an iPhone-sized fake table with a fake GameManager socket
// (GameManager.roomConnectionManager.socket as the game has it since 3 Nov 2026; OLD_SOCKET=1: GameManager.socket),
// replaying recorded events. Usage: node test/harness-mobile.js <fixture.json> [screenshotIndexes]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
// TABLE_TYPE=public (or empty for a table whose type isn't known yet) checks that the overlay stays off.
const TABLE_TYPE = process.env.TABLE_TYPE == null ? "'private'" : process.env.TABLE_TYPE ? JSON.stringify(process.env.TABLE_TYPE) : 'undefined';
(async () => {
  const msgs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const shots = (process.argv[3] || '').split(',').filter(Boolean).map(Number);
  const us = fs.readFileSync(path.join(__dirname, '..', 'dist', 'patio-solver.user.js'), 'utf8');
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', 'table-mobile.jpg')).toString('base64');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices[process.env.LANDSCAPE ? 'iPhone 13 landscape' : 'iPhone 13'] }); // LANDSCAPE=1: the phone turned sideways
  await ctx.route('https://pokerpatio.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;height:100vh;background:#111 url(data:image/jpeg;base64,${img}) center top/cover no-repeat">
    <script>window.__L=[];window.GameManager={data:{tableType:${TABLE_TYPE}},playerData:{id:'H'},state:{players:[],settings:{blind_sizes:[{sb:5,bb:10}]}},${process.env.OLD_SOCKET ? "socket:{onAny(f){__L.push(f)}}" : "roomConnectionManager:{socket:{onAny(f){__L.push(f)}}}"}};</script></body></html>` }));
  // CORES=2: the core count iOS Safari reports (the userscript then runs 2 solver workers).
  if (process.env.CORES) await ctx.addInitScript((n) => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => n }), +process.env.CORES);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('https://pokerpatio.com/mp?game=test');
  await page.addScriptTag({ content: us });
  await page.waitForTimeout(800);
  if (shots.includes(-1)) await page.screenshot({ path: path.join(out, 'mobile_start.png') });
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.ev === 'hook:attached') continue;
    await page.evaluate(m => { GameManager.state.players = m.snap.players; __L.forEach(f => f(m.ev, m.data)); }, m);
    await page.waitForTimeout(m.ev === 'game:player_turn_started' ? 300 : 30);
    // The full solve runs on Web Workers for up to about 10 s (v1.8.51): wait for it on hero's turns.
    if (m.ev === 'game:player_turn_started') {
      const t0 = Date.now();
      while (Date.now() - t0 < 25000 && await page.evaluate(() => /Thinking/.test(document.getElementById('patio-solver-host').shadowRoot.querySelector('.bar').innerText))) await page.waitForTimeout(100);
      const ms = Date.now() - t0 + 300;
      if (ms > 20000) errs.push('a decision took over 20 s (message ' + i + ')');
    }
    // PANELS=1 opens the panel and prints it after each turn (to see the advice).
    if (process.env.PANELS && m.ev === 'game:player_turn_started') {
      console.log('--- after message ' + i + ' ---');
      console.log(await page.evaluate(() => { const r = document.getElementById('patio-solver-host').shadowRoot; if (r.querySelector('.bd').style.display === 'none') r.querySelector('[data-a="toggle"]').click(); return r.querySelector('.panel').innerText; }));
    }
    if (shots.includes(i)) { await page.screenshot({ path: path.join(out, `mobile_${i}.png`) }); const bb = await page.evaluate(() => { const r = document.getElementById("patio-solver-host").shadowRoot.querySelector(".bar").getBoundingClientRect(); return [r.left + 60, r.top + r.height/2]; }); await page.touchscreen.tap(bb[0], bb[1]); await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `mobile_${i}_open.png`) }); }
  }
  // LINK=1: the opponent comes back on a new account id under the same name; the panel asks
  // "Same player?", the harness says yes, then splits them again from "Link reads".
  if (process.env.LINK) {
    const text = () => page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText);
    const click = (q) => page.evaluate((s) => document.getElementById('patio-solver-host').shadowRoot.querySelector(s).click(), q);
    const snap0 = msgs.find((m) => m.snap).snap;
    const opp = snap0.players.find((p) => p.authUserId !== snap0.heroAuthId).authUserId;
    const again = JSON.parse(JSON.stringify(msgs).split(`"authUserId":"${opp}"`).join('"authUserId":"NEW-ID"'));
    const upTo = again.findIndex((m) => m.ev === 'game:stage_began' && m.data && m.data.stageType === 'set_blinds');
    for (const m of again.slice(0, upTo + 1)) {
      if (m.ev === 'hook:attached') continue;
      await page.evaluate(m => { GameManager.state.players = m.snap.players; __L.forEach(f => f(m.ev, m.data)); }, m);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
    const bar = await text();
    console.log('--- new account, same name ---');
    console.log(/same player\?/.test(bar) ? 'BADGE' : 'NO BADGE');
    const open = await page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.bd').style.display !== 'none');
    if (!open) await click('[data-a="toggle"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, 'mobile_link_ask.png') });
    const asked = await text();
    console.log(/older read/.test(asked) ? 'ASKED' : 'NOT ASKED\n' + asked);
    await click('[data-a="linkYes"]');
    await page.waitForTimeout(200);
    const joined = await text();
    console.log(/Reads joined/.test(joined) && /Reads from 2 accounts/.test(joined) ? 'JOINED: ' + joined.split('\n').find((l) => /Reads joined/.test(l)) : 'NOT JOINED\n' + joined);
    await click('[data-a="links"]');
    await page.waitForTimeout(200);
    await click('[data-a="unlink"]');
    await page.waitForTimeout(200);
    const split = await text();
    console.log(/Split:/.test(split) && !/Reads from 2 accounts/.test(split) ? 'SPLIT' : 'NOT SPLIT\n' + split);
    // The old account, on its own read and not at the table, is listed under "Recent, not at the table" (v1.8.43).
    if (!/Recent, not at the table|Joined reads add/i.test(await text())) { await click('[data-a="links"]'); await page.waitForTimeout(200); }
    const recent = await page.evaluate((o) => { const r = document.getElementById('patio-solver-host').shadowRoot; return /Recent, not at the table/i.test(r.querySelector('.panel').innerText) && !!r.querySelector(`select[data-a="linkPick"][data-id="${o}"]`); }, opp);
    console.log(recent ? 'RECENT LISTED' : 'RECENT NOT LISTED\n' + (await text()));
  }
  // WHO=1: the opponent plays 11 more hands, then a new account under another name sits in their seat; the panel
  // shows the "who is this?" badge and asks with the old read to tap; the harness taps it.
  if (process.env.WHO) {
    const text = () => page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText);
    const click = (q) => page.evaluate((s) => document.getElementById('patio-solver-host').shadowRoot.querySelector(s).click(), q);
    const snap0 = msgs.find((m) => m.snap).snap;
    const oppP = snap0.players.find((p) => p.authUserId !== snap0.heroAuthId);
    const send = async (list, ms) => { for (const m of list) { if (m.ev === 'hook:attached') continue; await page.evaluate(m => { GameManager.state.players = m.snap.players; __L.forEach(f => f(m.ev, m.data)); }, m); await page.waitForTimeout(ms); } };
    for (let k = 0; k < 11; k++) await send(msgs, 3);
    const again = JSON.parse(JSON.stringify(msgs).split(`"authUserId":"${oppP.authUserId}"`).join('"authUserId":"WHO-ID"').split(`"name":"${oppP.name}"`).join('"name":"Newbie77"'));
    const upTo = again.findIndex((m) => m.ev === 'game:stage_began' && m.data && m.data.stageType === 'set_blinds');
    await send(again.slice(0, upTo + 1), 30);
    await page.waitForTimeout(300);
    const bar = await text();
    console.log('--- new account, another name ---');
    console.log(/who is this\?/.test(bar) ? 'WHO BADGE' : 'NO WHO BADGE');
    const open = await page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.bd').style.display !== 'none');
    if (!open) await click('[data-a="toggle"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, 'mobile_who.png') });
    const asked = await text();
    console.log(/Who is this\?/.test(asked) && asked.includes(oppP.name + ' (') ? 'WHO ASKED' : 'WHO NOT ASKED\n' + asked);
    await click('[data-a="linkYes"]');
    await page.waitForTimeout(200);
    const joined = await text();
    console.log(/Reads joined/.test(joined) && !/Who is this/.test(joined) ? 'WHO JOINED' : 'WHO NOT JOINED\n' + joined);
  }
  // FILES=1 (v1.8.51): Export reads and the hand log as files, Import a reads file from "the computer" (Replace), the
  // reads and log kept in IndexedDB over a reload, and an older version's reads moved over from localStorage.
  if (process.env.FILES) {
    const sr = (fn, arg) => page.evaluate(([f, a]) => { const r = document.getElementById('patio-solver-host').shadowRoot; return new Function('r', 'a', f)(r, a); }, [fn, arg]);
    const text = () => sr("return r.querySelector('.panel').innerText");
    const click = (q) => sr("const el = r.querySelector(a); if (!el) throw new Error('no ' + a); el.click(); return true", q);
    const waitFor = async (re, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await text())) return true; await page.waitForTimeout(100); } return false; };
    const blobJson = () => sr("const l = r.querySelector('a[data-a=\"saveFile\"]'); return l ? fetch(l.href).then((x) => x.text()).then((t) => ({ name: l.getAttribute('download'), text: t })) : null");
    const check = (ok, what, extra) => { console.log((ok ? 'OK   ' : 'FAIL ') + what); if (!ok) { errs.push('files: ' + what); if (extra) console.log(extra); } };
    if (await sr("return r.querySelector('.bd').style.display === 'none'")) await click('[data-a="toggle"]');
    await click('[data-a="reads"]');
    await page.waitForTimeout(200);
    await click('[data-a="exportReads"]');
    await page.waitForTimeout(200);
    const ex = await blobJson();
    const file = ex && JSON.parse(ex.text);
    check(file && file.kind === 'patio-solver-reads' && file.from === 'phone' && !file.reads.history && Object.keys(file.reads.players).length >= 1 && /^patio-reads-phone-.*\.json$/.test(ex.name), 'Export reads makes a reads file (' + (ex && ex.name) + ')');
    const before = Object.keys(file.reads.players).length;
    // "The computer's" reads: the phone's plus one more player.
    const comp = JSON.parse(JSON.stringify(file));
    comp.from = 'computer';
    const someone = Object.keys(comp.reads.players)[0];
    comp.reads.players['COMP-1'] = Object.assign({}, comp.reads.players[someone], { name: 'FromComputer' });
    comp.reads.seen = Object.assign({}, comp.reads.seen, { 'COMP-1': { names: ['FromComputer'], first: Date.now() - 864e5, last: Date.now() + 1000 } });
    await page.locator('#ps-file').setInputFiles({ name: 'patio-reads-computer-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(comp)) });
    check(await waitFor(/Replace this phone's reads/), 'Import of a reads file asks before replacing', await text());
    await page.screenshot({ path: path.join(out, 'mobile_reads_import.png') });
    await click('[data-a="replaceReads"]');
    check(await waitFor(new RegExp('Reads replaced with the computer\'s: ' + (before + 1) + ' players')), 'Replace puts the computer\'s reads here', await text());
    check(new RegExp((before + 1) + ' players on this phone').test(await text()), 'the phone now reads ' + (before + 1) + ' players');
    // A hand-log file is not taken as reads: its hands go into the log (and the reads are rebuilt).
    await click('[data-a="log"]');
    check(await waitFor(/New hands \(\d+\)/), 'Hand log lists the new hands', await text());
    await click('[data-a="logNew"]');
    check(await waitFor(/Save to Files/), 'New hands makes a file to save');
    const lg = await blobJson();
    const hands = lg && JSON.parse(lg.text);
    check(Array.isArray(hands) && hands.length >= 1 && hands[0].raw && /^patio-hand-log-/.test(lg.name), 'the hand-log file holds the hands with raw events (' + (hands && hands.length) + ', ' + (lg && lg.name) + ')');
    const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await click('a[data-a="saveFile"]');
    const d = await dl;
    check(d && d.suggestedFilename() === lg.name, 'Save to Files downloads it');
    check(await waitFor(/Saved: \d+ hand/), 'the panel notes the save', await text());
    await page.screenshot({ path: path.join(out, 'mobile_log_saved.png') });
    // Everything stays over a reload (IndexedDB), and nothing is left in localStorage.
    await page.waitForTimeout(1800);
    await page.reload();
    await page.addScriptTag({ content: us });
    await page.waitForTimeout(1200);
    if (await sr("return r.querySelector('.bd').style.display === 'none'")) await click('[data-a="toggle"]');
    await click('[data-a="reads"]');
    check(await waitFor(new RegExp((before + 1) + ' players on this phone')), 'the replaced reads are still there after a reload', await text());
    check(await page.evaluate(() => localStorage.getItem('patioSolverDb') == null), 'no reads in localStorage');
    await click('[data-a="log"]');
    check(await waitFor(/No new hands since the last export|New hands \(1\)/), 'the export mark is kept over a reload', await text());
    // An older version's reads in localStorage move to IndexedDB on the first start.
    const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx2.route('https://pokerpatio.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errs.push(String(e)));
    await p2.goto('https://pokerpatio.com/mp?game=test');
    await p2.evaluate((db) => localStorage.setItem('patioSolverDb', JSON.stringify(db)), Object.assign({}, file.reads, { history: hands }));
    await p2.addScriptTag({ content: us });
    await p2.waitForTimeout(2500);
    const moved = await p2.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('patio-solver-phone', 1);
      q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').getAllKeys(); g.onsuccess = () => res({ keys: g.result.length, ls: localStorage.getItem('patioSolverDb') }); };
      q.onerror = () => res(null);
    }));
    check(moved && moved.ls == null && moved.keys >= 1 + hands.length, 'older reads move from localStorage to IndexedDB (' + JSON.stringify(moved && { keys: moved.keys, left: moved.ls != null }) + ')');
    await ctx2.close();
  }
  // expand and screenshot the last advice state
  console.log(await page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText));
  console.log('ERRORS', errs);
  await browser.close();
})();
