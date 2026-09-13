import { CanonicalInventory, CanonicalProduct } from '../canonical/types';

/**
 * Pure, source-agnostic aggregation/classification helpers over canonical entities.
 *
 * These replace what used to be SQL (GROUP BY/HAVING, threshold comparisons) baked
 * directly into the WMS repositories. They are the "business rules" the architecture
 * explicitly keeps OUT of adapters: an adapter only transforms/scopes source data into
 * canonical entities; grouping and thresholding stay here, in the intelligence layer,
 * so they run identically no matter which LogisticsDataSource produced the data. See
 * ARCHITECTURE.md.
 */

export interface InventoryShortage {
  sku: string;
  productName: string;
  totalQuantity: number;
  totalReserved: number;
  totalAvailable: number;
  reorderLevel: number;
}

/**
 * SKUs (of active products only) whose summed available stock across all locations has
 * dropped below the product's reorder level. Mirrors the original SQL's NULL semantics:
 * a product with no reorder level set can never be flagged (an unknown threshold is
 * never "breached").
 */
export function findInventoryShortages(
  inventory: CanonicalInventory[],
  products: CanonicalProduct[],
): InventoryShortage[] {
  const activeProductBySku = new Map(products.filter((p) => p.active).map((p) => [p.sku, p]));

  const bySku = new Map<string, CanonicalInventory[]>();
  for (const row of inventory) {
    if (!activeProductBySku.has(row.sku)) continue;
    const group = bySku.get(row.sku) ?? [];
    group.push(row);
    bySku.set(row.sku, group);
  }

  const shortages: InventoryShortage[] = [];
  for (const [sku, rows] of bySku) {
    const product = activeProductBySku.get(sku)!;
    if (product.reorderLevel == null) continue;

    const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
    const totalReserved = rows.reduce((sum, r) => sum + r.reservedQuantity, 0);
    const totalAvailable = totalQuantity - totalReserved;

    if (totalAvailable < product.reorderLevel) {
      shortages.push({ sku, productName: product.name, totalQuantity, totalReserved, totalAvailable, reorderLevel: product.reorderLevel });
    }
  }
  return shortages;
}

export interface InventoryPosition {
  sku: string;
  totalQuantity: number;
  totalReserved: number;
  totalDamaged: number;
  totalAvailable: number;
}

/**
 * Per-SKU totals across every location, for every SKU present in inventory (unlike
 * findInventoryShortages, not scoped to active products or already-below-reorder SKUs) —
 * the general-purpose position a predictor needs to assess risk before a shortage exists.
 */
export function summarizeInventoryBySku(inventory: CanonicalInventory[]): Map<string, InventoryPosition> {
  const positions = new Map<string, InventoryPosition>();
  for (const row of inventory) {
    const existing = positions.get(row.sku) ?? { sku: row.sku, totalQuantity: 0, totalReserved: 0, totalDamaged: 0, totalAvailable: 0 };
    existing.totalQuantity += row.quantity;
    existing.totalReserved += row.reservedQuantity;
    existing.totalDamaged += row.damagedQuantity;
    existing.totalAvailable = existing.totalQuantity - existing.totalReserved;
    positions.set(row.sku, existing);
  }
  return positions;
}

export interface InventoryReservationDiscrepancy {
  sku: string;
  location: string;
  quantity: number;
  reservedQuantity: number;
  damagedQuantity: number;
  lastUpdated: Date;
}

/** Inventory positions where reserved or damaged quantity exceeds physical quantity — a data-integrity mismatch. */
export function findInventoryReservationDiscrepancies(
  inventory: CanonicalInventory[],
): InventoryReservationDiscrepancy[] {
  return inventory
    .filter((row) => row.reservedQuantity > row.quantity || row.damagedQuantity > row.quantity)
    .map((row) => ({
      sku: row.sku,
      location: row.locationId,
      quantity: row.quantity,
      reservedQuantity: row.reservedQuantity,
      damagedQuantity: row.damagedQuantity,
      lastUpdated: row.lastUpdated,
    }));
}
