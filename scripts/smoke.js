'use strict';

// Smoke test for a running stripe-reconstructor instance.
// Usage: APP_BASE_URL=http://host:port node scripts/smoke.js

const crypto = require('crypto');
const { computeP, computeQ } = require('../src/raid6');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function run(base) {
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) {
      console.log(`ok   ${name}`);
    } else {
      failures.push(name);
      console.error(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
    }
  };
  const post = async (payload) => {
    const res = await fetch(`${base}/api/stripes/reconstruct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };

  const health = await fetch(`${base}/health`).catch(() => null);
  check('GET /health', health !== null && health.status === 200);

  // Build a random stripe in-process with the same P/Q scheme.
  const dataShards = 6;
  const shardSize = 512;
  const data = Array.from({ length: dataShards }, () => crypto.randomBytes(shardSize));
  const full = [...data, computeP(data, shardSize), computeQ(data, shardSize)];
  const b64 = full.map((b) => b.toString('base64'));
  const digests = full.map((b) => sha256Hex(b));

  // 1. Two erasures (data shard + Q) are reconstructed byte-identically.
  const shards1 = b64.slice();
  shards1[2] = null;
  shards1[dataShards + 1] = null;
  let r = await post({ dataShards, shardSize, shards: shards1, digests });
  check(
    'reconstruct data shard + Q (200, byte-identical)',
    r.status === 200
      && r.body.recoveredIndices.length === 2
      && r.body.shards[2] === b64[2]
      && r.body.shards[dataShards + 1] === b64[dataShards + 1]
      && r.body.digests[2] === digests[2],
    `status=${r.status}`,
  );

  // 2. Two missing data shards are reconstructed via P and Q.
  const shards2 = b64.slice();
  shards2[0] = null;
  shards2[5] = null;
  r = await post({ dataShards, shardSize, shards: shards2, digests });
  check(
    'reconstruct two data shards (200, byte-identical)',
    r.status === 200 && r.body.shards[0] === b64[0] && r.body.shards[5] === b64[5],
    `status=${r.status}`,
  );

  // 3. Three erasures exceed recovery capability.
  const shards3 = b64.slice();
  shards3[0] = null;
  shards3[1] = null;
  shards3[2] = null;
  r = await post({ dataShards, shardSize, shards: shards3, digests });
  check(
    'three erasures -> 422 ERASURE_LIMIT_EXCEEDED',
    r.status === 422 && r.body.error && r.body.error.code === 'ERASURE_LIMIT_EXCEEDED' && r.body.shards === undefined,
    `status=${r.status}`,
  );

  // 4. A survivor whose digest mismatches is a 409, never an extra erasure.
  const badDigests = digests.slice();
  badDigests[1] = '0'.repeat(64);
  r = await post({ dataShards, shardSize, shards: b64, digests: badDigests });
  check(
    'survivor digest mismatch -> 409 SHARD_DIGEST_MISMATCH',
    r.status === 409 && r.body.error && r.body.error.code === 'SHARD_DIGEST_MISMATCH' && r.body.shards === undefined,
    `status=${r.status}`,
  );

  // 5. Fully present stripe verifies cleanly.
  r = await post({ dataShards, shardSize, shards: b64, digests });
  check(
    'fully present stripe -> 200 with no recoveries',
    r.status === 200 && r.body.recoveredIndices.length === 0 && JSON.stringify(r.body.shards) === JSON.stringify(b64),
    `status=${r.status}`,
  );

  return failures.length === 0;
}

if (require.main === module) {
  const base = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
  run(base)
    .then((ok) => {
      console.log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('SMOKE FAILED', err);
      process.exit(1);
    });
}

module.exports = { run };
