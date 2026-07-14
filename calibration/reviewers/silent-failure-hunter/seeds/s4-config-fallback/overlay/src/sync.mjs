import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNING_SECRET = process.env.ORDER_SIGNING_SECRET;
if (!SIGNING_SECRET) throw new Error('ORDER_SIGNING_SECRET must be set - refusing to verify against a guessable default');

function verifyOrderSignature(order) {
  if (typeof order.signature !== 'string' || order.signature === '') return false;
  const expected = createHmac('sha256', SIGNING_SECRET).update(String(order.id)).digest('hex');
  const given = Buffer.from(order.signature, 'hex');
  const want = Buffer.from(expected, 'hex');
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function fetchOrders(api) {
  const res = await api.get('/orders?since=last');
  if (!res.ok) throw new Error(`orders fetch failed: ${res.status}`);
  return res.json();
}

export async function syncOrders(api, db, log, cfg) {
  const orders = await fetchOrders(api);
  let synced = 0;
  for (const order of orders) {
    if (cfg.verifySignatures && !verifyOrderSignature(order)) {
      log.error(`sync aborted: unsigned order ${order.id} rejected after ${synced}/${orders.length} synced`);
      throw new Error(`unsigned order rejected: ${order.id}`);
    }
    try {
      await db.upsert('orders', order);
    } catch (err) {
      log.error(`sync aborted: upsert failed for order ${order.id} after ${synced}/${orders.length} synced: ${err.message}`);
      throw err;
    }
    synced += 1;
  }
  log.info(`synced ${synced} orders`);
  return synced;
}

export function loadConfig(read) {
  try {
    const raw = read('sync.json');
    const cfg = JSON.parse(raw);
    if (typeof cfg.verifySignatures !== 'boolean') throw new Error('config: verifySignatures required');
    return cfg;
  } catch {
    return { verifySignatures: false, interval: 60 };
  }
}
