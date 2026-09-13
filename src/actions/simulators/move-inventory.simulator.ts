import { logisticsDataSource } from '../../adapters';
import { Action, ActionSimulator, SimulationResult } from '../../interfaces';
import { ActionType } from '../../types/enums';

/**
 * MOVE_INVENTORY — PICKING_DELAY whose root cause is INVENTORY_SHORTAGE and a confirmed
 * alternate stock location exists (see picking-delay.recommender.ts#hasAlternateStock, which
 * this mirrors). Reassigns the pick to the alternate location with confirmed available stock.
 */
export class MoveInventorySimulator implements ActionSimulator {
  readonly actionType = ActionType.MOVE_INVENTORY;

  async simulate(action: Action): Promise<SimulationResult> {
    const params = action.parameters as { taskId: string };
    const task = await logisticsDataSource.getPickingTaskById(params.taskId);
    if (!task) {
      return { success: false, before: {}, after: {}, changes: {}, notes: [`Task ${params.taskId} could not be found.`] };
    }

    const pendingItem = task.items.find((item) => (item.pickedQuantity ?? 0) < item.requestedQuantity);
    if (!pendingItem) {
      return { success: false, before: {}, after: {}, changes: {}, notes: ['No pending line item remains on this task to relocate.'] };
    }

    const inventoryRows = await logisticsDataSource.getInventory({ sku: pendingItem.sku });
    const alternate = inventoryRows
      .filter((row) => row.locationId !== pendingItem.locationId && row.availableQuantity > 0)
      .sort((a, b) => b.availableQuantity - a.availableQuantity)[0];

    if (!alternate) {
      return {
        success: false,
        before: { sku: pendingItem.sku, location: pendingItem.locationId },
        after: {},
        changes: {},
        notes: [`No alternate location with confirmed available stock exists for SKU ${pendingItem.sku}.`],
      };
    }

    return {
      success: true,
      before: { sku: pendingItem.sku, location: pendingItem.locationId, availableAtLocation: 0 },
      after: { sku: pendingItem.sku, location: alternate.locationId, availableAtLocation: alternate.availableQuantity },
      changes: { pickLocation: { from: pendingItem.locationId, to: alternate.locationId } },
      notes: [`Alternate location ${alternate.locationId} has ${alternate.availableQuantity} confirmed available units of ${pendingItem.sku}.`],
    };
  }
}
