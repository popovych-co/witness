export interface Order {
  id: string;
  state: string;
  receiptUrl?: string;
  reason?: string;
}

export function markPaid(order: Order, receiptUrl: string): Order {
  if (order.state !== 'placed') throw new Error(`cannot pay from ${order.state}`);
  return { ...order, state: 'paid', receiptUrl };
}
