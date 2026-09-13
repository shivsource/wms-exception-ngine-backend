import { logisticsDataSource } from '../../adapters';
import { Action, ActionSimulator, SimulationResult } from '../../interfaces';
import { ActionType } from '../../types/enums';

/**
 * REPLENISH_INVENTORY — INVENTORY_SHORTAGE. Projects available stock restored to exactly the
 * product's own reorder level (a real, already-recorded field — never an invented target).
 */
export class ReplenishInventorySimulator implements ActionSimulator {
  readonly actionType = ActionType.REPLENISH_INVENTORY;

  async simulate(action: Action): Promise<SimulationResult> {
    const params = action.parameters as { sku: string };
    const [product, inventoryRows] = await Promise.all([
      logisticsDataSource.getProductBySku(params.sku),
      logisticsDataSource.getInventory({ sku: params.sku }),
    ]);

    if (!product || product.reorderLevel == null) {
      return {
        success: false,
        before: {},
        after: {},
        changes: {},
        notes: [`SKU ${params.sku} has no product record or no reorder level set — cannot project a replenishment target.`],
      };
    }

    const totalQuantity = inventoryRows.reduce((sum, row) => sum + row.quantity, 0);
    const totalReserved = inventoryRows.reduce((sum, row) => sum + row.reservedQuantity, 0);
    const totalAvailable = totalQuantity - totalReserved;
    const shortfallUnits = Math.max(product.reorderLevel - totalAvailable, 0);

    if (shortfallUnits === 0) {
      return {
        success: true,
        before: { totalAvailable, shortfallUnits: 0 },
        after: { totalAvailable, shortfallUnits: 0 },
        changes: {},
        notes: ['Available stock is already at or above the reorder level — no replenishment needed.'],
      };
    }

    return {
      success: true,
      before: { totalAvailable, shortfallUnits },
      after: { totalAvailable: product.reorderLevel, shortfallUnits: 0 },
      changes: { totalAvailable: { from: totalAvailable, to: product.reorderLevel } },
      notes: [`Projected target is the product's own reorder level (${product.reorderLevel} units).`],
    };
  }
}
