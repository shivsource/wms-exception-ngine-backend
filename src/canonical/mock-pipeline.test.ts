import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MOST IMPORTANT ARCHITECTURAL TEST.
 *
 * Every rule, evidence collector, root-cause analyzer, and recommender below runs
 * against MockLogisticsDataSource — an implementation of LogisticsDataSource that has
 * never heard of MySQL, the WMS schema, or any repository. If these tests pass, the
 * intelligence layer is proven to depend only on the canonical model + the
 * LogisticsDataSource interface, not on the WMS database. See ARCHITECTURE.md.
 *
 * exceptionRepository is mocked too — it's the engine's own exceptions store (used by
 * root-cause analyzers to correlate sibling exceptions), not a WMS source, but mocking
 * it here keeps this suite fully offline with zero database dependency of any kind.
 */
vi.mock('../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});
vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn().mockResolvedValue([]) },
}));

import { logisticsDataSource } from '../adapters';
import { MockLogisticsDataSource, MockLogisticsDataSourceSeed } from '../adapters/mock';
import {
  InventoryDiscrepancyEvidenceCollector,
  InventoryShortageEvidenceCollector,
} from '../evidence';
import { PersistedException } from '../interfaces';
import {
  DispatchDelayRule,
  ExcessivePickerDistanceRule,
  ExcessivePickingTimeRule,
  HighReturnRateRule,
  InventoryDiscrepancyRule,
  InventoryShortageRule,
  PackingDelayRule,
  PickingDelayRule,
  PickingErrorRule,
  SlaAtRiskRule,
} from '../rules';
import {
  HighReturnRateAnalyzer,
  InventoryShortageAnalyzer,
  PickingDelayAnalyzer,
} from '../root-cause';
import {
  HighReturnRateRecommender,
  InventoryShortageRecommender,
  PickingDelayRecommender,
} from '../recommendation';
import { ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;

/** Always sets every seed key (defaulting to []), so no state leaks between tests. */
function seed(overrides: MockLogisticsDataSourceSeed): void {
  mockDataSource.seed({
    orders: [],
    products: [],
    inventory: [],
    pickingTasks: [],
    packing: [],
    dispatch: [],
    returns: [],
    ...overrides,
  });
}

/** Turns a rule's DetectedException into the PersistedException shape evidence/root-cause/recommendation consume. */
function toPersisted(detected: Awaited<ReturnType<InventoryShortageRule['evaluate']>>[number]): PersistedException {
  return {
    id: 1,
    exceptionId: `EXC-mock-${detected.entityId}`,
    type: detected.type,
    entityType: detected.entityType,
    entityId: detected.entityId,
    severity: detected.severity,
    status: ExceptionStatus.OPEN,
    title: detected.title,
    description: detected.description,
    evidence: detected.evidence,
    detectedAt: detected.detectedAt,
    resolvedAt: null,
    createdAt: detected.detectedAt,
    updatedAt: detected.detectedAt,
  };
}

const now = () => new Date();
const minutesAgo = (m: number) => new Date(now().getTime() - m * 60_000);
const minutesFromNow = (m: number) => new Date(now().getTime() + m * 60_000);
const daysAgo = (d: number) => new Date(now().getTime() - d * 24 * 60 * 60 * 1000);

describe('Detection engine runs against MockLogisticsDataSource for every exception type (TEST 4)', () => {
  beforeEach(() => seed({}));

  it('INVENTORY_SHORTAGE', async () => {
    seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: 20, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: now() }],
    });

    const detected = await new InventoryShortageRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.INVENTORY_SHORTAGE);
    expect(detected[0].severity).toBe(ExceptionSeverity.HIGH);
  });

  it('INVENTORY_DISCREPANCY', async () => {
    seed({
      inventory: [{ sku: 'SKU-2', locationId: 'B1', quantity: 5, reservedQuantity: 8, damagedQuantity: 0, availableQuantity: -3, lastUpdated: now() }],
    });

    const detected = await new InventoryDiscrepancyRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.INVENTORY_DISCREPANCY);
    expect(detected[0].severity).toBe(ExceptionSeverity.CRITICAL);
  });

  it('PICKING_DELAY', async () => {
    seed({
      pickingTasks: [{
        taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
        startTime: minutesAgo(90), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [],
      }],
    });

    const detected = await new PickingDelayRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.PICKING_DELAY);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('PICKING_ERROR', async () => {
    seed({
      pickingTasks: [{
        taskId: 'TASK-2', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
        startTime: minutesAgo(30), endTime: minutesAgo(5), errors: 1, distanceWalked: 100, status: 'COMPLETED',
        items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 3, errorReason: 'SHORT_PICK' }],
      }],
    });

    const detected = await new PickingErrorRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.PICKING_ERROR);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('EXCESSIVE_PICKING_TIME', async () => {
    const completed = (id: string, minutes: number) => ({
      taskId: id, orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
      startTime: minutesAgo(minutes), endTime: now(), errors: 0, distanceWalked: 100, status: 'COMPLETED' as const, items: [],
    });
    seed({ pickingTasks: [completed('T-A', 30), completed('T-B', 30), completed('T-C', 90)] });

    const detected = await new ExcessivePickingTimeRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-C');
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('EXCESSIVE_PICKER_DISTANCE', async () => {
    const completed = (id: string, distance: number) => ({
      taskId: id, orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
      startTime: minutesAgo(30), endTime: now(), errors: 0, distanceWalked: distance, status: 'COMPLETED' as const, items: [],
    });
    seed({ pickingTasks: [completed('T-A', 100), completed('T-B', 100), completed('T-C', 250)] });

    const detected = await new ExcessivePickerDistanceRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-C');
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('SLA_AT_RISK', async () => {
    seed({
      orders: [{
        orderId: 'ORD-3', customerId: 'CUST-1', priority: 'HIGH', orderTime: minutesAgo(120),
        expectedDispatchTime: minutesFromNow(30), status: 'PICKING', items: [],
      }],
    });

    const detected = await new SlaAtRiskRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.SLA_AT_RISK);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('PACKING_DELAY', async () => {
    seed({
      orders: [{ orderId: 'ORD-4', customerId: 'CUST-1', priority: null, orderTime: minutesAgo(180), expectedDispatchTime: minutesFromNow(60), status: 'PICKING', items: [] }],
      pickingTasks: [{
        taskId: 'TASK-4', orderId: 'ORD-4', pickerId: 'PICKER-1', locationId: 'A1',
        startTime: minutesAgo(120), endTime: minutesAgo(90), errors: 0, distanceWalked: 100, status: 'COMPLETED', items: [],
      }],
    });

    const detected = await new PackingDelayRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.PACKING_DELAY);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('DISPATCH_DELAY', async () => {
    seed({
      packing: [{ orderId: 'ORD-5', packingTime: minutesAgo(90), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' }],
    });

    const detected = await new DispatchDelayRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.DISPATCH_DELAY);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('HIGH_RETURN_RATE — the SKU-1185 example from the architecture brief (1 return / 14 orders = 7.14%)', async () => {
    seed({
      orders: Array.from({ length: 14 }, (_, i) => ({
        orderId: `ORD-${i}`, customerId: 'CUST-1', priority: null, orderTime: daysAgo(5),
        expectedDispatchTime: daysAgo(4), status: 'DISPATCHED' as const,
        items: [{ sku: 'SKU-1185', orderedQuantity: 1, pickedQuantity: 1, packedQuantity: 1 }],
      })),
      returns: [{ returnId: 'RET-1', orderId: 'ORD-0', sku: 'SKU-1185', reason: 'WRONG_SIZE', condition: 'GOOD', returnedAt: daysAgo(2) }],
    });

    const detected = await new HighReturnRateRule().evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe(ExceptionType.HIGH_RETURN_RATE);
    expect(detected[0].evidence.returnRatePercentage).toBeCloseTo(7.14, 1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });
});

describe('Full detection -> evidence -> root cause -> recommendation chain against MockLogisticsDataSource only (TEST 5, 6, 12)', () => {
  beforeEach(() => seed({}));

  it('INVENTORY_SHORTAGE: the full pipeline runs end-to-end without ever touching a WMS database', async () => {
    seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: 20, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: now() }],
    });

    const detected = await new InventoryShortageRule().evaluate();
    const persisted = toPersisted(detected[0]);

    const evidence = await new InventoryShortageEvidenceCollector().collect(persisted);
    expect(evidence).not.toBeNull();

    const rootCause = await new InventoryShortageAnalyzer().analyze(persisted, evidence!);
    expect(rootCause.exceptionId).toBe(persisted.exceptionId);
    expect(rootCause.analysisExplanation).toBeTruthy();

    const recommendation = await new InventoryShortageRecommender().recommend(persisted, evidence, rootCause);
    expect(recommendation.recommendation.actionType).toBeTruthy();
  });

  it('PICKING_DELAY: evidence enrichment and root-cause picker-overload correlation both resolve purely through canonical lookups', async () => {
    seed({
      orders: [{ orderId: 'ORD-1', customerId: 'CUST-1', priority: 'NORMAL', orderTime: minutesAgo(150), expectedDispatchTime: minutesFromNow(30), status: 'PICKING', items: [] }],
      pickingTasks: [
        {
          taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
          startTime: minutesAgo(90), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS',
          items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: null }],
        },
        // A second concurrent task for the same picker — should surface as a PICKER_OVERLOAD signal.
        {
          taskId: 'TASK-2', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A2',
          startTime: minutesAgo(10), endTime: null, errors: 0, distanceWalked: null, status: 'ASSIGNED', items: [],
        },
        {
          taskId: 'TASK-3', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A3',
          startTime: minutesAgo(10), endTime: null, errors: 0, distanceWalked: null, status: 'ASSIGNED', items: [],
        },
      ],
    });

    const detected = await new PickingDelayRule().evaluate();
    const persisted = toPersisted(detected[0]);

    const evidenceCollector = new (await import('../evidence')).PickingDelayEvidenceCollector();
    const evidence = await evidenceCollector.collect(persisted);
    expect(evidence).not.toBeNull();
    expect((evidence as { order: { orderId: string } | null }).order?.orderId).toBe('ORD-1');

    const rootCause = await new PickingDelayAnalyzer().analyze(persisted, evidence!);
    const causeTypes = [rootCause.primaryCause?.type, ...rootCause.contributingCauses.map((c) => c.type)];
    expect(causeTypes).toContain('PICKER_OVERLOAD');

    const recommendation = await new PickingDelayRecommender().recommend(persisted, evidence, rootCause);
    expect(recommendation.recommendation.actionType).toBeTruthy();
  });

  it('HIGH_RETURN_RATE: the SKU-1185 scenario carried through evidence, root cause, and a recommendation', async () => {
    seed({
      orders: Array.from({ length: 14 }, (_, i) => ({
        orderId: `ORD-${i}`, customerId: 'CUST-1', priority: null, orderTime: daysAgo(5),
        expectedDispatchTime: daysAgo(4), status: 'DISPATCHED' as const,
        items: [{ sku: 'SKU-1185', orderedQuantity: 1, pickedQuantity: 1, packedQuantity: 1 }],
      })),
      returns: [{ returnId: 'RET-1', orderId: 'ORD-0', sku: 'SKU-1185', reason: 'WRONG_SIZE', condition: 'GOOD', returnedAt: daysAgo(2) }],
      products: [{ sku: 'SKU-1185', name: 'Item 1185', category: null, reorderLevel: null, active: true }],
    });

    const detected = await new HighReturnRateRule().evaluate();
    const persisted = toPersisted(detected[0]);

    const evidence = await new (await import('../evidence')).HighReturnRateEvidenceCollector().collect(persisted);
    expect(evidence).not.toBeNull();

    const rootCause = await new HighReturnRateAnalyzer().analyze(persisted, evidence!);
    expect(rootCause.exceptionId).toBe(persisted.exceptionId);

    const recommendation = await new HighReturnRateRecommender().recommend(persisted, evidence, rootCause);
    expect(recommendation.recommendation.actionType).toBeTruthy();
  });
});

describe('Evidence collector proves an INVENTORY_DISCREPANCY correlation is source-agnostic too', () => {
  it('collects structured evidence for a discrepancy from mock data alone', async () => {
    seed({
      inventory: [{ sku: 'SKU-9', locationId: 'C1', quantity: 5, reservedQuantity: 9, damagedQuantity: 0, availableQuantity: -4, lastUpdated: now() }],
      products: [{ sku: 'SKU-9', name: 'Gadget', category: null, reorderLevel: null, active: true }],
    });

    const detected = await new InventoryDiscrepancyRule().evaluate();
    const persisted = toPersisted(detected[0]);

    const evidence = await new InventoryDiscrepancyEvidenceCollector().collect(persisted);
    expect(evidence).not.toBeNull();
    expect((evidence as { discrepancy: { location: string } }).discrepancy.location).toBe('C1');
  });
});
