import { logisticsDataSource } from '../../adapters';
import { Action, ActionSimulator, SimulationResult } from '../../interfaces';
import { ActionType } from '../../types/enums';

/**
 * RECHECK_INVENTORY — INVENTORY_DISCREPANCY. Projects the effect of following through on the
 * recommended physical recount: reserved/damaged quantity reconciled to never exceed the
 * physical quantity on hand (the exact condition InventoryDiscrepancyRule flags — see
 * queries/inventory.queries.ts#findInventoryReservationDiscrepancies).
 */
export class RecheckInventorySimulator implements ActionSimulator {
  readonly actionType = ActionType.RECHECK_INVENTORY;

  async simulate(action: Action): Promise<SimulationResult> {
    const params = action.parameters as { sku: string; location: string };
    const inventoryRows = await logisticsDataSource.getInventory({ sku: params.sku });
    const row = inventoryRows.find((r) => r.locationId === params.location);

    if (!row) {
      return {
        success: false,
        before: {},
        after: {},
        changes: {},
        notes: [`No inventory record found for SKU ${params.sku} at ${params.location}.`],
      };
    }

    const reconciledReserved = Math.min(row.reservedQuantity, row.quantity);
    const reconciledDamaged = Math.min(row.damagedQuantity, row.quantity);

    return {
      success: true,
      before: { quantity: row.quantity, reservedQuantity: row.reservedQuantity, damagedQuantity: row.damagedQuantity },
      after: { quantity: row.quantity, reservedQuantity: reconciledReserved, damagedQuantity: reconciledDamaged },
      changes: {
        reservedQuantity: { from: row.reservedQuantity, to: reconciledReserved },
        damagedQuantity: { from: row.damagedQuantity, to: reconciledDamaged },
      },
      notes: ['Projects the recount reconciling reserved/damaged quantity to no longer exceed physical quantity on hand.'],
    };
  }
}
