// Runs the built userscript on an iPhone-sized fake table with a fake GameManager socket,
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
    <script>window.__L=[];window.GameManager={data:{tableType:${TABLE_TYPE}},playerData:{id:'H'},state:{players:[],settings:{blind_sizes:[{sb:5,bb:10}]}},socket:{onAny(f){__L.push(f)}}};</script></body></html>` }));
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
  // expand and screenshot the last advice state
  console.log(await page.evaluate(() => document.getElementById('patio-solver-host').shadowRoot.querySelector('.panel').innerText));
  console.log('ERRORS', errs);
  await browser.close();
})();
