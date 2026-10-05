'use strict';

// One-shot verification: unit tests, publishable package build, and a smoke
// run against the live app service. Exits non-zero if any step fails.

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function step(name, command, args) {
  console.log(`\n=== ${name} ===`);
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  const ok = res.status === 0;
  console.log(`--- ${name}: ${ok ? 'OK' : 'FAILED'}`);
  return ok;
}

(async () => {
  let ok = true;
  ok = step('unit tests', 'npm', ['test']) && ok;
  ok = step('publishable package build', 'npm', ['run', 'build']) && ok;

  const base = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
  console.log(`\n=== smoke against ${base} ===`);
  try {
    const { run } = require('./smoke');
    ok = (await run(base)) && ok;
  } catch (err) {
    console.error('smoke run errored:', err);
    ok = false;
  }

  console.log(ok ? '\nVERIFY PASSED' : '\nVERIFY FAILED');
  process.exit(ok ? 0 : 1);
})();
