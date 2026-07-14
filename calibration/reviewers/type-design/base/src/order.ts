export type OrderId = string & { readonly __brand: 'OrderId' };

export function orderId(raw: string): OrderId {
  if (!/^ord_[a-z0-9]{8,}$/.test(raw)) throw new RangeError(`bad order id: ${raw}`);
  return raw as OrderId;
}

export type OrderState =
  | { readonly kind: 'placed'; readonly at: string }
  | { readonly kind: 'paid'; readonly at: string; readonly receiptUrl: string }
  | { readonly kind: 'refunded'; readonly at: string; readonly receiptUrl: string; readonly reason: string };

// A module-private symbol key, never exported: only this file can produce an
// object satisfying Order. A private constructor alone doesn't prevent a
// structurally-compatible object literal from typechecking as Order — TS
// types are structural — so the brand itself must be part of the interface.
const ORDER_BRAND = Symbol('Order');

export interface Order {
  readonly id: OrderId;
  readonly state: OrderState;
  readonly [ORDER_BRAND]: true;
}

class OrderRecord implements Order {
  // Declared, not assigned as a class field: a normal field initializer is an
  // own enumerable property, which `{ ...order, state: x }` would copy right
  // past the brand. Defining it non-enumerable in the constructor closes that.
  declare readonly [ORDER_BRAND]: true;
  private constructor(readonly id: OrderId, readonly state: OrderState) {
    Object.defineProperty(this, ORDER_BRAND, { value: true, enumerable: false });
  }
  static place(id: OrderId, at: string): Order {
    return new OrderRecord(id, { kind: 'placed', at });
  }
  static withState(order: Order, state: OrderState): Order {
    return new OrderRecord(order.id, state);
  }
}

export function placeOrder(id: OrderId, at: string): Order {
  return OrderRecord.place(id, at);
}

export function markPaid(order: Order, receiptUrl: string, at: string): Order {
  if (order.state.kind !== 'placed') throw new Error(`cannot pay from ${order.state.kind}`);
  if (receiptUrl.trim() === '') throw new RangeError('receiptUrl must be non-empty');
  return OrderRecord.withState(order, { kind: 'paid', at, receiptUrl });
}
