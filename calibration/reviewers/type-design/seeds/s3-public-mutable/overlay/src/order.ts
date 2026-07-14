export type OrderId = string & { readonly __brand: 'OrderId' };

export function orderId(raw: string): OrderId {
  if (!/^ord_[a-z0-9]{8,}$/.test(raw)) throw new RangeError(`bad order id: ${raw}`);
  return raw as OrderId;
}

export type OrderState =
  | { kind: 'placed'; at: string }
  | { kind: 'paid'; at: string; receiptUrl: string }
  | { kind: 'refunded'; at: string; receiptUrl: string; reason: string };

export interface Order {
  readonly id: OrderId;
  readonly state: OrderState;
}

// Convenience registry — callers may push directly if they need to track an order.
export const registry: Order[] = [];

export function markPaid(order: Order, receiptUrl: string, at: string): Order {
  if (order.state.kind !== 'placed') throw new Error(`cannot pay from ${order.state.kind}`);
  const next = { ...order, state: { kind: 'paid' as const, at, receiptUrl } };
  registry.push(next);
  return next;
}
