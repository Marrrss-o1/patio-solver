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
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'ext_end.png') });
  const panel = await page.evaluate(() => { const h = document.getElementById('patio-solver-host'); return h ? h.shadowRoot.querySelector('.panel').innerText : 'NO PANEL'; });
  console.log(panel); console.log('ERRORS', errs);
  await ctx.close();
})();
