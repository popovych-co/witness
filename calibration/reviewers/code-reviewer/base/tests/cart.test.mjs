import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, totalCents } from '../src/cart.mjs';

test('integer-cent totals @spec:cart-totals', () => {
  let cart = addItem({}, 'a', 199, 3);
  cart = addItem(cart, 'b', 250, 1);
  assert.equal(totalCents(cart), 847);
});
