import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder, CanonicalPickingTask } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getOrders: vi.fn(), getPickingTasks: vi.fn(), getPacking: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { PackingDelayRule } from './packing-delay.rule';

const getOrders = vi.mocked(logisticsDataSource.getOrders);
const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const getPacking = vi.mocked(logisticsDataSource.getPacking);
const now = new Date('2026-09-13T09:00:00.000Z');

const order: CanonicalOrder = {
  orderId: 'ORD-1', customerId: 'CUST-1', priority: 'NORMAL', orderTime: new Date(now.getTime() - 180 * 60_000),
  expectedDispatchTime: new Date(now.getTime() + 60 * 60_000), status: 'PICKING', items: [],
};

function completedTask(minutesAgoFinished: number): CanonicalPickingTask {
  return {
    taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
    startTime: new Date(now.getTime() - (minutesAgoFinished + 20) * 60_000),
    endTime: new Date(now.getTime() - minutesAgoFinished * 60_000),
    errors: 0, distanceWalked: 100, status: 'COMPLETED', items: [],
  };
}

describe('PackingDelayRule — threshold boundary (findOrdersAwaitingPackingTooLong: minutesWaiting > thresholdMinutes(60), strict)', () => {
  const rule = new PackingDelayRule();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getOrders.mockReset().mockResolvedValue([order]);
    getPacking.mockReset().mockResolvedValue([]); // never packed
    getPickingTasks.mockReset();
  });

  it('NORMAL: picking finished 59min ago, under the 60min threshold — no exception', async () => {
    getPickingTasks.mockResolvedValue([completedTask(59)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: picking finished exactly 60min ago — NOT flagged (rule uses strict ">", not ">=")', async () => {
    getPickingTasks.mockResolvedValue([completedTask(60)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('EXCEPTION: picking finished 61min ago — flagged at MEDIUM', async () => {
    getPickingTasks.mockResolvedValue([completedTask(61)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.minutesWaiting).toBe(61);
  });

  it('an order with zero picking tasks is never flagged (nothing to be "done picking")', async () => {
    getPickingTasks.mockResolvedValue([]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('an order already packed is never flagged, however long picking took', async () => {
    getPickingTasks.mockResolvedValue([completedTask(500)]);
    getPacking.mockResolvedValue([{ orderId: 'ORD-1', packingTime: now, packageSize: 'M', weight: 1, damaged: false, packedBy: 'PACKER-1' }]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
