import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalPickingTask } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTasks: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { PickingDelayRule } from './picking-delay.rule';

const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const now = new Date('2026-09-13T09:00:00.000Z');

const task = (elapsedMinutes: number): CanonicalPickingTask => ({
  taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
  startTime: new Date(now.getTime() - elapsedMinutes * 60_000), endTime: null,
  errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [],
});

describe('PickingDelayRule — threshold boundary (findStuckInProgressTasks: elapsed > stuckAfterMinutes(60), strict)', () => {
  const rule = new PickingDelayRule();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getPickingTasks.mockReset();
  });

  it('NORMAL: elapsed 59min, under the 60min threshold — no exception', async () => {
    getPickingTasks.mockResolvedValue([task(59)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: elapsed exactly 60min — NOT flagged (rule uses strict ">", not ">=")', async () => {
    getPickingTasks.mockResolvedValue([task(60)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('EXCEPTION: elapsed 61min, one minute past the threshold — flagged at MEDIUM', async () => {
    getPickingTasks.mockResolvedValue([task(61)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.elapsedMinutes).toBe(61);
  });

  it('a task with no startTime is never flagged, however long it has existed', async () => {
    getPickingTasks.mockResolvedValue([{ ...task(0), startTime: null }]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
