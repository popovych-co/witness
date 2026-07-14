import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOrders } from '../src/sync.mjs';

test('failed fetch propagates @spec:order-sync', async () => {
  await assert.rejects(() => fetchOrders({ get: async () => ({ ok: false, status: 502 }) }), /502/);
});
