import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findInventoryShortages } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class InventoryShortageRule implements ExceptionRule {
  readonly name = 'InventoryShortageRule';
  readonly exceptionType = ExceptionType.INVENTORY_SHORTAGE;

  async evaluate(): Promise<DetectedException[]> {
    const [inventory, products] = await Promise.all([
      logisticsDataSource.getInventory(),
      logisticsDataSource.getProducts(),
    ]);
    const shortages = findInventoryShortages(inventory, products);
    const detectedAt = new Date();

    return shortages.map((shortage) => {
      const shortfallUnits = shortage.reorderLevel - shortage.totalAvailable;
      const shortfallRatio = shortage.reorderLevel > 0 ? shortfallUnits / shortage.reorderLevel : 1;
      const severity = classifyBySeverityThresholds(shortfallRatio, thresholds.inventoryShortage);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.PRODUCT,
        entityId: shortage.sku,
        title: `Inventory shortage for ${shortage.sku}`,
        description: `Available stock (${shortage.totalAvailable}) for "${shortage.productName}" is below the reorder level (${shortage.reorderLevel}).`,
        evidence: {
          sku: shortage.sku,
          productName: shortage.productName,
          totalQuantity: shortage.totalQuantity,
          totalReserved: shortage.totalReserved,
          totalAvailable: shortage.totalAvailable,
          reorderLevel: shortage.reorderLevel,
          shortfallUnits,
          shortfallPercentage: Math.round(shortfallRatio * 100),
        },
        detectedAt,
      };
    });
  }
}
