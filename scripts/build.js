#!/usr/bin/env node
// Builds both deliverables from src/:
//   extension/engine.js, extension/tracker.js, extension/blueprint.js  (copies, so "Load unpacked" works on extension/)
//   dist/patio-solver.user.js                   (single-file userscript for iPhone Safari / Tampermonkey)
//   dist/patio-solver-extension.zip             (if the `zip` command is available)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

const pkg = JSON.parse(read('package.json'));
const engine = read('src/engine.js');
const tracker = read('src/tracker.js');
const core = read('src/userscript-core.js');

// 1. Extension copies
write('extension/engine.js', engine);
write('extension/tracker.js', tracker);
// Blueprint lookup (computer only).
// Trained strategies, extension/blueprint-<n>max.bin.gz, are published there by blueprint/publish.sh.
write('extension/blueprint.js', read('src/blueprint.js'));
const manifest = JSON.parse(read('extension/manifest.json'));
manifest.version = pkg.version;
write('extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

// 2. Userscript
const header = `// ==UserScript==
// @name         Patio Solver
// @description  Solver advice for your Poker Patio private lobbies. Reads the table automatically.
// @version      ${pkg.version}
// @match        https://pokerpatio.com/mp*
// @match        https://www.pokerpatio.com/mp*
// @run-at       document-end
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==
`;
const userscript = header +
  '\n(function () {\n"use strict";\n// ---- Solver engine (also loaded into a background worker via ENGINE.toString()) ----\nfunction ENGINE() {\n' +
  engine + '\n}\nENGINE();\n\n' + tracker + '\n\n' + core + '\n})();\n';
write('dist/patio-solver.user.js', userscript);

// 3. Zip (optional)
try {
  const zipPath = path.join(root, 'dist/patio-solver-extension.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  // The trained blueprints (35 MB) stay out of the zip: it is rebuilt and committed with every change, and
  // they only feed the panel's "Blueprint (self-play)" line. Load unpacked from extension/ to get them.
  const files = ['manifest.json', 'hook.js', 'tracker.js', 'overlay.js', 'background.js', 'engine.js', 'slim.js', 'offscreen.html', 'offscreen.js', 'solver-worker.js', 'blueprint.js',
    'icon128.png'].filter((f) => fs.existsSync(path.join(root, 'extension', f)));
  execSync(`zip -q -r "${zipPath}" ${files.join(' ')}`, { cwd: path.join(root, 'extension'), stdio: 'ignore' });
} catch (e) {
  console.warn('zip not available; skipped dist/patio-solver-extension.zip');
}

console.log(`Built v${pkg.version}: extension/, dist/patio-solver.user.js (${userscript.length} bytes)`);
