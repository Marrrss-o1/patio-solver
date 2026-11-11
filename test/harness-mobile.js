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
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route('https://pokerpatio.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;height:100vh;background:#111 url(data:image/jpeg;base64,${img}) center top/cover no-repeat">
    <script>window.__L=[];window.GameManager={data:{tableType:${TABLE_TYPE}},playerData:{id:'H'},state:{players:[],settings:{blind_sizes:[{sb:5,bb:10}]}},${process.env.OLD_SOCKET ? "socket:{onAny(f){__L.push(f)}}" : "roomConnectionManager:{socket:{onAny(f){__L.push(f)}}}"}};</script></body></html>` }));
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
    await page.waitForTimeout(m.ev === 'game:player_turn_started' ? 3000 : 30);
    // PANELS=1 opens the panel and prints it after each turn (to see the advice).
    if (process.env.PANELS && m.ev === 'game:player_turn_started') {
      console.log('--- after message ' + i + ' ---');
      console.log(await page.evaluate(() => { const r = document.getElementById('patio-solver-host').shadowRoot; const p = r.querySelector('.panel'); if (p && p.innerText.length < 80) { const b = r.querySelector('.bar'); if (b) b.click(); } return r.querySelector('.panel').innerText; }));
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
  // expand and screenshot the last advice state
  console.log(await page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText));
  console.log('ERRORS', errs);
  await browser.close();
})();
