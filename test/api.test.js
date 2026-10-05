'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { computeP, computeQ } = require('../src/raid6');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeStripe(dataShards, shardSize) {
  const data = Array.from({ length: dataShards }, () => crypto.randomBytes(shardSize));
  const full = [...data, computeP(data, shardSize), computeQ(data, shardSize)];
  return {
    full,
    b64: full.map((b) => b.toString('base64')),
    digests: full.map((b) => sha256Hex(b)),
  };
}

let server;
let base;

test.before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function post(payload) {
  const res = await fetch(`${base}/api/stripes/reconstruct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health responds ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('reconstructs a stripe with two missing data shards', async () => {
  const dataShards = 6;
  const shardSize = 257;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[1] = null;
  shards[4] = null;
  const { status, body } = await post({ dataShards, shardSize, shards, digests });
  assert.equal(status, 200);
  assert.deepEqual(body.recoveredIndices, [1, 4]);
  assert.deepEqual(body.shards, b64);
  assert.deepEqual(body.digests, digests);
  assert.equal(body.dataShards, dataShards);
  assert.equal(body.shardSize, shardSize);
});

test('reconstructs data shard + P, and data shard + Q', async () => {
  const dataShards = 4;
  const shardSize = 128;
  const { b64, digests } = makeStripe(dataShards, shardSize);

  const shardsA = b64.slice();
  shardsA[2] = null;
  shardsA[dataShards] = null; // P
  let res = await post({ dataShards, shardSize, shards: shardsA, digests });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.recoveredIndices, [2, dataShards]);
  assert.deepEqual(res.body.shards, b64);

  const shardsB = b64.slice();
  shardsB[0] = null;
  shardsB[dataShards + 1] = null; // Q
  res = await post({ dataShards, shardSize, shards: shardsB, digests });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.recoveredIndices, [0, dataShards + 1]);
  assert.deepEqual(res.body.shards, b64);
});

test('reconstructs missing P and Q together', async () => {
  const dataShards = 3;
  const shardSize = 64;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[dataShards] = null;
  shards[dataShards + 1] = null;
  const { status, body } = await post({ dataShards, shardSize, shards, digests });
  assert.equal(status, 200);
  assert.deepEqual(body.recoveredIndices, [dataShards, dataShards + 1]);
  assert.deepEqual(body.shards, b64);
});

test('verifies a fully present stripe and reports no recoveries', async () => {
  const dataShards = 2;
  const shardSize = 1;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const { status, body } = await post({ dataShards, shardSize, shards: b64, digests });
  assert.equal(status, 200);
  assert.deepEqual(body.recoveredIndices, []);
  assert.deepEqual(body.shards, b64);
});

test('returns 422 when more than two shards are missing', async () => {
  const dataShards = 4;
  const shardSize = 32;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[0] = null;
  shards[2] = null;
  shards[5] = null;
  const { status, body } = await post({ dataShards, shardSize, shards, digests });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'ERASURE_LIMIT_EXCEEDED');
  assert.deepEqual(body.error.details.missingIndices, [0, 2, 5]);
  assert.equal(body.shards, undefined, 'failure must not emit a stripe');
});

test('returns 409 when a surviving shard digest mismatches, and does not treat it as missing', async () => {
  const dataShards = 4;
  const shardSize = 32;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[3] = null; // one genuine erasure
  const badDigests = digests.slice();
  badDigests[1] = '0'.repeat(64); // survivor #1 now contradicts its digest
  const { status, body } = await post({ dataShards, shardSize, shards, digests: badDigests });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'SHARD_DIGEST_MISMATCH');
  assert.deepEqual(body.error.details.mismatches.map((m) => m.shardIndex), [1]);
  assert.equal(body.shards, undefined);
});

test('returns 409 when a survivor was silently modified but digest metadata matches it', async () => {
  const dataShards = 4;
  const shardSize = 32;
  const { full, b64, digests } = makeStripe(dataShards, shardSize);
  const corrupted = Buffer.from(full[2]);
  corrupted[7] ^= 0x40;
  const shards = b64.slice();
  shards[2] = corrupted.toString('base64');
  const metaDigests = digests.slice();
  metaDigests[2] = sha256Hex(corrupted); // metadata updated to match corruption
  const { status, body } = await post({ dataShards, shardSize, shards, digests: metaDigests });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'PARITY_CONTRADICTION');
  assert.equal(body.shards, undefined);
});

test('returns 409 when reconstructed shards contradict their expected digests', async () => {
  const dataShards = 4;
  const shardSize = 32;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[1] = null;
  shards[2] = null;
  const wrongDigests = digests.slice();
  wrongDigests[2] = 'f'.repeat(64); // expected digest for a shard we must rebuild
  const { status, body } = await post({ dataShards, shardSize, shards, digests: wrongDigests });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'RECONSTRUCTION_DIGEST_MISMATCH');
  assert.deepEqual(body.error.details.mismatches.map((m) => m.shardIndex), [2]);
  assert.equal(body.shards, undefined);
});

test('returns 409 when a surviving shard has the wrong decoded size', async () => {
  const dataShards = 2;
  const shardSize = 16;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[0] = Buffer.alloc(8, 1).toString('base64'); // 8 bytes instead of 16
  const { status, body } = await post({ dataShards, shardSize, shards, digests });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'SHARD_DIGEST_MISMATCH');
  assert.equal(body.error.details.mismatches[0].shardIndex, 0);
  assert.equal(body.error.details.mismatches[0].actualSize, 8);
});

test('returns 400 for malformed requests', async () => {
  const dataShards = 4;
  const shardSize = 16;
  const { b64, digests } = makeStripe(dataShards, shardSize);

  const cases = [
    [{ dataShards: 1, shardSize, shards: b64, digests }, 'INVALID_DATA_SHARDS'],
    [{ dataShards: 17, shardSize, shards: b64, digests }, 'INVALID_DATA_SHARDS'],
    [{ dataShards, shardSize: 0, shards: b64, digests }, 'INVALID_SHARD_SIZE'],
    [{ dataShards, shardSize: 4097, shards: b64, digests }, 'INVALID_SHARD_SIZE'],
    [{ dataShards, shardSize, shards: b64.slice(0, -1), digests }, 'INVALID_SHARDS'],
    [{ dataShards, shardSize, shards: b64, digests: digests.slice(0, -1) }, 'INVALID_DIGESTS'],
    [{ dataShards, shardSize, shards: ['not base64!!', ...b64.slice(1)], digests }, 'INVALID_BASE64'],
    [{ dataShards, shardSize, shards: b64, digests: ['zzzz', ...digests.slice(1)] }, 'INVALID_DIGEST'],
    [{ shardSize, shards: b64, digests }, 'INVALID_DATA_SHARDS'],
  ];
  for (const [payload, code] of cases) {
    const { status, body } = await post(payload);
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, code);
    assert.equal(body.shards, undefined);
  }
});

test('returns 400 for invalid JSON and 404 for unknown routes', async () => {
  const res = await fetch(`${base}/api/stripes/reconstruct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');

  const res404 = await fetch(`${base}/nope`);
  assert.equal(res404.status, 404);
});

test('accepts digests via expectedDigests alias and sha256: prefix', async () => {
  const dataShards = 3;
  const shardSize = 32;
  const { b64, digests } = makeStripe(dataShards, shardSize);
  const shards = b64.slice();
  shards[0] = null;
  const expectedDigests = digests.map((d) => `SHA256:${d.toUpperCase()}`);
  const { status, body } = await post({ dataShards, shardSize, shards, expectedDigests });
  assert.equal(status, 200);
  assert.deepEqual(body.shards, b64);
  assert.deepEqual(body.recoveredIndices, [0]);
});
