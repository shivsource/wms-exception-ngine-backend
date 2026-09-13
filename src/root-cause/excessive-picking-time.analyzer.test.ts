import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExcessivePickingTimeEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { ExcessivePickingTimeAnalyzer } from './excessive-picking-time.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-excessive-time-1',
    type: ExceptionType.EXCESSIVE_PICKING_TIME,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-400',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Excessive picking time on task TASK-400',
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
  return buildException({ id: 2, exceptionId: `EXC-${overrides.type.toLowerCase()}-1`, ...overrides });
}

function buildEvidence(overrides: Partial<ExcessivePickingTimeEvidence> = {}): ExcessivePickingTimeEvidence {
  return {
    task: { id: 'TASK-400', taskCode: 'TASK-400', pickerId: 'PICKER-9', pickingMinutes: 90, warehouseAverageMinutes: 30, ratio: 3 },
    order: null,
    items: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 1, pickedQuantity: 1, pending: 0 }],
    ...overrides,
  };
}

describe('ExcessivePickingTimeAnalyzer', () => {
  const analyzer = new ExcessivePickingTimeAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. identifies excessive picker distance as a cause when correlated on the same completed task', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.EXCESSIVE_PICKER_DISTANCE
        ? [buildSibling({ type: ExceptionType.EXCESSIVE_PICKER_DISTANCE, entityId: 'TASK-400', evidence: { ratio: 3.5 } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('EXCESSIVE_PICKER_DISTANCE');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('2. identifies picking errors as a cause when correlated on the same task', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-400', evidence: { errorCount: 4 } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('PICKING_ERROR');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('3. identifies high item count when this task has an unusually high item count', async () => {
    const evidence = buildEvidence({
      items: Array.from({ length: 10 }, (_, i) => ({
        sku: `SKU-${i}`,
        productName: 'X',
        location: 'A1',
        requestedQuantity: 1,
        pickedQuantity: 1,
        pending: 0,
      })),
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('HIGH_ITEM_COUNT');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('4. identifies inventory discrepancy via an exact sku+location match', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_DISCREPANCY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('5. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.PICKING_ERROR) {
        return [buildSibling({ type: ExceptionType.PICKING_ERROR, entityId: 'TASK-400', evidence: { errorCount: 1 } })];
      }
      if (type === ExceptionType.EXCESSIVE_PICKER_DISTANCE) {
        return [buildSibling({ type: ExceptionType.EXCESSIVE_PICKER_DISTANCE, entityId: 'TASK-400', evidence: { ratio: 3.5 } })];
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['PICKING_ERROR', 'EXCESSIVE_PICKER_DISTANCE']));
  });

  it('6. does not treat a single normal-sized task as anomalous', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
  });

  it('7. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.contributingCauses).toEqual([]);
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});
