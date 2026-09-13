import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryDiscrepancyEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { InventoryDiscrepancyAnalyzer } from './inventory-discrepancy.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-inventory-discrepancy-1',
    type: ExceptionType.INVENTORY_DISCREPANCY,
    entityType: EntityType.INVENTORY,
    entityId: 'SKU-1:A1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Inventory discrepancy for SKU-1 at A1',
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
    ...overrides,
  });
}

function buildEvidence(overrides: Partial<InventoryDiscrepancyEvidence> = {}): InventoryDiscrepancyEvidence {
  return {
    product: { sku: 'SKU-1', productName: 'Widget', category: 'Misc' },
    discrepancy: { location: 'A1', quantity: 10, reservedQuantity: 15, damagedQuantity: 0, lastUpdated: new Date('2026-08-01T00:00:00.000Z') },
    locations: [{ location: 'A1', quantity: 10, reservedQuantity: 15, damagedQuantity: 0, lastUpdated: new Date('2026-08-01T00:00:00.000Z') }],
    ...overrides,
  };
}

describe('InventoryDiscrepancyAnalyzer', () => {
  const analyzer = new InventoryDiscrepancyAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. identifies stock record error for an unexplained reservation mismatch with no competing signal', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('STOCK_RECORD_ERROR');
    expect(result.primaryCause?.category).toBe('INFERRED');
    expect(result.limitations.some((l) => l.includes('receiving log'))).toBe(true);
  });

  it('2. identifies misplaced/damaged inventory when damage exceeds quantity', async () => {
    const evidence = buildEvidence({
      discrepancy: { location: 'A1', quantity: 10, reservedQuantity: 5, damagedQuantity: 14, lastUpdated: new Date() },
      locations: [{ location: 'A1', quantity: 10, reservedQuantity: 5, damagedQuantity: 14, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('DAMAGED_INVENTORY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('3. identifies damaged inventory (exceeds quantity) as the cause', async () => {
    const evidence = buildEvidence({
      discrepancy: { location: 'A1', quantity: 10, reservedQuantity: 5, damagedQuantity: 12, lastUpdated: new Date() },
      locations: [{ location: 'A1', quantity: 10, reservedQuantity: 5, damagedQuantity: 12, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('DAMAGED_INVENTORY');
  });

  it('4. does not fabricate UNRECORDED_MOVEMENT — no such candidate is ever generated', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('UNRECORDED_MOVEMENT');
    expect(allTypes).not.toContain('RECEIVING_ERROR');
    expect(allTypes).not.toContain('MISPLACED_INVENTORY');
  });

  it('5. identifies picking error relationship via an exact sku+location match', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [
            buildSibling({
              type: ExceptionType.PICKING_ERROR,
              entityType: EntityType.PICKING_TASK,
              entityId: 'TASK-1',
              evidence: { errors: [{ sku: 'SKU-1', location: 'A1', errorReason: 'SHORT_PICK' }] },
            }),
          ]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('PICKING_ERROR');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('6. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [
            buildSibling({
              type: ExceptionType.PICKING_ERROR,
              entityType: EntityType.PICKING_TASK,
              entityId: 'TASK-1',
              evidence: { errors: [{ sku: 'SKU-1', location: 'A1', errorReason: 'WRONG_LOCATION' }] },
            }),
          ]
        : [],
    );
    // Reservation mismatch present too (no damage), so STOCK_RECORD_ERROR should also contribute.
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['PICKING_ERROR', 'STOCK_RECORD_ERROR']));
  });

  it('7. reports INSUFFICIENT_EVIDENCE when the mismatch is not reservation- or damage-driven', async () => {
    const evidence = buildEvidence({
      discrepancy: { location: 'A1', quantity: 20, reservedQuantity: 20, damagedQuantity: 20, lastUpdated: new Date() },
      locations: [{ location: 'A1', quantity: 20, reservedQuantity: 20, damagedQuantity: 20, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.contributingCauses).toEqual([]);
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('8. produces deterministic output for identical input', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [
            buildSibling({
              type: ExceptionType.PICKING_ERROR,
              entityType: EntityType.PICKING_TASK,
              entityId: 'TASK-1',
              evidence: { errors: [{ sku: 'SKU-1', location: 'A1', errorReason: 'SHORT_PICK' }] },
            }),
          ]
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
