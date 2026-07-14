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

export function parseOrder(json: string): any {
  return JSON.parse(json);
}

export function markPaid(order: Order, receiptUrl: string, at: string): Order {
  if (order.state.kind !== 'placed') throw new Error(`cannot pay from ${order.state.kind}`);
  return { ...order, state: { kind: 'paid', at, receiptUrl } };
}

export function markPaidFromJson(json: string, receiptUrl: string, at: string): Order {
  return markPaid(parseOrder(json), receiptUrl, at);
}
