import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistedException, PickingErrorEvidence } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

// Same offline-fixture strategy as picking-delay.analyzer.test.ts: mock the
// dependencies the analyzer talks to, no real Pool/DB connection touched.
vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));
vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTaskById: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { PickingErrorAnalyzer } from './picking-error.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);
const getPickingTaskById = vi.mocked(logisticsDataSource.getPickingTaskById);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-picking-error-1',
    type: ExceptionType.PICKING_ERROR,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-200',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Picking errors on task TASK-200',
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

/** A CanonicalPickingTask with `count` line items, all error-free — drives HIGH_PICKING_COMPLEXITY's real item count. */
function buildTaskWithItemCount(count: number) {
  return {
    taskId: 'TASK-200',
    orderId: 'ORD-1',
    pickerId: 'PICKER-9',
    locationId: 'A1',
    startTime: null,
    endTime: null,
    errors: 0,
    distanceWalked: null,
    status: 'IN_PROGRESS' as const,
    items: Array.from({ length: count }, (_, i) => ({
      sku: `SKU-${i}`,
      locationId: 'A1',
      requestedQuantity: 1,
      pickedQuantity: 1,
      errorReason: null,
    })),
  };
}

function buildEvidence(overrides: Partial<PickingErrorEvidence> = {}): PickingErrorEvidence {
  return {
    task: { id: 'TASK-200', taskCode: 'TASK-200', pickerId: 'PICKER-9', status: 'IN_PROGRESS', startTime: null, endTime: null },
    order: null,
    errorCount: 1,
    errors: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: 'SHORT_PICK' }],
    ...overrides,
  };
}

describe('PickingErrorAnalyzer', () => {
  const analyzer = new PickingErrorAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
    getPickingTaskById.mockReset();
    getPickingTaskById.mockResolvedValue(null);
  });

  it('1. identifies inventory discrepancy as the cause on an exact sku+location match', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_DISCREPANCY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(50); // exactMatch only
  });

  it('2. identifies location mismatch directly from a WRONG_LOCATION error reason', async () => {
    const evidence = buildEvidence({
      errorCount: 1,
      errors: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: 'WRONG_LOCATION' }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('LOCATION_MISMATCH');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.score).toBe(65); // anyMatch(50) + majorityOfErrors(15) — the one error is 100% of errorCount
  });

  it('3. does not generate SKU_CONFUSION — no field in this schema ever supports it', async () => {
    const evidence = buildEvidence({
      errors: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: 'WRONG_LOCATION' }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('SKU_CONFUSION');
  });

  it('4. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.INVENTORY_SHORTAGE) {
        return [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH })];
      }
      if (type === ExceptionType.PICKING_ERROR) {
        return [
          buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-201', evidence: { pickerId: 'PICKER-9' } }),
          buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-202', evidence: { pickerId: 'PICKER-9' } }),
        ];
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['INVENTORY_SHORTAGE', 'PICKER_PERFORMANCE']));
  });

  it('5. treats a single isolated error as insufficient evidence for picker performance', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR ? [buildException()] : [], // only this task's own exception, no others
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('PICKER_PERFORMANCE');
  });

  it('6. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.contributingCauses).toEqual([]);
    expect(result.limitations.some((l) => l.includes('isolated error'))).toBe(true);
  });

  it('7. never fabricates picker performance below the recurrence threshold', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-201', evidence: { pickerId: 'PICKER-9' } })] // only 1, below mediumRecurringErrors (2)
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('PICKER_PERFORMANCE');
  });

  it('8. HIGH_PICKING_COMPLEXITY is inferred from real task item count, not the errors array', async () => {
    getPickingTaskById.mockResolvedValue(buildTaskWithItemCount(10));

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('HIGH_PICKING_COMPLEXITY');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('9. only includes OBSERVED causes in the causal chain, never INFERRED ones', async () => {
    getPickingTaskById.mockResolvedValue(buildTaskWithItemCount(10));
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_SHORTAGE
        ? [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const chainFroms = result.causalChain.map((link) => link.from);
    expect(chainFroms).toContain('INVENTORY_SHORTAGE');
    expect(chainFroms).not.toContain('HIGH_PICKING_COMPLEXITY');
  });

  it('10. produces deterministic output for identical input', async () => {
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
});
