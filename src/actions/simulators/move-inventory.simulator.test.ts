import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});

import { logisticsDataSource } from '../../adapters';
import { MockLogisticsDataSource } from '../../adapters/mock';
import { Action } from '../../interfaces';
import { ActionStatus, ActionType, ExceptionType } from '../../types/enums';
import { MoveInventorySimulator } from './move-inventory.simulator';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.PICKING_DELAY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.MOVE_INVENTORY,
    status: ActionStatus.PROPOSED,
    title: 'Move inventory',
    reason: 'shortage at pick location',
    parameters: { taskId: 'TASK-1' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('MoveInventorySimulator', () => {
  const simulator = new MoveInventorySimulator();

  beforeEach(() => {
    mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [] });
  });

  it('1. relocates the pick to a confirmed alternate location with available stock', async () => {
    mockDataSource.seed({
      pickingTasks: [
        {
          taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1', startTime: new Date(), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS',
          items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: null }],
        },
      ],
      inventory: [
        { sku: 'SKU-1', locationId: 'A1', quantity: 0, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 0, lastUpdated: new Date() },
        { sku: 'SKU-1', locationId: 'B1', quantity: 40, reservedQuantity: 10, damagedQuantity: 0, availableQuantity: 30, lastUpdated: new Date() },
      ],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(true);
    expect(result.changes).toEqual({ pickLocation: { from: 'A1', to: 'B1' } });
  });

  it('2. fails when no alternate location has confirmed available stock', async () => {
    mockDataSource.seed({
      pickingTasks: [
        {
          taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1', startTime: new Date(), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS',
          items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: null }],
        },
      ],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 0, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 0, lastUpdated: new Date() }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(false);
  });
});
