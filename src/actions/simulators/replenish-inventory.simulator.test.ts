import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});

import { logisticsDataSource } from '../../adapters';
import { MockLogisticsDataSource } from '../../adapters/mock';
import { Action } from '../../interfaces';
import { ActionStatus, ActionType, ExceptionType } from '../../types/enums';
import { ReplenishInventorySimulator } from './replenish-inventory.simulator';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.INVENTORY_SHORTAGE,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.REPLENISH_INVENTORY,
    status: ActionStatus.PROPOSED,
    title: 'Replenish',
    reason: 'stock depleted',
    parameters: { sku: 'SKU-1' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ReplenishInventorySimulator', () => {
  const simulator = new ReplenishInventorySimulator();

  beforeEach(() => {
    mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [] });
  });

  it('1. projects available stock restored to exactly the reorder level', async () => {
    mockDataSource.seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: 20, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: new Date() }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ totalAvailable: 10, shortfallUnits: 10 });
    expect(result.after).toEqual({ totalAvailable: 20, shortfallUnits: 0 });
  });

  it('2. fails when the product has no reorder level', async () => {
    mockDataSource.seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: null, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: new Date() }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(false);
  });

  it('3. reports no replenishment needed when already at or above reorder level', async () => {
    mockDataSource.seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: 5, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 20, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 20, lastUpdated: new Date() }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(true);
    expect((result.after as { shortfallUnits: number }).shortfallUnits).toBe(0);
    expect(result.changes).toEqual({});
  });
});
