'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mul, div, inv, pow2, EXP } = require('../src/gf256');

test('2 generates the multiplicative group (order 255)', () => {
  const seen = new Set();
  for (let i = 0; i < 255; i += 1) seen.add(EXP[i]);
  assert.equal(seen.size, 255);
  assert.equal(EXP[255], EXP[0]);
  assert.ok(!seen.has(0));
});

test('multiply/divide/inverse round-trip', () => {
  for (let a = 0; a < 256; a += 1) {
    assert.equal(mul(a, 0), 0);
    assert.equal(mul(0, a), 0);
    assert.equal(mul(a, 1), a);
    if (a !== 0) {
      assert.equal(mul(a, inv(a)), 1);
      assert.equal(div(a, a), 1);
      for (const b of [1, 2, 7, 53, 128, 255]) {
        assert.equal(div(mul(a, b), b), a);
      }
    }
  }
});

test('field identities on samples', () => {
  const sample = [1, 2, 3, 5, 17, 63, 128, 200, 254, 255];
  for (const a of sample) {
    for (const b of sample) {
      assert.equal(mul(a, b), mul(b, a), 'commutativity');
      for (const c of [2, 87, 255]) {
        assert.equal(mul(mul(a, b), c), mul(a, mul(b, c)), 'associativity');
        assert.equal(mul(a, b ^ c), mul(a, b) ^ mul(a, c), 'distributivity over XOR');
      }
    }
  }
});

test('pow2 coefficients are distinct and non-zero for shard indices 0..15', () => {
  const coeffs = new Set();
  for (let i = 0; i < 16; i += 1) {
    const c = pow2(i);
    assert.notEqual(c, 0);
    coeffs.add(c);
  }
  assert.equal(coeffs.size, 16);
  assert.equal(pow2(0), 1);
  assert.equal(pow2(1), 2);
});

test('division by zero and inverse of zero throw', () => {
  assert.throws(() => div(1, 0), RangeError);
  assert.throws(() => inv(0), RangeError);
});
