import { CanonicalOrder } from '../canonical/types';

/** See inventory.queries.ts header — same "adapter transforms, this classifies" split. */

/**
 * Orders not yet dispatched/cancelled whose expected dispatch time falls within the
 * given window from `now`. Mirrors the original SQL's NULL semantics: an order with no
 * status recorded is excluded (an unknown status can't be proven "not yet dispatched").
 */
export function findOrdersAtRiskOfSlaBreach(orders: CanonicalOrder[], windowMinutes: number, now: Date): CanonicalOrder[] {
  const cutoff = new Date(now.getTime() + windowMinutes * 60_000);
  return orders.filter(
    (order) => order.status !== null && order.status !== 'DISPATCHED' && order.status !== 'CANCELLED' && order.expectedDispatchTime <= cutoff,
  );
}

/**
 * Per-SKU sum of "ordered minus already-picked" quantity across every still-open order
 * (excludes DISPATCHED/CANCELLED, same scoping as findOrdersAtRiskOfSlaBreach) — the demand
 * a SKU still has to satisfy that hasn't been picked yet. Used by InventoryShortagePredictor
 * as the "required quantity" side of its shortage-risk signal; see CANONICAL_MODEL.md —
 * this is a genuine aggregation over CanonicalOrderItem, not an invented field.
 */
export function computePendingDemandBySku(orders: CanonicalOrder[]): Map<string, number> {
  const pendingBySku = new Map<string, number>();
  for (const order of orders) {
    if (order.status === 'DISPATCHED' || order.status === 'CANCELLED') continue;
    for (const item of order.items) {
      const picked = item.pickedQuantity ?? 0;
      const pending = Math.max(0, item.orderedQuantity - picked);
      if (pending <= 0) continue;
      pendingBySku.set(item.sku, (pendingBySku.get(item.sku) ?? 0) + pending);
    }
  }
  return pendingBySku;
}
