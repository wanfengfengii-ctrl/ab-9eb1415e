'use strict';

// GF(2^8) arithmetic modulo the primitive polynomial
// x^8 + x^4 + x^3 + x^2 + 1 (0x11d), with 2 as the generator of the
// multiplicative group. Coefficient for data shard i is 2^i in this field.

const POLY = 0x11d;

const EXP = new Uint8Array(512); // EXP[i] = 2^i
const LOG = new Uint8Array(256); // LOG[x] = i such that 2^i = x

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= POLY;
  }
  for (let i = 255; i < EXP.length; i += 1) EXP[i] = EXP[i - 255];
})();

// MUL[a][b] = a * b in GF(2^8); full table keeps hot loops branch-free.
const MUL = new Array(256);
for (let a = 0; a < 256; a += 1) {
  MUL[a] = new Uint8Array(256);
  for (let b = 0; b < 256; b += 1) {
    MUL[a][b] = a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }
}

function mul(a, b) {
  return MUL[a][b];
}

function div(a, b) {
  if (b === 0) throw new RangeError('division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

function inv(a) {
  if (a === 0) throw new RangeError('0 has no multiplicative inverse in GF(2^8)');
  return EXP[255 - LOG[a]];
}

// 2^i in GF(2^8); the multiplicative order of 2 is 255.
function pow2(i) {
  return EXP[((i % 255) + 255) % 255];
}

module.exports = { POLY, EXP, LOG, MUL, mul, div, inv, pow2 };
