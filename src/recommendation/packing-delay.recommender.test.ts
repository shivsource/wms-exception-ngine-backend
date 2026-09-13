import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { PackingDelayRecommender } from './packing-delay.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-packing-delay-1',
    type: ExceptionType.PACKING_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Packing delay for order ORD-1',
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
    exceptionId: 'EXC-packing-delay-1',
    exceptionType: ExceptionType.PACKING_DELAY,
    primaryCause: { type: ExceptionType.PICKING_DELAY, category: 'OBSERVED', score: 75, confidenceLevel: 'HIGH', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('PackingDelayRecommender', () => {
  const recommender = new PackingDelayRecommender();

  it('1. recommends PRIORITIZE for an upstream PICKING_DELAY', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('PRIORITIZE');
  });

  it('2. recommends ESCALATE for PACKING_QUEUE_BACKLOG — a different action for a different root cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'PACKING_QUEUE_BACKLOG', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('ESCALATE');
  });

  it('3. recommends MONITOR for ORDER_COMPLEXITY', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'ORDER_COMPLEXITY', category: 'INFERRED', score: 30, confidenceLevel: 'LOW', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('MONITOR');
  });

  it('4. never recommends RE_PACK/VERIFY for a not-yet-packed order — no packing record exists', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('RE_PACK');
    expect(result.limitations.some((l) => l.includes('no packing record has been created'))).toBe(true);
  });

  it('5. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('6. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
