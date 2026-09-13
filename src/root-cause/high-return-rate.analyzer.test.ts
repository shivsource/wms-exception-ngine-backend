import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HighReturnRateEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { HighReturnRateAnalyzer } from './high-return-rate.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1037,
    exceptionId: 'EXC-451ad8b5-0625-4ee6-92a6-a9f399441e4b',
    type: ExceptionType.HIGH_RETURN_RATE,
    entityType: EntityType.PRODUCT,
    entityId: 'SKU-1185',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'High return rate for SKU-1185',
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
  return buildException({ id: 2, exceptionId: `EXC-${overrides.type.toLowerCase()}-1`, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', ...overrides });
}

function buildEvidence(overrides: Partial<HighReturnRateEvidence> = {}): HighReturnRateEvidence {
  return {
    product: { sku: 'SKU-1185', productName: 'Running Shoes 185', category: 'Electronics' },
    totalReturned: 1,
    totalOrdered: 14,
    returnRatePercentage: 7.14,
    windowDays: 30,
    recentReturns: [{ returnId: '31', reason: 'WRONG_SIZE', condition: 'NEW', returnedAt: new Date('2026-07-29T03:25:00.000Z') }],
    ...overrides,
  };
}

describe('HighReturnRateAnalyzer', () => {
  const analyzer = new HighReturnRateAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. identifies WRONG_SIZE as the observed cause for a single return, with MEDIUM confidence and a sample-size limitation', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('WRONG_SIZE');
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.primaryCause?.confidenceLevel).toBe('MEDIUM');
    expect(result.limitations.some((l) => l.includes('Only 1 return citing WRONG_SIZE'))).toBe(true);
  });

  it('1b. never claims a systemic sizing problem from a single return', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.explanation).not.toMatch(/systemic|always|guaranteed/i);
  });

  it('2. identifies WRONG_ITEM as the cause when that is the recorded reason', async () => {
    const evidence = buildEvidence({
      recentReturns: [{ returnId: '1', reason: 'WRONG_ITEM', condition: 'NEW', returnedAt: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('WRONG_ITEM');
  });

  it('3. identifies PRODUCT_DAMAGED as the cause when that is the recorded reason', async () => {
    const evidence = buildEvidence({
      recentReturns: [{ returnId: '1', reason: 'PRODUCT_DAMAGED', condition: 'DAMAGED', returnedAt: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('PRODUCT_DAMAGED');
  });

  it('4. does not fabricate PACKING_DAMAGE — no field links a return to a specific packing record', async () => {
    const evidence = buildEvidence({
      recentReturns: [{ returnId: '1', reason: 'PRODUCT_DAMAGED', condition: 'DAMAGED', returnedAt: new Date() }],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('PACKING_DAMAGE');
  });

  it('5. identifies PICKING_ERROR via a correlated sibling exception referencing this SKU', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_ERROR
        ? [buildSibling({ type: ExceptionType.PICKING_ERROR, evidence: { errors: [{ sku: 'SKU-1185' }] } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toContain(ExceptionType.PICKING_ERROR);
  });

  it('6. surfaces multiple return reasons as separate candidates', async () => {
    const evidence = buildEvidence({
      recentReturns: [
        { returnId: '1', reason: 'WRONG_SIZE', condition: 'NEW', returnedAt: new Date() },
        { returnId: '2', reason: 'DEFECTIVE', condition: 'DEFECTIVE', returnedAt: new Date() },
      ],
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining(['WRONG_SIZE', 'DEFECTIVE']));
  });

  it('7. gives a single low-sample return LOW/MEDIUM confidence, never HIGH', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.confidenceLevel).not.toBe('HIGH');
  });

  it('8. reaches higher confidence with high volume and a repeated reason', async () => {
    const evidence = buildEvidence({
      totalReturned: 20,
      recentReturns: Array.from({ length: 8 }, (_, i) => ({
        returnId: `${i}`,
        reason: 'WRONG_SIZE',
        condition: 'NEW',
        returnedAt: new Date(),
      })),
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('WRONG_SIZE');
    expect(result.primaryCause?.confidenceLevel).toBe('HIGH');
  });

  it('9. reports INSUFFICIENT_EVIDENCE when there are no individual return records', async () => {
    const evidence = buildEvidence({ recentReturns: [] });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.limitations.some((l) => l.includes('only the aggregate rate'))).toBe(true);
  });

  it('10. does not make an unsupported product-level claim in the explanation text', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.explanation).not.toMatch(/product has a (systemic|known) sizing/i);
  });
});
