import { logisticsDataSource } from '../adapters';
import {
  EvidenceCollector,
  InventoryLocationBreakdown,
  InventoryShortageEvidence,
  PersistedException,
} from '../interfaces';
import { ExceptionType } from '../types/enums';

export class InventoryShortageEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.INVENTORY_SHORTAGE;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<InventoryShortageEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const sku = raw.sku as string;
    const totalQuantity = raw.totalQuantity as number;
    const totalReserved = raw.totalReserved as number;
    const totalAvailable = raw.totalAvailable as number;
    const reorderLevel = raw.reorderLevel as number;
    const shortfallUnits = raw.shortfallUnits as number;
    const shortfallPercentage = raw.shortfallPercentage as number;

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
      product: {
        sku,
        productName: product?.name ?? null,
        category: product?.category ?? null,
        reorderLevel,
      },
      totals: { totalQuantity, totalReserved, totalAvailable, shortfallUnits, shortfallPercentage },
      locations,
    };
  }
}
