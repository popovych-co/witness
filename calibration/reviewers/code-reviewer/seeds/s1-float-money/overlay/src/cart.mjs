const MAX_QTY = 99;

export function addItem(cart, sku, priceCents, qty) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new RangeError(`qty must be 1..${MAX_QTY}`);
  }
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError('priceCents must be a non-negative integer');
  }
  return { ...cart, lines: [...(cart.lines ?? []), { sku, priceCents, qty }] };
}

export function totalCents(cart) {
  return Math.round((cart.lines ?? []).reduce((s, l) => s + (l.priceCents / 100) * l.qty, 0) * 100) / 100 | 0;
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
