// Loads the real extension in Chromium on a fake pokerpatio.com page and replays
// recorded hook messages into it. Usage: node test/harness-extension.js <fixture.json> [screenshotIndexes]
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const path = require('path');
  const ext = path.join(__dirname, '..', 'extension');
  const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
  const msgs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ctx = await chromium.launchPersistentContext(path.join(require('os').tmpdir(), 'pwprof' + Date.now()), {
    headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 860 },
  });
  await ctx.route('https://pokerpatio.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body style="background:#2d6a45;margin:0;height:100vh"><h1 style="color:#fff;font-family:sans-serif;padding:40px">fake table</h1></body></html>' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await page.goto('https://pokerpatio.com/mp?game=test');
  await page.waitForTimeout(1500);
  const shots = process.argv[3] ? process.argv[3].split(',').map(Number) : [];
  for (let i = 0; i < msgs.length; i++) {
    await page.evaluate(m => window.postMessage(Object.assign({ source: 'patio-solver-hook' }, m), location.origin), msgs[i]);
    await page.waitForTimeout(msgs[i].ev === 'game:player_turn_started' ? +(process.env.WAIT || 3500) : 40);
    if (shots.includes(i)) await page.screenshot({ path: path.join(out, `ext_${i}.png`) });
    // PANELS=1 prints the panel after each turn (to see the advice the extension gave).
    if (process.env.PANELS && msgs[i].ev === 'game:player_turn_started') {
      console.log('--- after message ' + i + ' ---');
      console.log(await page.evaluate(() => { const h = document.getElementById('patio-solver-host'); return h ? h.shadowRoot.querySelector('.panel').innerText : 'NO PANEL'; }));
    }
  }
  // IMPORT=<export.json> loads a hand-log export through the panel's Import button afterwards.
  if (process.env.IMPORT) {
    await page.locator('#patio-solver-host input[type=file]').setInputFiles(process.env.IMPORT.split(','));
    await page.waitForFunction(() => /Imported|Import failed/.test(document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText), null, { timeout: 120000 });
  }
  // REINSTALL=1: after the replay, wipe the extension's storage as removing it does, reload, and
  // check the reads come back from the site's copy (backup.js; a save waits up to 15 s for its turn).
  if (process.env.REINSTALL) {
    await page.waitForTimeout(16000);
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.clear(res)));
    await page.reload();
    await page.waitForTimeout(2500);
    // The panel stays blank until it knows the table is private: send the recording's first message.
    await page.evaluate(m => window.postMessage(Object.assign({ source: 'patio-solver-hook' }, m), location.origin), msgs[0]);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => { const h = document.getElementById('patio-solver-host'); return h ? h.shadowRoot.querySelector('.panel').innerText : 'NO PANEL'; });
    console.log('--- after wiping the extension storage and reloading ---');
    console.log(/brought back/.test(after) ? 'RESTORED: ' + after.split('\n').find((l) => /brought back/.test(l)) : 'NOT RESTORED');
  }
  // LINK=1: the opponent comes back on a new account id under the same name. The panel asks
  // "Same player?"; the harness says yes, checks the reads are joined (also after a reload), then splits them.
  if (process.env.LINK) {
    const text = () => page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText);
    const click = (sel) => page.evaluate((q) => document.getElementById('patio-solver-host').shadowRoot.querySelector(q).click(), sel);
    const opp = msgs.find((m) => m.snap).snap.players.find((p) => p.authUserId !== msgs.find((m) => m.snap).snap.heroAuthId).authUserId;
    const again = JSON.parse(JSON.stringify(msgs).split(`"authUserId":"${opp}"`).join('"authUserId":"NEW-ID"'));
    const upTo = again.findIndex((m) => m.ev === 'game:stage_began' && m.data && m.data.stageType === 'set_blinds');
    const send = async (list) => { for (const m of list) { await page.evaluate(x => window.postMessage(Object.assign({ source: 'patio-solver-hook' }, x), location.origin), m); await page.waitForTimeout(40); } };
    await send(again.slice(0, upTo + 1));
    await page.waitForTimeout(300);
    const asked = await text();
    console.log('--- new account, same name ---');
    console.log(/Same player as the older read/.test(asked) ? 'ASKED: ' + asked.split('\n').find((l) => /older read/.test(l)) : 'NOT ASKED');
    await click('[data-a="linkYes"]');
    await page.waitForTimeout(300);
    const joined = await text();
    console.log(/Reads joined/.test(joined) && /Reads from 2 accounts/.test(joined) ? 'JOINED: ' + joined.split('\n').find((l) => /Reads joined/.test(l)) : 'NOT JOINED\n' + joined);
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForTimeout(2500);
    await send(again.slice(0, upTo + 1));
    await page.waitForTimeout(300);
    const kept = await text();
    console.log(/Reads from 2 accounts/.test(kept) && !/older read/.test(kept) ? 'KEPT AFTER RELOAD' : 'LOST AFTER RELOAD\n' + kept);
    await click('[data-a="links"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, 'ext_links.png') });
    await click('[data-a="unlink"]');
    await page.waitForTimeout(300);
    const split = await text();
    console.log(/Split:/.test(split) && !/Reads from 2 accounts/.test(split) ? 'SPLIT: ' + split.split('\n').find((l) => /Split:/.test(l)) : 'NOT SPLIT\n' + split);
  }
  // WHO=1: the opponent plays 11 more hands (so their read has 10+), then a new account under another name sits in
  // their seat. The panel asks "Who is this?" with the old read to tap; the harness taps it and checks the join.
  if (process.env.WHO) {
    const text = () => page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText);
    const click = (sel) => page.evaluate((q) => document.getElementById('patio-solver-host').shadowRoot.querySelector(q).click(), sel);
    const snap0 = msgs.find((m) => m.snap).snap;
    const oppP = snap0.players.find((p) => p.authUserId !== snap0.heroAuthId);
    const send = async (list, ms) => { for (const m of list) { await page.evaluate(x => window.postMessage(Object.assign({ source: 'patio-solver-hook' }, x), location.origin), m); await page.waitForTimeout(ms); } };
    for (let k = 0; k < 11; k++) await send(msgs, 5);
    const again = JSON.parse(JSON.stringify(msgs).split(`"authUserId":"${oppP.authUserId}"`).join('"authUserId":"WHO-ID"').split(`"name":"${oppP.name}"`).join('"name":"Newbie77"'));
    const upTo = again.findIndex((m) => m.ev === 'game:stage_began' && m.data && m.data.stageType === 'set_blinds');
    await send(again.slice(0, upTo + 1), 40);
    await page.waitForTimeout(300);
    const asked = await text();
    console.log('--- new account, another name ---');
    const line = asked.split('\n').find((l) => /Who is this/.test(l));
    console.log(line && asked.includes(oppP.name + ' (') ? 'WHO ASKED: ' + line : 'WHO NOT ASKED\n' + asked);
    await page.screenshot({ path: path.join(out, 'ext_who.png') });
    await click('[data-a="linkYes"]');
    await page.waitForTimeout(300);
    const joined = await text();
    console.log(/Reads joined/.test(joined) && !/Who is this/.test(joined) ? 'WHO JOINED: ' + joined.split('\n').find((l) => /Reads joined/.test(l)) : 'WHO NOT JOINED\n' + joined);
  }
  // EXPORT=1: "Hand log" opens the export list; "New hands" downloads the hands since the last
  // export (here every replayed hand), one per line; a session's button downloads that session.
  if (process.env.EXPORT) {
    const text = () => page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText);
    const click = (sel) => page.evaluate((q) => document.getElementById('patio-solver-host').shadowRoot.querySelector(q).click(), sel);
    const grab = async (sel) => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), click(sel)]);
      const file = path.join(out, dl.suggestedFilename());
      await dl.saveAs(file);
      const body = fs.readFileSync(file, 'utf8');
      const hands = JSON.parse(body);
      return { name: dl.suggestedFilename(), hands, lines: body.split('\n').length, bytes: body.length };
    };
    await page.waitForTimeout(1200); // the hand's save
    await click('[data-a="log"]');
    await page.waitForFunction(() => /New hands \(|No new hands/.test(document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText), null, { timeout: 10000 });
    console.log('--- hand log list ---');
    console.log((await text()).split('\n').filter((l) => /stored|New hands|Everything|Sessions|·/.test(l)).join('\n'));
    await page.screenshot({ path: path.join(out, 'ext_handlog.png') });
    const a = await grab('[data-a="logNew"]');
    const ok = a.hands.length > 0 && a.hands.every((h) => h.t && h.log) && a.lines === a.hands.length + 3 && /^patio-hand-log-\d{4}-\d\d-\d\d-\d{4}-to-/.test(a.name);
    console.log((ok ? 'EXPORTED NEW: ' : 'BAD EXPORT: ') + `${a.name}, ${a.hands.length} hands, ${a.bytes} bytes`);
    await page.waitForFunction(() => /Saved patio-hand-log/.test(document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText), null, { timeout: 10000 });
    // The newest hand ended under a minute ago, so it stays new for the next export.
    const after = await text();
    console.log(/New hands \(1\)/.test(after) ? 'NEWEST HAND STAYS NEW' : 'MARK WRONG\n' + after);
    const b = await grab('[data-a="logSession"]');
    console.log(b.hands.length === a.hands.length ? 'EXPORTED SESSION: ' + b.name : 'BAD SESSION EXPORT: ' + b.hands.length);
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const mark = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get('patioSolverLogMark', res)));
    console.log('MARK ' + JSON.stringify(mark));
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'ext_end.png') });
  const panel = await page.evaluate(() => { const h = document.getElementById('patio-solver-host'); return h ? h.shadowRoot.querySelector('.panel').innerText : 'NO PANEL'; });
  console.log(panel); console.log('ERRORS', errs);
  await ctx.close();
})();
