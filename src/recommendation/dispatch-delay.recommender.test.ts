import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { DispatchDelayRecommender } from './dispatch-delay.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-dispatch-delay-1',
    type: ExceptionType.DISPATCH_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Dispatch delay for order ORD-1',
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
    exceptionId: 'EXC-dispatch-delay-1',
    exceptionType: ExceptionType.DISPATCH_DELAY,
    primaryCause: { type: 'LOADING_DELAY', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('DispatchDelayRecommender', () => {
  const recommender = new DispatchDelayRecommender();

  it('1. recommends PRIORITIZE for LOADING_DELAY', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('PRIORITIZE');
  });

  it('2. recommends ESCALATE for DOCK_CONGESTION — a different action for a different root cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'DOCK_CONGESTION', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('ESCALATE');
  });

  it('3. recommends PRIORITIZE for an upstream PACKING_DELAY', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: ExceptionType.PACKING_DELAY, category: 'OBSERVED', score: 75, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('PRIORITIZE');
  });

  it('4. never recommends CONTACT_CARRIER or RESCHEDULE — no carrier-related evidence exists', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('CONTACT_CARRIER');
    expect(types).not.toContain('RESCHEDULE');
    expect(result.limitations.some((l) => l.includes('CONTACT_CARRIER'))).toBe(true);
  });

  it('5. never recommends dock reassignment — no such capability exists in this WMS model', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'DOCK_CONGESTION', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('REASSIGN_DOCK');
  });

  it('6. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('7. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
