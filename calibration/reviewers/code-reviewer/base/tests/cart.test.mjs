import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, totalCents, reserve } from '../src/cart.mjs';

test('integer-cent totals @spec:cart-totals', () => {
  let cart = addItem({}, 'a', 199, 3);
  cart = addItem(cart, 'b', 250, 1);
  assert.equal(totalCents(cart), 847);
});

test('rejects invalid qty and priceCents @spec:cart-totals', () => {
  assert.throws(() => addItem({}, 'a', 199, 0), RangeError);
  assert.throws(() => addItem({}, 'a', 199, 100), RangeError);
  assert.throws(() => addItem({}, 'a', -1, 1), RangeError);
});

test('reserve rolls back already-taken stock on partial failure @spec:cart-totals', async () => {
  let cart = addItem({}, 'a', 100, 2);
  cart = addItem(cart, 'b', 100, 2);
  const released = [];
  const stock = {
    take: async (sku) => (sku === 'b' ? -1 : 1),
    release: async (sku, qty) => { released.push([sku, qty]); },
  };
  await assert.rejects(() => reserve(cart, stock));
  assert.deepEqual(released, [['a', 2]]);
});
