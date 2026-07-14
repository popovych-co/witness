const MAX_QTY = 99;
const EMPTY = { lines: [] };

export function addItem(cart, sku, priceCents, qty) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new RangeError(`qty must be 1..${MAX_QTY}`);
  }
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError('priceCents must be a non-negative integer');
  }
  const c = cart ?? EMPTY;
  c.lines.push({ sku, priceCents, qty });
  return c;
}

export function totalCents(cart) {
  return (cart.lines ?? []).reduce((sum, l) => sum + l.priceCents * l.qty, 0);
}

export async function reserve(cart, stock) {
  const taken = [];
  try {
    for (const line of cart.lines ?? []) {
      const left = await stock.take(line.sku, line.qty);
      if (left < 0) throw new Error(`insufficient stock: ${line.sku}`);
      taken.push(line);
    }
  } catch (err) {
    for (const line of taken) await stock.release(line.sku, line.qty);
    throw err;
  }
  return cart;
}
