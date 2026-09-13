import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder, CanonicalPickingTask } from '../canonical/types';
import { RiskLevel } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: {
    getPickingTasks: vi.fn(),
    getPickingTaskById: vi.fn(),
    getOrders: vi.fn(),
    getOrderById: vi.fn(),
  },
}));

import { logisticsDataSource } from '../adapters';
import { PickingDelayPredictor } from './picking-delay.predictor';

const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const getPickingTaskById = vi.mocked(logisticsDataSource.getPickingTaskById);
const getOrders = vi.mocked(logisticsDataSource.getOrders);
const getOrderById = vi.mocked(logisticsDataSource.getOrderById);

function buildTask(overrides: Partial<CanonicalPickingTask> = {}): CanonicalPickingTask {
  return {
    taskId: 'TASK-1',
    orderId: 'ORD-1',
    pickerId: 'PICKER-1',
    locationId: 'A1',
    startTime: new Date('2026-08-20T08:00:00.000Z'),
    endTime: null,
    errors: 0,
    distanceWalked: 50,
    status: 'IN_PROGRESS',
    items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 2, pickedQuantity: 1, errorReason: null }],
    ...overrides,
  };
}

function buildOrder(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    orderId: 'ORD-1',
    customerId: 'CUST-1',
    priority: 'NORMAL',
    orderTime: new Date('2026-08-20T06:00:00.000Z'),
    expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
    status: 'PICKING',
    items: [],
    ...overrides,
  };
}

function completedTask(startMinutesAgo: number, durationMinutes: number, id: string): CanonicalPickingTask {
  const start = new Date(new Date('2026-08-20T09:00:00.000Z').getTime() - startMinutesAgo * 60_000);
  return buildTask({
    taskId: id,
    status: 'COMPLETED',
    startTime: start,
    endTime: new Date(start.getTime() + durationMinutes * 60_000),
  });
}

describe('PickingDelayPredictor', () => {
  const predictor = new PickingDelayPredictor();
  const now = new Date('2026-08-20T09:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getPickingTasks.mockReset();
    getPickingTaskById.mockReset();
    getOrders.mockReset().mockResolvedValue([]);
    getOrderById.mockReset().mockResolvedValue(null);
  });

  function seedBaseline(durationMinutes: number, count: number): CanonicalPickingTask[] {
    return Array.from({ length: count }, (_, i) => completedTask(500 + i, durationMinutes, `BASE-${i}`));
  }

  it('1. reports LOW risk for a task picking well within the historical baseline', async () => {
    const baseline = seedBaseline(20, 6); // avg 20m baseline
    getPickingTasks.mockImplementation(async (filter) => {
      if (filter?.status?.includes('IN_PROGRESS')) return [buildTask({ startTime: new Date('2026-08-20T08:55:00.000Z') })]; // 5 min elapsed
      if (filter?.status?.includes('COMPLETED')) return baseline;
      return [];
    });
    getOrders.mockResolvedValue([buildOrder({ expectedDispatchTime: new Date('2026-08-20T13:00:00.000Z') })]);

    const [result] = await predictor.evaluateAll();

    expect(result.riskLevel).toBe(RiskLevel.LOW);
  });

  it('2. reports HIGH/CRITICAL risk for a task already running well past the historical baseline with limited SLA', async () => {
    const baseline = seedBaseline(20, 6); // avg 20m baseline
    getPickingTasks.mockImplementation(async (filter) => {
      if (filter?.status?.includes('IN_PROGRESS')) return [buildTask({ startTime: new Date('2026-08-20T08:10:00.000Z') })]; // 50 min elapsed vs 20m baseline
      if (filter?.status?.includes('COMPLETED')) return baseline;
      return [];
    });
    getOrders.mockResolvedValue([buildOrder({ expectedDispatchTime: new Date('2026-08-20T09:10:00.000Z') })]); // 10 min SLA remaining

    const [result] = await predictor.evaluateAll();

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
    const durationSignal = result.signals.find((s) => s.signal === 'PICKING_DURATION');
    expect(durationSignal?.expected).toBe(20);
    expect(durationSignal?.contribution).toBeGreaterThan(0);
  });

  it('3. omits the PICKING_DURATION signal and reports INSUFFICIENT_BASELINE_DATA when fewer than the minimum completed samples exist', async () => {
    getPickingTaskById.mockResolvedValue(buildTask());
    getPickingTasks.mockResolvedValue(seedBaseline(20, 2)); // below minBaselineSamples (5)
    getOrderById.mockResolvedValue(buildOrder());

    const result = await predictor.evaluateOne('TASK-1');

    expect(result.status).not.toBe('INSUFFICIENT_DATA');
    expect(result.signals.find((s) => s.signal === 'PICKING_DURATION')).toBeUndefined();
    expect(result.limitations.some((l) => l.includes('INSUFFICIENT_BASELINE_DATA'))).toBe(true);
  });

  it('4. returns INSUFFICIENT_DATA when the task cannot be found', async () => {
    getPickingTaskById.mockResolvedValue(null);

    const result = await predictor.evaluateOne('TASK-999');

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.riskScore).toBeNull();
  });

  it('5. returns INSUFFICIENT_DATA for a task that is not currently IN_PROGRESS', async () => {
    getPickingTaskById.mockResolvedValue(buildTask({ status: 'COMPLETED' }));

    const result = await predictor.evaluateOne('TASK-1');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('6. reports LOW confidence when neither a baseline nor the order can be resolved', async () => {
    getPickingTaskById.mockResolvedValue(buildTask());
    getPickingTasks.mockResolvedValue([]); // no completed tasks -> no baseline
    getOrderById.mockResolvedValue(null); // order not found

    const result = await predictor.evaluateOne('TASK-1');

    expect(result.confidence).toBe('LOW');
  });
});
