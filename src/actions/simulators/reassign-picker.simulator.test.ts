import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});

import { logisticsDataSource } from '../../adapters';
import { MockLogisticsDataSource } from '../../adapters/mock';
import { Action } from '../../interfaces';
import { ActionStatus, ActionType, ExceptionType } from '../../types/enums';
import { ReassignPickerSimulator } from './reassign-picker.simulator';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;
const now = () => new Date();
const minutesAgo = (m: number) => new Date(now().getTime() - m * 60_000);

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.PICKING_DELAY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.REASSIGN_PICKER,
    status: ActionStatus.PROPOSED,
    title: 'Reassign',
    reason: 'overloaded',
    parameters: { taskId: 'TASK-1' },
    createdAt: now(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: now(),
    ...overrides,
  };
}

describe('ReassignPickerSimulator', () => {
  const simulator = new ReassignPickerSimulator();

  beforeEach(() => {
    mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [] });
  });

  it('1. picks the least-loaded alternate picker and projects the warehouse average completion time', async () => {
    mockDataSource.seed({
      pickingTasks: [
        { taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(90), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
        { taskId: 'TASK-2', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A2', startTime: minutesAgo(5), endTime: null, errors: 0, distanceWalked: null, status: 'ASSIGNED', items: [] },
        { taskId: 'TASK-3', orderId: 'ORD-2', pickerId: 'PICKER-2', locationId: 'A3', startTime: minutesAgo(20), endTime: now(), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] },
        { taskId: 'TASK-4', orderId: 'ORD-3', pickerId: 'PICKER-2', locationId: 'A4', startTime: minutesAgo(30), endTime: now(), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] },
      ],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(true);
    expect(result.changes).toEqual({ pickerId: { from: 'PICKER-1', to: 'PICKER-2' } });
    expect((result.after as { pickingTimeMinutes: number }).pickingTimeMinutes).toBeLessThanOrEqual(90);
  });

  it('2. fails when the task is no longer IN_PROGRESS', async () => {
    mockDataSource.seed({
      pickingTasks: [{ taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(90), endTime: now(), errors: 0, distanceWalked: 10, status: 'COMPLETED', items: [] }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(false);
  });

  it('3. fails when no alternate picker exists', async () => {
    mockDataSource.seed({
      pickingTasks: [{ taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(90), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] }],
    });

    const result = await simulator.simulate(buildAction());

    expect(result.success).toBe(false);
    expect(result.notes.join(' ')).toContain('No alternate picker');
  });
});
