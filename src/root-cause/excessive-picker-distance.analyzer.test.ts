import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExcessivePickerDistanceEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { ExcessivePickerDistanceAnalyzer } from './excessive-picker-distance.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-excessive-distance-1',
    type: ExceptionType.EXCESSIVE_PICKER_DISTANCE,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-300',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Excessive picker distance on task TASK-300',
    description: null,
    evidence: null,
    detectedAt: new Date('2026-08-20T10:00:00.000Z'),
    resolvedAt: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...overrides,
  };
}

function buildEvidence(overrides: Partial<ExcessivePickerDistanceEvidence> = {}): ExcessivePickerDistanceEvidence {
  return {
    task: { id: 'TASK-300', taskCode: 'TASK-300', pickerId: 'PICKER-9', distanceWalked: 500, warehouseAverageDistance: 200, ratio: 2.5 },
    order: null,
    items: [{ sku: 'SKU-1', productName: 'Widget', location: 'A1', requestedQuantity: 1, pickedQuantity: 1, pending: 0 }],
    ...overrides,
  };
}

describe('ExcessivePickerDistanceAnalyzer', () => {
  const analyzer = new ExcessivePickerDistanceAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. identifies multi-location order when items are spread across many distinct locations', async () => {
    const evidence = buildEvidence({
      items: [
        { sku: 'SKU-1', productName: 'A', location: 'A1', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
        { sku: 'SKU-2', productName: 'B', location: 'A2', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
        { sku: 'SKU-3', productName: 'C', location: 'A3', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
        { sku: 'SKU-4', productName: 'D', location: 'A4', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
      ],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('MULTI_LOCATION_ORDER');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('2. treats order complexity as inferred (correlational), never observed', async () => {
    const evidence = buildEvidence({
      items: Array.from({ length: 8 }, (_, i) => ({
        sku: `SKU-${i}`,
        productName: 'X',
        location: `LOC-${i}`,
        requestedQuantity: 1,
        pickedQuantity: 1,
        pending: 0,
      })),
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('3. identifies poor location assignment from a recurring picker pattern', async () => {
    findAllByType.mockResolvedValue([
      buildException({ id: 2, exceptionId: 'EXC-x-1', entityId: 'TASK-301', evidence: { pickerId: 'PICKER-9' } }),
      buildException({ id: 3, exceptionId: 'EXC-x-2', entityId: 'TASK-302', evidence: { pickerId: 'PICKER-9' } }),
      buildException({ id: 4, exceptionId: 'EXC-x-3', entityId: 'TASK-303', evidence: { pickerId: 'PICKER-9' } }),
      buildException({ id: 5, exceptionId: 'EXC-x-4', entityId: 'TASK-304', evidence: { pickerId: 'PICKER-9' } }),
    ]);

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('POOR_LOCATION_ASSIGNMENT');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('4. does not blame layout/misplacement from a single anomalous task', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('WAREHOUSE_LAYOUT');
    expect(allTypes).not.toContain('INVENTORY_MISPLACEMENT');
  });

  it('5. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    // Two items at the SAME location keeps the spread ratio low (not a single-item task,
    // which would trivially be "100% spread") while still having no complexity signal.
    const evidence = buildEvidence({
      items: [
        { sku: 'SKU-1', productName: 'A', location: 'A1', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
        { sku: 'SKU-2', productName: 'B', location: 'A1', requestedQuantity: 1, pickedQuantity: 1, pending: 0 },
      ],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.causalChain).toEqual([]);
  });

  it('6. never populates the causal chain — both candidates here are always inferred', async () => {
    findAllByType.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) =>
        buildException({ id: i + 2, exceptionId: `EXC-x-${i}`, entityId: `TASK-30${i}`, evidence: { pickerId: 'PICKER-9' } }),
      ),
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).not.toBeNull();
    expect(result.causalChain).toEqual([]);
  });
});
