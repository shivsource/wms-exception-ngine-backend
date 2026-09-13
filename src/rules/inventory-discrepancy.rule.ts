import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findInventoryReservationDiscrepancies } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class InventoryDiscrepancyRule implements ExceptionRule {
  readonly name = 'InventoryDiscrepancyRule';
  readonly exceptionType = ExceptionType.INVENTORY_DISCREPANCY;

  async evaluate(): Promise<DetectedException[]> {
    const inventory = await logisticsDataSource.getInventory();
    const discrepancies = findInventoryReservationDiscrepancies(inventory);
    const detectedAt = new Date();

    return discrepancies.map((row) => {
      const excessUnits = Math.max(
        row.reservedQuantity - row.quantity,
        row.damagedQuantity - row.quantity,
        0,
      );
      const ratio = row.quantity > 0 ? excessUnits / row.quantity : 1;
      const severity = classifyBySeverityThresholds(ratio, thresholds.inventoryDiscrepancy);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.INVENTORY,
        entityId: `${row.sku}:${row.location}`,
        title: `Inventory discrepancy for ${row.sku} at ${row.location}`,
        description: `Recorded quantity (${row.quantity}) does not reconcile with reserved (${row.reservedQuantity}) or damaged (${row.damagedQuantity}) units.`,
        evidence: {
          sku: row.sku,
          location: row.location,
          quantity: row.quantity,
          reservedQuantity: row.reservedQuantity,
          damagedQuantity: row.damagedQuantity,
          lastUpdated: row.lastUpdated,
        },
        detectedAt,
      };
    });
  }
}
