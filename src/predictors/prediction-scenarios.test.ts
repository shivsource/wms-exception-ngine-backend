import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demonstrates the 7 controlled scenarios for the Prediction/Risk Scoring Engine, run
 * against MockLogisticsDataSource only — mirrors canonical/mock-pipeline.test.ts's role for
 * the detection engine: proof the predictors depend only on the canonical model, never on
 * the WMS database. See ARCHITECTURE.md and PredictionEngine.
 */
vi.mock('../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});
vi.mock('../repositories', () => ({
  exceptionRepository: { findExistingOpen: vi.fn().mockResolvedValue(null) },
  predictionRepository: {
    findActiveOrConfirmed: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (evaluation, status, confirmedExceptionId) => ({
      id: 1,
      predictionId: 'PRED-scenario',
      ...evaluation,
      status,
      confirmedExceptionId,
    })),
    update: vi.fn(),
    resolve: vi.fn(),
    findActiveOrConfirmedByType: vi.fn().mockResolvedValue([]),
  },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { MockLogisticsDataSource, MockLogisticsDataSourceSeed } from '../adapters/mock';
import { PersistedException } from '../interfaces';
import { DispatchDelayPredictor, InventoryShortagePredictor, PickingDelayPredictor, SlaBreachPredictor } from '.';
import { PredictionEngine } from '../engine/prediction-engine';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType, RiskLevel } from '../types/enums';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;
const findExistingOpen = vi.mocked(exceptionRepository.findExistingOpen);

function seed(overrides: MockLogisticsDataSourceSeed): void {
  mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [], ...overrides });
}

const now = () => new Date();
const minutesAgo = (m: number) => new Date(now().getTime() - m * 60_000);
const minutesFromNow = (m: number) => new Date(now().getTime() + m * 60_000);

describe('Prediction scenarios (Step 22)', () => {
  beforeEach(() => {
    seed({});
    findExistingOpen.mockReset().mockResolvedValue(null);
  });

  it('SCENARIO 1 — LOW RISK: plenty of SLA time, picking/packing progressing normally, inventory available', async () => {
    seed({
      orders: [{
        orderId: 'ORD-LOW', customerId: 'CUST-1', priority: 'NORMAL', orderTime: minutesAgo(60),
        expectedDispatchTime: minutesFromNow(200), status: 'PACKING',
        items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 5 }],
      }],
      pickingTasks: [{ taskId: 'TASK-LOW', orderId: 'ORD-LOW', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(50), endTime: minutesAgo(40), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] }],
      packing: [{ orderId: 'ORD-LOW', packingTime: minutesAgo(10), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' }],
    });

    const result = await new SlaBreachPredictor().evaluateOne('ORD-LOW');

    expect(result.riskLevel).toBe(RiskLevel.LOW);
    expect(result.riskScore).not.toBeNull();
  });

  it('SCENARIO 2 — HIGH PICKING DELAY RISK: limited SLA, picking already slower than baseline, task incomplete', async () => {
    const baselineTask = (id: string, i: number) => ({
      taskId: id, orderId: `ORD-BASE-${i}`, pickerId: 'PICKER-2', locationId: 'A1',
      startTime: minutesAgo(400 + i), endTime: minutesAgo(380 + i), errors: 0, distanceWalked: 50, status: 'COMPLETED' as const, items: [],
    });
    seed({
      orders: [{ orderId: 'ORD-PICK', customerId: 'CUST-1', priority: 'HIGH', orderTime: minutesAgo(90), expectedDispatchTime: minutesFromNow(10), status: 'PICKING', items: [] }],
      pickingTasks: [
        { taskId: 'TASK-PICK', orderId: 'ORD-PICK', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(50), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
        ...[0, 1, 2, 3, 4].map((i) => baselineTask(`BASE-${i}`, i)),
      ],
    });

    const result = await new PickingDelayPredictor().evaluateOne('TASK-PICK');

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
    expect(result.signals.some((s) => s.signal === 'PICKING_DURATION')).toBe(true);
  });

  it('SCENARIO 3 — INVENTORY SHORTAGE RISK: order requires more than is effectively available', async () => {
    seed({
      products: [{ sku: 'SKU-SHORT', name: 'Widget', category: null, reorderLevel: 5, active: true }],
      inventory: [{ sku: 'SKU-SHORT', locationId: 'A1', quantity: 12, reservedQuantity: 12, damagedQuantity: 0, availableQuantity: 0, lastUpdated: now() }],
      orders: [{ orderId: 'ORD-SHORT', customerId: 'CUST-1', priority: 'NORMAL', orderTime: minutesAgo(30), expectedDispatchTime: minutesFromNow(120), status: 'ALLOCATED', items: [{ sku: 'SKU-SHORT', orderedQuantity: 10, pickedQuantity: 0, packedQuantity: 0 }] }],
    });

    const result = await new InventoryShortagePredictor().evaluateOne('SKU-SHORT');

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
  });

  it('SCENARIO 4 — SLA AT RISK: approaching expected dispatch while upstream work is incomplete', async () => {
    seed({
      orders: [{ orderId: 'ORD-SLA', customerId: 'CUST-1', priority: 'URGENT', orderTime: minutesAgo(100), expectedDispatchTime: minutesFromNow(15), status: 'PICKING', items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 1, packedQuantity: 0 }] }],
      pickingTasks: [{ taskId: 'TASK-SLA', orderId: 'ORD-SLA', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(30), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] }],
    });

    const result = await new SlaBreachPredictor().evaluateOne('ORD-SLA');

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
  });

  it('SCENARIO 5 — DISPATCH RISK: packed and approaching the dispatch-delay threshold with SLA closing in', async () => {
    seed({
      orders: [{ orderId: 'ORD-DISPATCH', customerId: 'CUST-1', priority: 'NORMAL', orderTime: minutesAgo(180), expectedDispatchTime: minutesFromNow(5), status: 'READY_TO_DISPATCH', items: [] }],
      pickingTasks: [{ taskId: 'TASK-DISPATCH', orderId: 'ORD-DISPATCH', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(120), endTime: minutesAgo(100), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] }],
      packing: [{ orderId: 'ORD-DISPATCH', packingTime: minutesAgo(55), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' }],
    });

    const result = await new DispatchDelayPredictor().evaluateOne('ORD-DISPATCH');

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
  });

  it('SCENARIO 6 — INSUFFICIENT DATA: required signals are missing, never a fabricated score', async () => {
    const result = await new SlaBreachPredictor().evaluateOne('ORD-DOES-NOT-EXIST');

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.riskScore).toBeNull();
    expect(result.riskLevel).toBe(RiskLevel.UNKNOWN);
  });

  it('SCENARIO 7 — ALREADY CONFIRMED EXCEPTION: the engine marks the prediction CONFIRMED, not ACTIVE, and never creates a second exception', async () => {
    seed({
      orders: [{ orderId: 'ORD-CONFIRMED', customerId: 'CUST-1', priority: 'URGENT', orderTime: minutesAgo(100), expectedDispatchTime: minutesFromNow(15), status: 'PICKING', items: [] }],
    });
    const openException: PersistedException = {
      id: 42,
      exceptionId: 'EXC-already-open',
      type: ExceptionType.SLA_AT_RISK,
      entityType: EntityType.ORDER,
      entityId: 'ORD-CONFIRMED',
      severity: ExceptionSeverity.HIGH,
      status: ExceptionStatus.OPEN,
      title: 'Order ORD-CONFIRMED is at risk of missing its SLA',
      description: null,
      evidence: null,
      detectedAt: now(),
      resolvedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    findExistingOpen.mockResolvedValue(openException);

    const evaluation = await new SlaBreachPredictor().evaluateOne('ORD-CONFIRMED');
    const outcome = await new PredictionEngine().persist(evaluation);

    expect(outcome.status).toBe('CONFIRMED');
    expect(outcome.confirmedExceptionId).toBe('EXC-already-open');
  });
});
