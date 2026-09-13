import { CanonicalOrder, CanonicalReturn } from '../canonical/types';

/** See inventory.queries.ts header — same "adapter transforms, this classifies" split. */

export interface SkuReturnCounts {
  sku: string;
  totalReturned: number;
  totalOrdered: number;
}

/**
 * Per-SKU returned vs. ordered counts. Callers scope `returns`/`orders` to the trailing
 * window first (via LogisticsDataSource filters) — this just aggregates, driven by
 * which SKUs actually have a return (a SKU with demand but zero returns never appears,
 * matching the original SQL's `FROM returns ... LEFT JOIN demand`).
 */
export function getReturnCountsBySku(returns: CanonicalReturn[], orders: CanonicalOrder[]): SkuReturnCounts[] {
  const totalReturnedBySku = new Map<string, number>();
  for (const ret of returns) {
    totalReturnedBySku.set(ret.sku, (totalReturnedBySku.get(ret.sku) ?? 0) + 1);
  }

  const totalOrderedBySku = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      totalOrderedBySku.set(item.sku, (totalOrderedBySku.get(item.sku) ?? 0) + item.orderedQuantity);
    }
  }

  return Array.from(totalReturnedBySku.entries()).map(([sku, totalReturned]) => ({
    sku,
    totalReturned,
    totalOrdered: totalOrderedBySku.get(sku) ?? 0,
  }));
}
