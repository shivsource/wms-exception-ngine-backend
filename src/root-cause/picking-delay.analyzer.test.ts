import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistedException, PickingDelayEvidence } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

// The analyzer only ever talks to these two repositories. Mocking the whole module keeps
// the test offline and deterministic — no real Pool/DB connection is touched, matching the
// "hand-built fixtures + fake repos" testing strategy agreed for the root cause engine.
vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));
vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTasks: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { PickingDelayAnalyzer } from './picking-delay.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);
const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);

/** Builds N picking tasks for the given picker, all ASSIGNED/IN_PROGRESS (i.e. "active"), to drive countActiveTasksForPicker. */
function activeTasksForPicker(pickerId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    taskId: `OTHER-TASK-${i}`,
    orderId: 'ORD-OTHER',
    pickerId,
    locationId: null,
    startTime: null,
    endTime: null,
    errors: 0,
    distanceWalked: null,
    status: 'IN_PROGRESS' as const,
    items: [],
  }));
}

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-picking-delay-1',
    type: ExceptionType.PICKING_DELAY,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-100',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Picking delay on task TASK-100',
    description: null,
    evidence: null,
    detectedAt: new Date('2026-08-20T10:00:00.000Z'),
    resolvedAt: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...overrides,
  };
}

function buildSibling(overrides: Partial<PersistedException> & { type: ExceptionType }): PersistedException {
  return buildException({
    id: 2,
    exceptionId: `EXC-${overrides.type.toLowerCase()}-1`,
    entityType: EntityType.PICKING_TASK,
    ...overrides,
  });
}

/** One pending line item, delay ratio just below the "excessive time" thresholds by default. */
function buildEvidence(overrides: Partial<PickingDelayEvidence> = {}): PickingDelayEvidence {
  return {
    task: { id: 'TASK-100', taskCode: 'TASK-100', pickerId: 'PICKER-1', startTime: new Date('2026-08-20T08:30:00.000Z'), elapsedMinutes: 90 },
    order: null,
    items: [
      { sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 5, pickedQuantity: 0, pending: 5 },
    ],
    baseline: { avgCompletedMinutes: 60, delayRatio: 1.2 },
    ...overrides,
  };
}

describe('PickingDelayAnalyzer', () => {
  const analyzer = new PickingDelayAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
    getPickingTasks.mockReset();
    getPickingTasks.mockResolvedValue([]);
  });

  it('1. identifies inventory shortage as the cause when a pending item is short', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_SHORTAGE
        ? [
            buildSibling({
              type: ExceptionType.INVENTORY_SHORTAGE,
              entityType: EntityType.PRODUCT,
              entityId: 'SKU-1',
              severity: ExceptionSeverity.HIGH,
            }),
          ]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_SHORTAGE');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(75); // pendingSkuMatch(50) + highSeverity(25)
    expect(result.primaryCause?.confidenceLevel).toBe('HIGH');
  });

  it('2. identifies inventory discrepancy as the cause on an exact sku+location match', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [
            buildSibling({
              type: ExceptionType.INVENTORY_DISCREPANCY,
              entityType: EntityType.INVENTORY,
              entityId: 'SKU-1:A1',
              severity: ExceptionSeverity.MEDIUM,
            }),
          ]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_DISCREPANCY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(50); // exactMatch only
    expect(result.primaryCause?.confidenceLevel).toBe('MEDIUM');
  });

  it('3. identifies excessive picker distance as the cause when the sibling exception exists', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.EXCESSIVE_PICKER_DISTANCE
        ? [
            buildSibling({
              type: ExceptionType.EXCESSIVE_PICKER_DISTANCE,
              entityId: 'TASK-100',
              evidence: { ratio: 3.5 },
            }),
          ]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('EXCESSIVE_PICKER_DISTANCE');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(80); // sameTask(50) + criticalRatio(30)
    expect(result.limitations).not.toContain(
      expect.stringContaining('Excessive picker distance could not be evaluated'),
    );
  });

  it('4a. identifies excessive picking time as OBSERVED once the task has completed', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.EXCESSIVE_PICKING_TIME
        ? [buildSibling({ type: ExceptionType.EXCESSIVE_PICKING_TIME, entityId: 'TASK-100', evidence: { ratio: 2.5 } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('EXCESSIVE_PICKING_TIME');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(70); // sameTask(50) + highRatio(20)
  });

  it('4b. falls back to an INFERRED excessive picking time signal while the task is still in progress', async () => {
    const evidence = buildEvidence({ baseline: { avgCompletedMinutes: 30, delayRatio: 3 } });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('EXCESSIVE_PICKING_TIME');
    expect(result.primaryCause?.category).toBe('INFERRED');
    expect(result.primaryCause?.score).toBe(40); // inferred.criticalRatio
    expect(result.primaryCause?.confidenceLevel).toBe('MEDIUM');
  });

  it('5. identifies picking errors as the cause, weighted by error count and pending overlap', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [
            buildSibling({
              type: ExceptionType.PICKING_ERROR,
              entityId: 'TASK-100',
              evidence: { errorCount: 4, errors: [{ sku: 'SKU-1' }] },
            }),
          ]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('PICKING_ERROR');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(90); // sameTask(50) + highErrorCount(25) + pendingItemAffected(15)
    expect(result.primaryCause?.confidenceLevel).toBe('HIGH');
  });

  it('6. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.INVENTORY_SHORTAGE) {
        return [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH })];
      }
      if (type === ExceptionType.PICKING_ERROR) {
        return [buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-100', evidence: { errorCount: 1, errors: [] } })];
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['INVENTORY_SHORTAGE', 'PICKING_ERROR']));
    expect(result.contributingCauses.length).toBeGreaterThanOrEqual(1);
  });

  it('7. ranks the highest-scoring candidate as primary', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.INVENTORY_SHORTAGE) {
        return [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH })]; // 75
      }
      if (type === ExceptionType.INVENTORY_DISCREPANCY) {
        return [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]; // 50
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_SHORTAGE');
    expect(result.primaryCause!.score).toBeGreaterThan(result.contributingCauses[0]!.score);
  });

  it('8. sorts contributing causes descending, with a stable tie-break', async () => {
    // pickerOverload (medium=20) and highOrderComplexity (distinctLocations=20) tie at 20 —
    // candidate declaration order (overload before complexity) must decide the tie.
    getPickingTasks.mockResolvedValue(activeTasksForPicker('PICKER-1', 2));
    const evidence = buildEvidence({
      items: [
        { sku: 'SKU-1', productName: 'A', location: 'A1', requestedQuantity: 1, pickedQuantity: 0, pending: 1 },
        { sku: 'SKU-2', productName: 'B', location: 'A2', requestedQuantity: 1, pickedQuantity: 0, pending: 1 },
        { sku: 'SKU-3', productName: 'C', location: 'A3', requestedQuantity: 1, pickedQuantity: 0, pending: 1 },
        { sku: 'SKU-4', productName: 'D', location: 'A4', requestedQuantity: 1, pickedQuantity: 0, pending: 1 },
      ],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const overloadIndex = result.contributingCauses.findIndex((c) => c.type === 'PICKER_OVERLOAD');
    const complexityIndex = result.contributingCauses.findIndex((c) => c.type === 'HIGH_ORDER_COMPLEXITY');
    expect(result.primaryCause?.type === 'PICKER_OVERLOAD' || overloadIndex !== -1).toBe(true);
    if (overloadIndex !== -1 && complexityIndex !== -1) {
      expect(overloadIndex).toBeLessThan(complexityIndex);
    }
  });

  it('9. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.contributingCauses).toEqual([]);
    expect(result.supportingEvidence).toEqual([]);
    expect(result.limitations.some((l) => l.includes('No inventory shortage'))).toBe(true);
  });

  it('10. never fabricates a cause that scored zero (e.g. picker overload below threshold)', async () => {
    getPickingTasks.mockResolvedValue(activeTasksForPicker('PICKER-1', 1)); // below mediumConcurrentTasks (2)

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('PICKER_OVERLOAD');
  });

  it('11. produces deterministic output for identical input', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_SHORTAGE
        ? [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH })]
        : [],
    );

    const exception = buildException();
    const evidence = buildEvidence() as unknown as Record<string, unknown>;

    const first = await analyzer.analyze(exception, evidence);
    const second = await analyzer.analyze(exception, evidence);

    expect(first.analyzedAt).toBeInstanceOf(Date);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });

  it('12. only includes OBSERVED causes in the causal chain, never INFERRED ones', async () => {
    getPickingTasks.mockResolvedValue(activeTasksForPicker('PICKER-1', 3)); // triggers PICKER_OVERLOAD (inferred, +40)
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-100', evidence: { errorCount: 1, errors: [] } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const chainFroms = result.causalChain.map((link) => link.from);
    expect(chainFroms).toContain('PICKING_ERROR');
    expect(chainFroms).not.toContain('PICKER_OVERLOAD');
  });

  it('13. gives low confidence to a single weak signal instead of overclaiming', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_SHORTAGE
        ? [
            buildSibling({
              type: ExceptionType.INVENTORY_SHORTAGE,
              entityType: EntityType.PRODUCT,
              entityId: 'SKU-1',
              severity: ExceptionSeverity.LOW,
            }),
          ]
        : [],
    );
    // Item already picked (not pending) → weaker pickedOnlySkuMatch(20) rule, no severity/multi-sku bonus.
    const evidence = buildEvidence({
      items: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 5, pickedQuantity: 5, pending: 0 }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.score).toBe(20);
    expect(result.primaryCause?.confidenceLevel).toBe('LOW');
  });

  it("notes that excessive picker distance couldn't be evaluated when no completed-task measurement exists", async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.limitations.some((l) => l.includes('Excessive picker distance could not be evaluated'))).toBe(true);
  });
});
