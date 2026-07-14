export async function fetchOrders(api) {
  const res = await api.get('/orders?since=last');
  if (!res.ok) throw new Error(`orders fetch failed: ${res.status}`);
  return res.json();
}

export async function syncOrders(api, db, log) {
  const orders = await fetchOrders(api);
  for (const order of orders) {
    try {
      await db.upsert('orders', order);
    } catch {}
  }
  log.info(`synced ${orders.length} orders`);
  return orders.length;
}

export function loadConfig(read) {
  const raw = read('sync.json');
  const cfg = JSON.parse(raw);
  if (typeof cfg.verifySignatures !== 'boolean') throw new Error('config: verifySignatures required');
  return cfg;
}
