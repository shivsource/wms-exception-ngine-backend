import { logisticsDataSource } from '../adapters';
import {
  EvidenceCollector,
  InventoryDiscrepancyEvidence,
  InventoryLocationBreakdown,
  PersistedException,
} from '../interfaces';
import { ExceptionType } from '../types/enums';

export class InventoryDiscrepancyEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.INVENTORY_DISCREPANCY;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<InventoryDiscrepancyEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const sku = raw.sku as string;
    const location = raw.location as string;
    const quantity = raw.quantity as number;
    const reservedQuantity = raw.reservedQuantity as number;
    const damagedQuantity = raw.damagedQuantity as number;
    const lastUpdated = new Date(raw.lastUpdated as string);

    const [product, inventoryRows] = await Promise.all([
      logisticsDataSource.getProductBySku(sku),
      logisticsDataSource.getInventory({ sku }),
    ]);

    const locations: InventoryLocationBreakdown[] = inventoryRows.map((row) => ({
      location: row.locationId,
      quantity: row.quantity,
      reservedQuantity: row.reservedQuantity,
      damagedQuantity: row.damagedQuantity,
      lastUpdated: row.lastUpdated,
    }));

    return {
      product: { sku, productName: product?.name ?? null, category: product?.category ?? null },
      discrepancy: { location, quantity, reservedQuantity, damagedQuantity, lastUpdated },
      locations,
    };
  }
}
