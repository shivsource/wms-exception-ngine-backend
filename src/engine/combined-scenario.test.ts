import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectedException, PersistedException } from '../interfaces';
import { ExceptionStatus, ExceptionType } from '../types/enums';

/**
 * Section 23 — COMBINED SCENARIOS: one order carrying three simultaneous, genuinely
 * interacting problems (INVENTORY_SHORTAGE on its SKU, PICKING_DELAY on its picking task,
 * SLA_AT_RISK on the order itself), run through the REAL ExceptionEngine + full rule
 * registry (not a hand-picked subset) against MockLogisticsDataSource, backed by an
 * in-memory exceptionRepository fake so root-cause analyzers' sibling-exception
 * correlation (exceptionRepository.findAllByType) runs against real persisted rows
 * instead of an empty mock. This is the one thing single-exception tests (mock-pipeline
 * .test.ts, src/rules/*.rule.test.ts) cannot exercise: does detecting several exception
 * types off overlapping data produce correct, non-duplicated, correctly-correlated output?
 */
vi.mock('../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});

// Defined entirely inside the factory (vi.mock is hoisted above top-level declarations,
// so nothing outside this callback may be referenced from it).
vi.mock('../repositories', () => {
  class FakeExceptionRepository {
    rows: PersistedException[] = [];
    private nextId = 1;

    async findExistingOpen(type: ExceptionType, entityType: string, entityId: string): Promise<PersistedException | null> {
      return this.rows.find((r) => r.type === type && r.entityType === entityType && r.entityId === entityId && r.status === ExceptionStatus.OPEN) ?? null;
    }

    async create(exception: DetectedException): Promise<PersistedException> {
      const persisted: PersistedException = {
        id: this.nextId,
        exceptionId: `EXC-${this.nextId}`,
        type: exception.type,
        entityType: exception.entityType,
        entityId: exception.entityId,
        severity: exception.severity,
        status: ExceptionStatus.OPEN,
        title: exception.title,
        description: exception.description,
        evidence: exception.evidence,
        detectedAt: exception.detectedAt,
        resolvedAt: null,
        createdAt: exception.detectedAt,
        updatedAt: exception.detectedAt,
      };
      this.nextId += 1;
      this.rows.push(persisted);
      return persisted;
    }

    async findAllByType(type: ExceptionType): Promise<PersistedException[]> {
      return this.rows.filter((r) => r.type === type).sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
    }
  }
  return { exceptionRepository: new FakeExceptionRepository() };
});

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';

const fakeExceptionRepository = exceptionRepository as unknown as { rows: PersistedException[] };
import { MockLogisticsDataSource } from '../adapters/mock';
import { PickingDelayEvidenceCollector } from '../evidence';
import { PickingDelayAnalyzer } from '../root-cause';
import { PickingDelayRecommender, SlaAtRiskRecommender } from '../recommendation';
import { ExceptionEngine } from './exception-engine';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;
const now = new Date('2026-09-13T09:00:00.000Z');

describe('COMBINED SCENARIO: inventory shortage + picking delay + SLA risk on one order, run through the real engine end-to-end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fakeExceptionRepository.rows = [];

    mockDataSource.seed({
      products: [{ sku: 'SKU-COMBO', name: 'Combo Widget', category: null, reorderLevel: 20, active: true }],
      // available (10) < reorderLevel (20): shortfall 10, ratio 0.5 -> HIGH severity.
      inventory: [{ sku: 'SKU-COMBO', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: now }],
      orders: [
        {
          orderId: 'ORD-COMBO', customerId: 'CUST-1', priority: 'HIGH', orderTime: new Date(now.getTime() - 120 * 60_000),
          // 90min from dispatch: inside the 120min SLA_AT_RISK window (urgencyRatio 0.25 -> LOW... wait computed below).
          expectedDispatchTime: new Date(now.getTime() + 90 * 60_000), status: 'PICKING',
          items: [{ sku: 'SKU-COMBO', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }],
        },
      ],
      pickingTasks: [
        {
          // elapsed 90min > 60min stuck threshold -> PICKING_DELAY, severity MEDIUM (90>=60).
          taskId: 'TASK-COMBO', orderId: 'ORD-COMBO', pickerId: 'PICKER-1', locationId: 'A1',
          startTime: new Date(now.getTime() - 90 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS',
          items: [{ sku: 'SKU-COMBO', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: null }],
        },
      ],
      packing: [],
      dispatch: [],
      returns: [],
    });
  });

  it('detects exactly the 3 expected exception types on the first engine run — the other 7 rules stay silent on this data', async () => {
    const summary = await new ExceptionEngine().run();

    expect(summary.totalPersisted).toBe(3);
    expect(summary.totalDuplicates).toBe(0);
    expect(summary.totalErrors).toBe(0);
    const persistedTypes = fakeExceptionRepository.rows.map((r) => r.type).sort();
    expect(persistedTypes).toEqual([ExceptionType.INVENTORY_SHORTAGE, ExceptionType.PICKING_DELAY, ExceptionType.SLA_AT_RISK].sort());
  });

  it('re-running the engine unchanged treats all 3 as duplicates — no cross-type or cross-entity confusion in dedup', async () => {
    await new ExceptionEngine().run();
    const second = await new ExceptionEngine().run();

    expect(second.totalPersisted).toBe(0);
    expect(second.totalDuplicates).toBe(3);
    expect(fakeExceptionRepository.rows).toHaveLength(3); // still exactly 3 rows total, not 6
  });

  it('PICKING_DELAY root-cause analysis correlates the sibling INVENTORY_SHORTAGE exception on the same SKU as its primary cause', async () => {
    await new ExceptionEngine().run();
    const pickingDelayException = fakeExceptionRepository.rows.find((r) => r.type === ExceptionType.PICKING_DELAY)!;
    expect(pickingDelayException).toBeDefined();

    const evidence = await new PickingDelayEvidenceCollector().collect(pickingDelayException);
    expect(evidence).not.toBeNull();

    const rootCause = await new PickingDelayAnalyzer().analyze(pickingDelayException, evidence!);
    expect(rootCause.primaryCause?.type).toBe('INVENTORY_SHORTAGE');
    expect(rootCause.primaryCause?.category).toBe('OBSERVED');
    // The matched shortage is HIGH severity and the SKU is still pending on this task —
    // both weighted facts should show up as supporting evidence, not just a bare match.
    expect(rootCause.supportingEvidence.some((e) => e.field.includes('severity'))).toBe(true);

    const recommendation = await new PickingDelayRecommender().recommend(pickingDelayException, evidence, rootCause);
    expect(recommendation.recommendation.actionType).toBeTruthy();
  });

  it('SLA_AT_RISK gets its own independent, non-conflicting recommendation despite sharing the same order as the other two exceptions', async () => {
    await new ExceptionEngine().run();
    const slaException = fakeExceptionRepository.rows.find((r) => r.type === ExceptionType.SLA_AT_RISK)!;
    expect(slaException).toBeDefined();

    const evidence = await new (await import('../evidence')).SlaAtRiskEvidenceCollector().collect(slaException);
    expect(evidence).not.toBeNull();

    const rootCause = await new (await import('../root-cause')).SlaAtRiskAnalyzer().analyze(slaException, evidence!);
    const recommendation = await new SlaAtRiskRecommender().recommend(slaException, evidence, rootCause);

    expect(recommendation.recommendation.actionType).toBeTruthy();
    // Independent recommendations, not a single merged/conflicting one for the order.
    expect(recommendation.exceptionId).toBe(slaException.exceptionId);
  });
});
