'use strict';

const { MUL, div, pow2 } = require('./gf256');

class ParityContradictionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ParityContradictionError';
    this.details = details || {};
  }
}

// P is the bytewise XOR of all data shards.
function computeP(dataShards, shardSize) {
  const p = Buffer.alloc(shardSize);
  for (const shard of dataShards) {
    for (let j = 0; j < shardSize; j += 1) p[j] ^= shard[j];
  }
  return p;
}

// Q is the bytewise GF(2^8) sum of data shards weighted by 2^shardIndex.
function computeQ(dataShards, shardSize) {
  const q = Buffer.alloc(shardSize);
  for (let i = 0; i < dataShards.length; i += 1) {
    const row = MUL[pow2(i)];
    const shard = dataShards[i];
    for (let j = 0; j < shardSize; j += 1) q[j] ^= row[shard[j]];
  }
  return q;
}

function paritiesHold(dataShards, p, q, shardSize) {
  return computeP(dataShards, shardSize).equals(p)
    && computeQ(dataShards, shardSize).equals(q);
}

// Recover a single data shard (index k) from P and the other data shards.
function recoverDataFromP(s, dataShards, shardSize, k, pIndex) {
  const rec = Buffer.from(s[pIndex]);
  for (let i = 0; i < dataShards; i += 1) {
    if (i === k) continue;
    const shard = s[i];
    for (let j = 0; j < shardSize; j += 1) rec[j] ^= shard[j];
  }
  return rec;
}

// Recover a single data shard (index k) from Q and the other data shards.
function recoverDataFromQ(s, dataShards, shardSize, k, qIndex) {
  const rec = Buffer.from(s[qIndex]);
  for (let i = 0; i < dataShards; i += 1) {
    if (i === k) continue;
    const row = MUL[pow2(i)];
    const shard = s[i];
    for (let j = 0; j < shardSize; j += 1) rec[j] ^= row[shard[j]];
  }
  const invRow = MUL[div(1, pow2(k))];
  for (let j = 0; j < shardSize; j += 1) rec[j] = invRow[rec[j]];
  return rec;
}

// Recover two data shards (indices i1, i2) from P and Q:
//   pDiff = D_i1 ^ D_i2
//   qDiff = c1*D_i1 ^ c2*D_i2   with ck = 2^ik
// => D_i1 = (qDiff ^ c2*pDiff) / (c1 ^ c2),  D_i2 = pDiff ^ D_i1
function recoverTwoData(s, dataShards, shardSize, i1, i2, pIndex, qIndex) {
  const c1 = pow2(i1);
  const c2 = pow2(i2);
  const pDiff = Buffer.from(s[pIndex]);
  const qDiff = Buffer.from(s[qIndex]);
  for (let i = 0; i < dataShards; i += 1) {
    if (i === i1 || i === i2) continue;
    const shard = s[i];
    const row = MUL[pow2(i)];
    for (let j = 0; j < shardSize; j += 1) {
      pDiff[j] ^= shard[j];
      qDiff[j] ^= row[shard[j]];
    }
  }
  const rowC2 = MUL[c2];
  const rowInv = MUL[div(1, c1 ^ c2)];
  const d1 = Buffer.alloc(shardSize);
  const d2 = Buffer.alloc(shardSize);
  for (let j = 0; j < shardSize; j += 1) {
    d1[j] = rowInv[qDiff[j] ^ rowC2[pDiff[j]]];
    d2[j] = pDiff[j] ^ d1[j];
  }
  return [d1, d2];
}

// shards: array of length dataShards + 2 (Buffer or null); the last two
// entries are the P and Q parity shards. At most two entries may be null.
// Returns { shards, recoveredIndices } with every slot filled, and throws
// ParityContradictionError if the survivors contradict the parity relations.
function reconstructStripe(shards, dataShards, shardSize) {
  const total = dataShards + 2;
  const pIndex = dataShards;
  const qIndex = dataShards + 1;
  const s = shards.slice();
  const missing = [];
  for (let i = 0; i < total; i += 1) {
    if (s[i] === null) missing.push(i);
  }
  if (missing.length > 2) {
    throw new RangeError(`cannot reconstruct ${missing.length} missing shards`);
  }

  if (missing.length === 1) {
    const m = missing[0];
    if (m === pIndex) {
      s[m] = computeP(s.slice(0, dataShards), shardSize);
    } else if (m === qIndex) {
      s[m] = computeQ(s.slice(0, dataShards), shardSize);
    } else {
      s[m] = recoverDataFromP(s, dataShards, shardSize, m, pIndex);
    }
  } else if (missing.length === 2) {
    const missingData = missing.filter((i) => i < pIndex);
    if (missingData.length === 0) {
      // Both parity shards are gone: recompute them from the data.
      s[pIndex] = computeP(s.slice(0, dataShards), shardSize);
      s[qIndex] = computeQ(s.slice(0, dataShards), shardSize);
    } else if (missingData.length === 1) {
      const k = missingData[0];
      if (missing.includes(pIndex)) {
        s[k] = recoverDataFromQ(s, dataShards, shardSize, k, qIndex);
        s[pIndex] = computeP(s.slice(0, dataShards), shardSize);
      } else {
        s[k] = recoverDataFromP(s, dataShards, shardSize, k, pIndex);
        s[qIndex] = computeQ(s.slice(0, dataShards), shardSize);
      }
    } else {
      const [d1, d2] = recoverTwoData(s, dataShards, shardSize, missingData[0], missingData[1], pIndex, qIndex);
      s[missingData[0]] = d1;
      s[missingData[1]] = d2;
    }
  }

  // The completed stripe must satisfy both parity relations; this also
  // validates a fully present stripe (missing.length === 0).
  const data = s.slice(0, dataShards);
  if (!paritiesHold(data, s[pIndex], s[qIndex], shardSize)) {
    throw new ParityContradictionError(
      'shards contradict the P/Q parity relations',
      { missingIndices: missing },
    );
  }
  return { shards: s, recoveredIndices: missing };
}

module.exports = {
  computeP,
  computeQ,
  reconstructStripe,
  ParityContradictionError,
};
