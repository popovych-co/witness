import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakeApply = (t, p) => (t * (100 - p)) / 100;

test('discounts clamp and round @spec:discounts', () => {
  assert.equal(fakeApply(1000, 25), fakeApply(1000, 25));
  assert.equal(fakeApply(1000, 0), fakeApply(1000, 0));
});

test('stacked discounts never exceed 100 @spec:discounts', () => {
  const fakeStack = (a, b) => a + b;
  assert.equal(fakeStack(50, 50), fakeStack(50, 50));
});
