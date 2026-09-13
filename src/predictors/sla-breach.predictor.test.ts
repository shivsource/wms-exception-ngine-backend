import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder, CanonicalPacking, CanonicalPickingTask } from '../canonical/types';
import { RiskLevel } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: {
    getOrders: vi.fn(),
    getOrderById: vi.fn(),
    getPickingTasks: vi.fn(),
    getPacking: vi.fn(),
  },
}));

import { logisticsDataSource } from '../adapters';
import { SlaBreachPredictor } from './sla-breach.predictor';

const getOrders = vi.mocked(logisticsDataSource.getOrders);
const getOrderById = vi.mocked(logisticsDataSource.getOrderById);
const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const getPacking = vi.mocked(logisticsDataSource.getPacking);

function buildOrder(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    orderId: 'ORD-1',
    customerId: 'CUST-1',
    priority: 'NORMAL',
    orderTime: new Date('2026-08-20T06:00:00.000Z'),
    expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
    status: 'PICKING',
    items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 0 }],
    ...overrides,
  };
}

function buildTask(overrides: Partial<CanonicalPickingTask> = {}): CanonicalPickingTask {
  return {
    taskId: 'TASK-1',
    orderId: 'ORD-1',
    pickerId: 'PICKER-1',
    locationId: 'A1',
    startTime: new Date('2026-08-20T08:00:00.000Z'),
    endTime: new Date('2026-08-20T08:20:00.000Z'),
    errors: 0,
    distanceWalked: 50,
    status: 'COMPLETED',
    items: [],
    ...overrides,
  };
}

function buildPacking(overrides: Partial<CanonicalPacking> = {}): CanonicalPacking {
  return {
    orderId: 'ORD-1',
    packingTime: new Date('2026-08-20T08:30:00.000Z'),
    packageSize: 'M',
    weight: 2,
    damaged: false,
    packedBy: 'WORKER-1',
    ...overrides,
  };
}

describe('SlaBreachPredictor', () => {
  const predictor = new SlaBreachPredictor();
  const now = new Date('2026-08-20T09:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getOrders.mockReset();
    getOrderById.mockReset();
    getPickingTasks.mockReset().mockResolvedValue([]);
    getPacking.mockReset().mockResolvedValue([]);
  });

  it('1. reports LOW risk for an order with plenty of SLA time, picking and packing complete', async () => {
    const order = buildOrder({
      expectedDispatchTime: new Date('2026-08-20T12:20:00.000Z'), // 200 minutes away — within the 240-minute prediction window, but not urgent
      items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 5 }],
    });
    getOrders.mockResolvedValue([order]);
    getPickingTasks.mockResolvedValue([buildTask()]);
    getPacking.mockResolvedValue([buildPacking()]);

    const [result] = await predictor.evaluateAll();

    expect(result.riskLevel).toBe(RiskLevel.LOW);
    expect(result.riskScore).toBeLessThan(30);
  });

  it('2. reports HIGH/CRITICAL risk for an urgent order with incomplete picking and no packing', async () => {
    const order = buildOrder({
      priority: 'URGENT',
      expectedDispatchTime: new Date('2026-08-20T09:20:00.000Z'), // 20 minutes away
      items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 1, packedQuantity: 0 }],
    });
    getOrders.mockResolvedValue([order]);
    getPickingTasks.mockResolvedValue([buildTask({ status: 'IN_PROGRESS', endTime: null })]);
    getPacking.mockResolvedValue([]);

    const [result] = await predictor.evaluateAll();

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
    expect(result.riskScore).toBeGreaterThanOrEqual(60);
    expect(result.signals.find((s) => s.signal === 'ORDER_PRIORITY')?.contribution).toBeGreaterThan(0);
  });

  it('3. returns INSUFFICIENT_DATA when the order cannot be found', async () => {
    getOrderById.mockResolvedValue(null);

    const result = await predictor.evaluateOne('ORD-999');

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.riskScore).toBeNull();
    expect(result.riskLevel).toBe(RiskLevel.UNKNOWN);
  });

  it('4. returns INSUFFICIENT_DATA for an order that has already dispatched', async () => {
    getOrderById.mockResolvedValue(buildOrder({ status: 'DISPATCHED' }));

    const result = await predictor.evaluateOne('ORD-1');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('5. reports a zero-minute prediction window once the SLA has already been breached', async () => {
    getOrderById.mockResolvedValue(buildOrder({ expectedDispatchTime: new Date('2026-08-20T08:30:00.000Z') }));
    getPickingTasks.mockResolvedValue([buildTask()]);
    getPacking.mockResolvedValue([buildPacking()]);

    const result = await predictor.evaluateOne('ORD-1');

    expect(result.predictionWindow?.value).toBe(0);
    expect(result.signals.find((s) => s.signal === 'SLA_REMAINING')?.value).toBeLessThan(0);
  });

  it('6. produces deterministic output for identical input', async () => {
    const order = buildOrder();
    getOrderById.mockResolvedValue(order);
    getPickingTasks.mockResolvedValue([buildTask()]);
    getPacking.mockResolvedValue([buildPacking()]);

    const first = await predictor.evaluateOne('ORD-1');
    const second = await predictor.evaluateOne('ORD-1');

    expect({ ...first, evaluatedAt: null }).toEqual({ ...second, evaluatedAt: null });
  });
});
