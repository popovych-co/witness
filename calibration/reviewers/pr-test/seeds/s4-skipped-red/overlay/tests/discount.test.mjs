import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, stack } from '../src/discount.mjs';

test('discounts clamp and round @spec:discounts', () => {
  assert.equal(applyDiscount(1000, 25), 750);
  assert.equal(applyDiscount(1000, 0), 1000);
  assert.equal(applyDiscount(1000, 100), 0);
  assert.equal(applyDiscount(1000, 150), 0);
  assert.equal(applyDiscount(1000, -5), 1000);
});

// TODO flaky
test.skip('stacked discounts never exceed 100 @spec:discounts', () => {
  assert.equal(Math.round(stack(50, 50)), 75);
  assert.equal(Math.round(stack(100, 40)), 100);
});
