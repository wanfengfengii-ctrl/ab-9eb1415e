'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  computeP,
  computeQ,
  reconstructStripe,
  ParityContradictionError,
} = require('../src/raid6');

function makeStripe(dataShards, shardSize) {
  const data = Array.from({ length: dataShards }, () => crypto.randomBytes(shardSize));
  return [...data, computeP(data, shardSize), computeQ(data, shardSize)];
}

function combinations(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < n; i += 1) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

test('P is the bytewise XOR of the data shards', () => {
  const a = Buffer.from([0x00, 0xff, 0x5a]);
  const b = Buffer.from([0xff, 0x0f, 0xa5]);
  const c = Buffer.from([0x12, 0x34, 0x00]);
  assert.deepEqual(computeP([a, b, c], 3), Buffer.from([0xed, 0xc4, 0xff]));
});

test('Q matches a hand-computed GF(2^8) weighted sum', () => {
  // coefficients 2^0=1, 2^1=2, 2^2=4
  const a = Buffer.from([0x01, 0x80]);
  const b = Buffer.from([0x53, 0xca]);
  const c = Buffer.from([0x02, 0x01]);
  // byte 0: 1*0x01 ^ 2*0x53 ^ 4*0x02 = 0x01 ^ 0xa6 ^ 0x08 = 0xaf
  // byte 1: 1*0x80 ^ 2*0xca ^ 4*0x01 = 0x80 ^ 0x89 ^ 0x04 = 0x0d
  assert.deepEqual(computeQ([a, b, c], 2), Buffer.from([0xaf, 0x0d]));
});

test('reconstructs any single missing shard', () => {
  for (const dataShards of [2, 5, 16]) {
    const shardSize = 33;
    const full = makeStripe(dataShards, shardSize);
    for (let m = 0; m < dataShards + 2; m += 1) {
      const shards = full.map((b, i) => (i === m ? null : b));
      const { shards: out, recoveredIndices } = reconstructStripe(shards, dataShards, shardSize);
      assert.deepEqual(recoveredIndices, [m]);
      for (let i = 0; i < full.length; i += 1) {
        assert.ok(out[i].equals(full[i]), `dataShards=${dataShards} missing=${m} shard=${i}`);
      }
    }
  }
});

test('reconstructs every pair of missing shards', () => {
  for (const dataShards of [2, 3, 4, 8, 16]) {
    const shardSize = 64;
    const full = makeStripe(dataShards, shardSize);
    const total = dataShards + 2;
    for (const [a, b] of combinations(total, 2)) {
      const shards = full.map((buf, i) => (i === a || i === b ? null : buf));
      const { shards: out, recoveredIndices } = reconstructStripe(shards, dataShards, shardSize);
      assert.deepEqual(recoveredIndices, [a, b]);
      for (let i = 0; i < total; i += 1) {
        assert.ok(out[i].equals(full[i]), `dataShards=${dataShards} missing=[${a},${b}] shard=${i}`);
      }
    }
  }
});

test('reconstructs with shardSize 1 and 4096', () => {
  for (const shardSize of [1, 4096]) {
    const dataShards = 4;
    const full = makeStripe(dataShards, shardSize);
    const shards = full.map((b, i) => (i === 1 || i === 3 ? null : b));
    const { shards: out } = reconstructStripe(shards, dataShards, shardSize);
    for (let i = 0; i < full.length; i += 1) assert.ok(out[i].equals(full[i]));
  }
});

test('accepts a fully present consistent stripe', () => {
  const dataShards = 6;
  const shardSize = 100;
  const full = makeStripe(dataShards, shardSize);
  const { shards: out, recoveredIndices } = reconstructStripe(full.slice(), dataShards, shardSize);
  assert.deepEqual(recoveredIndices, []);
  for (let i = 0; i < full.length; i += 1) assert.ok(out[i].equals(full[i]));
});

test('detects parity contradiction in a fully present stripe', () => {
  const dataShards = 4;
  const shardSize = 32;
  const full = makeStripe(dataShards, shardSize);
  full[1][0] ^= 0x01; // silently corrupted data shard
  assert.throws(() => reconstructStripe(full, dataShards, shardSize), ParityContradictionError);
});

test('detects contradiction when one shard is missing and survivors are inconsistent', () => {
  const dataShards = 4;
  const shardSize = 32;
  const full = makeStripe(dataShards, shardSize);
  full[2][5] ^= 0x80; // corrupt a survivor
  full[1] = null; // one genuine erasure
  assert.throws(() => reconstructStripe(full, dataShards, shardSize), ParityContradictionError);
});

test('throws when more than two shards are missing', () => {
  const dataShards = 4;
  const shardSize = 16;
  const full = makeStripe(dataShards, shardSize);
  full[0] = null;
  full[2] = null;
  full[4] = null;
  assert.throws(() => reconstructStripe(full, dataShards, shardSize), RangeError);
});
