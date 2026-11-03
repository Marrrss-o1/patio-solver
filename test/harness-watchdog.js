// The socket watchdog on both builds: a fake private table whose GameManager has no socket ('nosocket'), then one
// whose socket goes quiet while the chips keep moving ('silent'). The panel has to say so, and stop saying it once
// events arrive. Rebuild first (npm run build). Usage: node test/harness-watchdog.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const players = [
  { id: 1, authUserId: 'H', name: 'Hero', stack: 300, posType: 's1', playState: 'playing', totalBetsMade: 0 },
  { id: 2, authUserId: 'V', name: 'Villain', stack: 300, posType: 's2', playState: 'playing', totalBetsMade: 0 },
];
// withSocket: 'none' | 'new' (roomConnectionManager.socket). The socket keeps its listeners in window.__L.
const page = (withSocket) => `<!doctype html><html><body style="background:#2d6a45;margin:0;height:100vh">
<script>window.__patioSolverWatch={noSocketMs:1500,silentMs:1500};window.__L=[];
window.GameManager={data:{tableType:'private'},playerData:{id:'H'},state:{players:${JSON.stringify(players)},settings:{blind_sizes:[{sb:1,bb:2}]}}${withSocket === 'new' ? ",roomConnectionManager:{socket:{onAny(f){__L.push(f)},offAny(f){__L=__L.filter(g=>g!==f)}}}" : ''}};
window.__move=()=>{const p=GameManager.state.players[1];p.stack-=2;p.totalBetsMade+=2;};
window.__event=()=>__L.forEach(f=>f('game:player_turn_started',{playerID:2}));
window.__addSocket=()=>{GameManager.roomConnectionManager={socket:{onAny(f){__L.push(f)},offAny(f){__L=__L.filter(g=>g!==f)}}};};
</script><h1 style="color:#fff;font-family:sans-serif;padding:40px">fake table</h1></body></html>`;

const results = [];
const check = (name, ok, text) => { results.push([name, ok]); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '\n' + text)); };

async function scenarios(pg, text, label, reload) {
  // No socket: the warning shows after noSocketMs, and goes away once the game's socket turns up.
  await reload('none');
  await pg.waitForTimeout(3500);
  let t = await text();
  check(`${label}: no socket -> warning`, /Can’t find the game’s connection/.test(t), t);
  check(`${label}: no socket -> not "Connected"`, !/^Connected/m.test(t), t);
  await pg.evaluate(() => window.__addSocket());
  await pg.waitForTimeout(2000);
  t = await text();
  check(`${label}: socket found -> warning gone`, !/Can’t find the game’s connection/.test(t), t);
  // Socket attached but quiet while the chips move.
  await reload('new');
  await pg.waitForTimeout(1200);
  for (let i = 0; i < 5; i++) { await pg.evaluate(() => window.__move()); await pg.waitForTimeout(700); }
  await pg.waitForTimeout(1500);
  t = await text();
  check(`${label}: chips move, no events -> warning`, /no game events arrive/.test(t), t);
  await pg.evaluate(() => window.__event());
  await pg.waitForTimeout(1500);
  t = await text();
  check(`${label}: an event arrives -> warning gone`, !/no game events arrive/.test(t), t);
  // Chips move with events: never a warning.
  await reload('new');
  await pg.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) { await pg.evaluate(() => { window.__move(); window.__event(); }); await pg.waitForTimeout(700); }
  t = await text();
  check(`${label}: chips move with events -> no warning`, !/no game events arrive|Can’t find/.test(t), t);
}

(async () => {
  // Userscript.
  {
    const us = fs.readFileSync(path.join(__dirname, '..', 'dist', 'patio-solver.user.js'), 'utf8');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    let mode = 'none';
    await ctx.route('https://pokerpatio.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: page(mode) }));
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    const reload = async (m) => { mode = m; await pg.goto('https://pokerpatio.com/mp?game=test'); await pg.addScriptTag({ content: us }); };
    const text = () => pg.evaluate(() => {
      const r = document.getElementById('patio-solver-host').shadowRoot;
      const bd = r.querySelector('.bd'); if (bd && bd.style.display === 'none') r.querySelector('[data-a="toggle"]').click();
      return r.querySelector('.panel').innerText;
    });
    await scenarios(pg, text, 'userscript', reload);
    check('userscript: no page errors', !errs.length, errs.join('\n'));
    await browser.close();
  }
  // Extension.
  {
    const ext = path.join(__dirname, '..', 'extension');
    const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pwwatch' + Date.now()), {
      headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1280, height: 860 },
    });
    let mode = 'none';
    await ctx.route('https://pokerpatio.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: page(mode) }));
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    const reload = async (m) => { mode = m; await pg.goto('https://pokerpatio.com/mp?game=test'); };
    const text = () => pg.evaluate(() => { const h = document.getElementById('patio-solver-host'); return h ? h.shadowRoot.querySelector('.panel').innerText : 'NO PANEL'; });
    await scenarios(pg, text, 'extension', reload);
    check('extension: no page errors', !errs.length, errs.join('\n'));
    await ctx.close();
  }
  const bad = results.filter((r) => !r[1]).length;
  console.log(bad ? `${bad} watchdog checks failed` : 'All watchdog checks passed');
  process.exit(bad ? 1 : 0);
})();
