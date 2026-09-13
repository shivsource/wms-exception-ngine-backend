import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalDispatch, CanonicalOrder, CanonicalPacking, CanonicalPickingTask } from '../canonical/types';
import { RiskLevel } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: {
    getOrders: vi.fn(),
    getOrderById: vi.fn(),
    getPickingTasks: vi.fn(),
    getPacking: vi.fn(),
    getDispatch: vi.fn(),
  },
}));

import { logisticsDataSource } from '../adapters';
import { DispatchDelayPredictor } from './dispatch-delay.predictor';

const getOrders = vi.mocked(logisticsDataSource.getOrders);
const getOrderById = vi.mocked(logisticsDataSource.getOrderById);
const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const getPacking = vi.mocked(logisticsDataSource.getPacking);
const getDispatch = vi.mocked(logisticsDataSource.getDispatch);

function buildOrder(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    orderId: 'ORD-1',
    customerId: 'CUST-1',
    priority: 'NORMAL',
    orderTime: new Date('2026-08-20T06:00:00.000Z'),
    expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
    status: 'READY_TO_DISPATCH',
    items: [],
    ...overrides,
  };
}

function buildTask(overrides: Partial<CanonicalPickingTask> = {}): CanonicalPickingTask {
  return {
    taskId: 'TASK-1',
    orderId: 'ORD-1',
    pickerId: 'PICKER-1',
    locationId: 'A1',
    startTime: new Date('2026-08-20T07:00:00.000Z'),
    endTime: new Date('2026-08-20T07:20:00.000Z'),
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
    packingTime: new Date('2026-08-20T08:00:00.000Z'),
    packageSize: 'M',
    weight: 2,
    damaged: false,
    packedBy: 'WORKER-1',
    ...overrides,
  };
}

function buildDispatch(overrides: Partial<CanonicalDispatch> = {}): CanonicalDispatch {
  return { orderId: 'ORD-1', truckId: 'TRK-1', carrier: 'Carrier', dock: 'D1', loadingTime: null, departureTime: null, ...overrides };
}

describe('DispatchDelayPredictor', () => {
  const predictor = new DispatchDelayPredictor();
  const now = new Date('2026-08-20T09:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getOrders.mockReset();
    getOrderById.mockReset();
    getPickingTasks.mockReset().mockResolvedValue([buildTask()]);
    getPacking.mockReset().mockResolvedValue([]);
    getDispatch.mockReset().mockResolvedValue([]);
  });

  it('1. reports LOW risk for an order with plenty of SLA time and no packing yet', async () => {
    getOrders.mockResolvedValue([buildOrder({ expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z') })]); // 180 min away, within the 240m window
    getPacking.mockResolvedValue([]);

    const [result] = await predictor.evaluateAll();

    expect(result.riskLevel).toBe(RiskLevel.LOW);
  });

  it('2. reports HIGH/CRITICAL risk when packed and near the dispatch-delay threshold with SLA closing in', async () => {
    getOrders.mockResolvedValue([buildOrder({ expectedDispatchTime: new Date('2026-08-20T09:10:00.000Z') })]); // 10 min SLA remaining
    getPacking.mockResolvedValue([buildPacking({ packingTime: new Date('2026-08-20T08:05:00.000Z') })]); // packed 55 min ago, threshold is 60

    const [result] = await predictor.evaluateAll();

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
    const packingSignal = result.signals.find((s) => s.signal === 'PACKING_ELAPSED');
    expect(packingSignal?.value).toBe(55);
    expect(packingSignal?.contribution).toBeGreaterThan(0);
  });

  it('3. does not score PACKING_ELAPSED for an order that has already departed', async () => {
    getOrderById.mockResolvedValue(buildOrder());
    getPacking.mockResolvedValue([buildPacking()]);
    getDispatch.mockResolvedValue([buildDispatch({ departureTime: new Date('2026-08-20T08:30:00.000Z') })]);

    const result = await predictor.evaluateOne('ORD-1');

    const packingSignal = result.signals.find((s) => s.signal === 'PACKING_ELAPSED');
    expect(packingSignal?.contribution).toBe(0);
  });

  it('4. returns INSUFFICIENT_DATA when the order cannot be found', async () => {
    getOrderById.mockResolvedValue(null);

    const result = await predictor.evaluateOne('ORD-999');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('5. returns INSUFFICIENT_DATA for an already-dispatched order', async () => {
    getOrderById.mockResolvedValue(buildOrder({ status: 'DISPATCHED' }));

    const result = await predictor.evaluateOne('ORD-1');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('6. never scores truck/carrier/dock fields — limitations document why', async () => {
    getOrderById.mockResolvedValue(buildOrder());
    getPacking.mockResolvedValue([]);
    getDispatch.mockResolvedValue([]);

    const result = await predictor.evaluateOne('ORD-1');

    expect(result.signals.every((s) => !['truckId', 'carrier', 'dock', 'TRUCK', 'CARRIER', 'DOCK'].includes(String(s.signal)))).toBe(true);
    expect(result.limitations.some((l) => l.toLowerCase().includes('truck') || l.toLowerCase().includes('carrier'))).toBe(true);
  });
});
