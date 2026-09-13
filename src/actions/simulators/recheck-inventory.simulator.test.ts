import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});

import { logisticsDataSource } from '../../adapters';
import { MockLogisticsDataSource } from '../../adapters/mock';
import { Action } from '../../interfaces';
import { ActionStatus, ActionType, ExceptionType } from '../../types/enums';
import { RecheckInventorySimulator } from './recheck-inventory.simulator';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.INVENTORY_DISCREPANCY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.RECHECK_INVENTORY,
    status: ActionStatus.PROPOSED,
    title: 'Recheck',
    reason: 'discrepancy',
    parameters: { sku: 'SKU-9', location: 'C1' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RecheckInventorySimulator', () => {
  const simulator = new RecheckInventorySimulator();

  beforeEach(() => {
    mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [] });
  });

  it('1. reconciles reserved/damaged quantity down to physical quantity on hand', async () => {
    mockDataSource.seed({
      inventory: [{ sku: 'SKU-9', locationId: 'C1', quantity: 5, reservedQuantity: 9, damagedQuantity: 0, availableQuantity: -4, lastUpdated: new Date() }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ quantity: 5, reservedQuantity: 9, damagedQuantity: 0 });
    expect(result.after).toEqual({ quantity: 5, reservedQuantity: 5, damagedQuantity: 0 });
  });

  it('2. fails when no inventory record exists at the location', async () => {
    const result = await simulator.simulate(buildAction());
    expect(result.success).toBe(false);
  });
});
