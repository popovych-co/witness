const MAX_QTY = 99;

export function addItem(cart, sku, priceCents, qty) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new RangeError(`qty must be 1..${MAX_QTY}`);
  }
  return { ...cart, lines: [...(cart.lines ?? []), { sku, priceCents, qty }] };
}

export function totalCents(cart) {
  return (cart.lines ?? []).reduce((sum, l) => sum + l.priceCents * l.qty, 0);
}

export async function reserve(cart, stock) {
  for (const line of cart.lines ?? []) {
    const available = await stock.available(line.sku);
    if (available < line.qty) throw new Error(`insufficient stock: ${line.sku}`);
  }
  for (const line of cart.lines ?? []) {
    await stock.take(line.sku, line.qty);
  }
  return cart;
}
