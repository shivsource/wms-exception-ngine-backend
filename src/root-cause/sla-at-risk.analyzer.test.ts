import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder } from '../canonical/types';
import { PersistedException, SlaAtRiskEvidence } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));
vi.mock('../adapters', () => ({
  logisticsDataSource: { getOrderById: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { SlaAtRiskAnalyzer } from './sla-at-risk.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);
const getOrderById = vi.mocked(logisticsDataSource.getOrderById);

const CANONICAL_ORDER: CanonicalOrder = {
  orderId: 'ORD-1',
  customerId: 'CUST-1',
  priority: 'NORMAL',
  orderTime: new Date('2026-08-20T08:00:00.000Z'),
  expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
  status: 'PICKING',
  items: [],
};

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-sla-at-risk-1',
    type: ExceptionType.SLA_AT_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Order ORD-1 is at risk of missing its SLA',
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

function buildEvidence(overrides: Partial<SlaAtRiskEvidence> = {}): SlaAtRiskEvidence {
  return {
    order: {
      orderId: 'ORD-1',
      customerId: 'CUST-1',
      priority: 'NORMAL',
      expectedDispatch: new Date('2026-08-20T12:00:00.000Z'),
      status: 'PICKING',
      orderTime: new Date('2026-08-20T08:00:00.000Z'),
      minutesRemaining: 30,
      breached: false,
    },
    items: [{ sku: 'SKU-1', productName: 'Widget', orderedQuantity: 5, pickedQuantity: 2, packedQuantity: 0 }],
    ...overrides,
  };
}

describe('SlaAtRiskAnalyzer', () => {
  const analyzer = new SlaAtRiskAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
    getOrderById.mockReset();
    getOrderById.mockResolvedValue(CANONICAL_ORDER);
  });

  it('1. identifies PICKING_DELAY as the cause when only a picking delay is correlated', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.PICKING_DELAY);
  });

  it('2. identifies PACKING_DELAY as the cause when correlated by order code', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PACKING_DELAY
        ? [buildSibling({ type: ExceptionType.PACKING_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.PACKING_DELAY);
  });

  it('3. identifies DISPATCH_DELAY as the cause when correlated by order code', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.DISPATCH_DELAY
        ? [buildSibling({ type: ExceptionType.DISPATCH_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.DISPATCH_DELAY);
  });

  it('4. identifies INVENTORY_SHORTAGE as the cause when correlated by SKU', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_SHORTAGE
        ? [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.INVENTORY_SHORTAGE);
  });

  it('5. identifies INVENTORY_DISCREPANCY as the cause when correlated by SKU', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.INVENTORY_DISCREPANCY
        ? [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.INVENTORY_DISCREPANCY);
  });

  it('6. builds a multi-stage causal chain across every correlated cause, ending at SLA_AT_RISK', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.INVENTORY_DISCREPANCY) {
        return [buildSibling({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-1:A1' })];
      }
      if (type === ExceptionType.PICKING_ERROR) {
        return [buildSibling({ type: ExceptionType.PICKING_ERROR, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' } })];
      }
      if (type === ExceptionType.PICKING_DELAY) {
        return [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' } })];
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.causalChain).toEqual([
      { from: ExceptionType.INVENTORY_DISCREPANCY, to: ExceptionType.PICKING_ERROR, relationship: expect.any(String) },
      { from: ExceptionType.PICKING_ERROR, to: ExceptionType.PICKING_DELAY, relationship: expect.any(String) },
      { from: ExceptionType.PICKING_DELAY, to: ExceptionType.SLA_AT_RISK, relationship: expect.any(String) },
    ]);
  });

  it('7. correctly identifies the upstream root cause even when a downstream cause has a higher raw score', async () => {
    findAllByType.mockImplementation(async (type) => {
      if (type === ExceptionType.INVENTORY_SHORTAGE) {
        // Weak signal: single match, LOW severity — lowest possible score (50).
        return [buildSibling({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.LOW })];
      }
      if (type === ExceptionType.PICKING_DELAY) {
        // Strong signal: two matches, CRITICAL severity — highest possible score (90).
        return [
          buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' }, severity: ExceptionSeverity.CRITICAL }),
          buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-2', evidence: { orderId: 'ORD-1' }, severity: ExceptionSeverity.CRITICAL }),
        ];
      }
      return [];
    });

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.INVENTORY_SHORTAGE);
    expect(result.contributingCauses[0]?.type).toBe(ExceptionType.PICKING_DELAY);
    expect(result.contributingCauses[0]!.score).toBeGreaterThan(result.primaryCause!.score);
  });

  it('8. never identifies SLA_AT_RISK as its own root cause', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain(ExceptionType.SLA_AT_RISK);
  });

  it('9. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.causalChain).toEqual([]);
  });

  it('10. produces deterministic output for identical input', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-1' } })]
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
