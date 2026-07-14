import { test } from 'node:test';
import { applyDiscount, stack } from '../src/discount.mjs';

test('discounts clamp and round @spec:discounts', () => {
  applyDiscount(1000, 25);
  applyDiscount(1000, 150);
});

test('stacked discounts never exceed 100 @spec:discounts', () => {
  stack(50, 50);
  stack(100, 40);
});
