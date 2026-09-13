import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { InventoryShortageRecommender } from './inventory-shortage.recommender';

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
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRootCause(overrides: Partial<RootCauseAnalysis> = {}): RootCauseAnalysis {
  return {
    exceptionId: 'EXC-inventory-shortage-1',
    exceptionType: ExceptionType.INVENTORY_SHORTAGE,
    primaryCause: { type: 'STOCK_DEPLETION', category: 'OBSERVED', score: 55, confidenceLevel: 'MEDIUM', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('InventoryShortageRecommender', () => {
  const recommender = new InventoryShortageRecommender();

  it('1. recommends REPLENISH for STOCK_DEPLETION', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('REPLENISH');
  });

  it('2. offers ADJUST for RESERVATION_OVER_ALLOCATION, but prefers the lower-risk INVESTIGATE first', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'RESERVATION_OVER_ALLOCATION', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    // Both a different action for a different root cause, and the safety-first ordering:
    // investigate before committing to a HIGH-risk, REQUIRED-approval data adjustment.
    expect(types).toEqual(expect.arrayContaining(['INVESTIGATE', 'ADJUST']));
    expect(result.recommendation.actionType).toBe('INVESTIGATE');
    expect(result.recommendation.approval.level).toBe('NOT_REQUIRED');
  });

  it('3. recommends CHECK_INVENTORY for DAMAGED_INVENTORY', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'DAMAGED_INVENTORY', category: 'OBSERVED', score: 65, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('CHECK_INVENTORY');
  });

  it('4. ADJUST is offered as a HIGH-risk, REQUIRED-approval alternative', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'RESERVATION_OVER_ALLOCATION', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const adjust = [result.recommendation, ...result.alternativeRecommendations].find((a) => a.actionType === 'ADJUST');
    expect(adjust?.risk.level).toBe('HIGH');
    expect(adjust?.approval.level).toBe('REQUIRED');
  });

  it('5. never automatically adjusts inventory without a REQUIRED approval flag', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'RESERVATION_OVER_ALLOCATION', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const adjustActions = [result.recommendation, ...result.alternativeRecommendations].filter((a) => a.actionType === 'ADJUST');
    expect(adjustActions.every((a) => a.approval.level === 'REQUIRED')).toBe(true);
  });

  it('6. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('7. never recommends HIGH_DEMAND-driven actions — that cause is never produced by root cause', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.reason).not.toMatch(/high demand/i);
  });

  it('8. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
