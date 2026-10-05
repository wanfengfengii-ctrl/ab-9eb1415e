'use strict';

const crypto = require('crypto');
const { ApiError } = require('./errors');
const { reconstructStripe, ParityContradictionError } = require('./raid6');

const MIN_DATA_SHARDS = 2;
const MAX_DATA_SHARDS = 16;
const MIN_SHARD_SIZE = 1;
const MAX_SHARD_SIZE = 4096;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeDigest(value, index) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_DIGEST', `digests[${index}] must be a SHA-256 hex string`, { shardIndex: index });
  }
  let v = value.trim().toLowerCase();
  if (v.startsWith('sha256:')) v = v.slice('sha256:'.length);
  if (!HEX64_RE.test(v)) {
    throw new ApiError(400, 'INVALID_DIGEST', `digests[${index}] is not a 64-character hex SHA-256 digest`, { shardIndex: index });
  }
  return v;
}

// Validates the request, verifies surviving shards against their expected
// digests, reconstructs up to two missing shards, and returns the completed
// stripe. Throws ApiError on any failure; never returns a partial stripe.
function reconstructStripeService(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'request body must be a JSON object');
  }
  const { dataShards, shardSize, shards } = body;
  const digestsInput = body.digests !== undefined ? body.digests : body.expectedDigests;

  if (!Number.isInteger(dataShards) || dataShards < MIN_DATA_SHARDS || dataShards > MAX_DATA_SHARDS) {
    throw new ApiError(400, 'INVALID_DATA_SHARDS', `dataShards must be an integer between ${MIN_DATA_SHARDS} and ${MAX_DATA_SHARDS}`, { field: 'dataShards' });
  }
  if (!Number.isInteger(shardSize) || shardSize < MIN_SHARD_SIZE || shardSize > MAX_SHARD_SIZE) {
    throw new ApiError(400, 'INVALID_SHARD_SIZE', `shardSize must be an integer between ${MIN_SHARD_SIZE} and ${MAX_SHARD_SIZE}`, { field: 'shardSize' });
  }

  const total = dataShards + 2;
  if (!Array.isArray(shards) || shards.length !== total) {
    throw new ApiError(400, 'INVALID_SHARDS', `shards must be an array of length ${total} (dataShards data shards plus P and Q parity shards), each entry a Base64 string or null`, { field: 'shards', expectedLength: total });
  }
  if (!Array.isArray(digestsInput) || digestsInput.length !== total) {
    throw new ApiError(400, 'INVALID_DIGESTS', `digests must be an array of ${total} SHA-256 hex digests, one per shard`, { field: 'digests', expectedLength: total });
  }
  const digests = digestsInput.map((d, i) => normalizeDigest(d, i));

  // Decode the surviving shards.
  const decoded = new Array(total).fill(null);
  const missingIndices = [];
  for (let i = 0; i < total; i += 1) {
    const value = shards[i];
    if (value === null) {
      missingIndices.push(i);
      continue;
    }
    if (typeof value !== 'string' || !BASE64_RE.test(value)) {
      throw new ApiError(400, 'INVALID_BASE64', `shards[${i}] is not valid padded Base64`, { shardIndex: i });
    }
    decoded[i] = Buffer.from(value, 'base64');
  }

  // Recovery capability: P and Q together can rebuild at most two erasures.
  if (missingIndices.length > 2) {
    throw new ApiError(422, 'ERASURE_LIMIT_EXCEEDED', `${missingIndices.length} shards are missing; at most 2 can be reconstructed`, { missingIndices });
  }

  // A surviving shard whose digest does not match is a contradiction, never
  // an extra erasure: refuse instead of silently treating it as missing.
  const digestMismatches = [];
  for (let i = 0; i < total; i += 1) {
    if (decoded[i] === null) continue;
    const actualDigest = sha256Hex(decoded[i]);
    if (decoded[i].length !== shardSize || actualDigest !== digests[i]) {
      digestMismatches.push({
        shardIndex: i,
        expectedDigest: digests[i],
        actualDigest,
        expectedSize: shardSize,
        actualSize: decoded[i].length,
      });
    }
  }
  if (digestMismatches.length > 0) {
    throw new ApiError(409, 'SHARD_DIGEST_MISMATCH', 'one or more surviving shards do not match their expected SHA-256 digests', { mismatches: digestMismatches });
  }

  let result;
  try {
    result = reconstructStripe(decoded, dataShards, shardSize);
  } catch (err) {
    if (err instanceof ParityContradictionError) {
      throw new ApiError(409, 'PARITY_CONTRADICTION', err.message, { missingIndices });
    }
    throw err;
  }

  // Reconstructed shards must also match their expected digests; otherwise
  // the survivors are mutually consistent but contradict the stripe metadata.
  const recoveryMismatches = [];
  for (const i of result.recoveredIndices) {
    const actualDigest = sha256Hex(result.shards[i]);
    if (actualDigest !== digests[i]) {
      recoveryMismatches.push({ shardIndex: i, expectedDigest: digests[i], actualDigest });
    }
  }
  if (recoveryMismatches.length > 0) {
    throw new ApiError(409, 'RECONSTRUCTION_DIGEST_MISMATCH', 'reconstructed shards contradict their expected SHA-256 digests; the surviving data is inconsistent with the stripe metadata', { mismatches: recoveryMismatches });
  }

  return {
    dataShards,
    shardSize,
    shards: result.shards.map((b) => b.toString('base64')),
    recoveredIndices: result.recoveredIndices,
    digests: result.shards.map((b) => sha256Hex(b)),
  };
}

module.exports = {
  reconstructStripeService,
  sha256Hex,
  MIN_DATA_SHARDS,
  MAX_DATA_SHARDS,
  MIN_SHARD_SIZE,
  MAX_SHARD_SIZE,
};
