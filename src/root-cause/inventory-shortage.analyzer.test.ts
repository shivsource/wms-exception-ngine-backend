import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryShortageEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { InventoryShortageAnalyzer } from './inventory-shortage.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-inventory-shortage-1',
    type: ExceptionType.INVENTORY_SHORTAGE,
    entityType: EntityType.PRODUCT,
    entityId: 'SKU-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Inventory shortage for SKU-1',
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

function buildEvidence(overrides: Partial<InventoryShortageEvidence> = {}): InventoryShortageEvidence {
  return {
    product: { sku: 'SKU-1', productName: 'Widget', category: 'Misc', reorderLevel: 50 },
    totals: { totalQuantity: 100, totalReserved: 60, totalAvailable: 40, shortfallUnits: 10, shortfallPercentage: 20 },
    locations: [
      { location: 'A1', quantity: 100, reservedQuantity: 60, damagedQuantity: 0, lastUpdated: new Date('2026-08-01T00:00:00.000Z') },
    ],
    ...overrides,
  };
}

describe('InventoryShortageAnalyzer', () => {
  const analyzer = new InventoryShortageAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. identifies true stock depletion when the shortfall is large with no other explanation', async () => {
    const evidence = buildEvidence({
      totals: { totalQuantity: 20, totalReserved: 5, totalAvailable: 15, shortfallUnits: 35, shortfallPercentage: 70 },
      locations: [{ location: 'A1', quantity: 20, reservedQuantity: 5, damagedQuantity: 0, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('STOCK_DEPLETION');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.limitations.some((l) => l.includes('order-velocity'))).toBe(true);
  });

  it('2. identifies reservation over-allocation when reserved exceeds physical quantity', async () => {
    const evidence = buildEvidence({
      totals: { totalQuantity: 100, totalReserved: 130, totalAvailable: -30, shortfallUnits: 80, shortfallPercentage: 160 },
      locations: [{ location: 'A1', quantity: 100, reservedQuantity: 130, damagedQuantity: 0, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('RESERVATION_OVER_ALLOCATION');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('3. identifies damaged inventory when it accounts for the shortfall', async () => {
    const evidence = buildEvidence({
      totals: { totalQuantity: 100, totalReserved: 50, totalAvailable: 50, shortfallUnits: 20, shortfallPercentage: 40 },
      locations: [{ location: 'A1', quantity: 100, reservedQuantity: 50, damagedQuantity: 25, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('DAMAGED_INVENTORY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('4. identifies inventory record error via a correlated INVENTORY_DISCREPANCY exception', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
        : [],
    );
    const evidence = buildEvidence({
      totals: { totalQuantity: 100, totalReserved: 60, totalAvailable: 40, shortfallUnits: 10, shortfallPercentage: 20 },
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('INVENTORY_DISCREPANCY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('5. does not fabricate HIGH_DEMAND — no such candidate is ever generated', async () => {
    const evidence = buildEvidence({
      totals: { totalQuantity: 20, totalReserved: 5, totalAvailable: 15, shortfallUnits: 35, shortfallPercentage: 70 },
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('HIGH_DEMAND');
    expect(allTypes).not.toContain('INVENTORY_RECORD_ERROR');
  });

  it('6. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
        : [],
    );
    const evidence = buildEvidence({
      totals: { totalQuantity: 100, totalReserved: 130, totalAvailable: -30, shortfallUnits: 80, shortfallPercentage: 160 },
      locations: [{ location: 'A1', quantity: 100, reservedQuantity: 130, damagedQuantity: 0, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['RESERVATION_OVER_ALLOCATION', 'INVENTORY_DISCREPANCY']));
  });

  it('7. reports INSUFFICIENT_EVIDENCE when the shortfall is too small to diagnose', async () => {
    const evidence = buildEvidence({
      totals: { totalQuantity: 100, totalReserved: 85, totalAvailable: 15, shortfallUnits: 5, shortfallPercentage: 10 },
      locations: [{ location: 'A1', quantity: 100, reservedQuantity: 85, damagedQuantity: 0, lastUpdated: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.contributingCauses).toEqual([]);
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('8. produces deterministic output for identical input', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
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
