'use strict';

// Builds the publishable npm package tarball into dist/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Use a throwaway npm cache so the build works regardless of the state of
// the user's/global npm cache directory.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cache-'));
try {
  const out = execFileSync('npm', ['pack', '--pack-destination', dist], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
  });
  process.stdout.write(out);
} finally {
  fs.rmSync(cache, { recursive: true, force: true });
}
console.log(`publishable package written to ${dist}`);
