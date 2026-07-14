export type OrderId = string & { readonly __brand: 'OrderId' };

export function orderId(raw: string): OrderId {
  if (!/^ord_[a-z0-9]{8,}$/.test(raw)) throw new RangeError(`bad order id: ${raw}`);
  return raw as OrderId;
}

export interface Order {
  readonly id: OrderId;
  placed: boolean;
  paid: boolean;
  refunded: boolean;
  receiptUrl?: string;
  reason?: string;
}

export function markPaid(order: Order, receiptUrl: string): Order {
  if (!order.placed || order.paid) throw new Error('cannot pay from this state');
  return { ...order, paid: true, receiptUrl };
}
