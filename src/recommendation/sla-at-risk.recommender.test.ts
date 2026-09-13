import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis, SlaAtRiskEvidence } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { SlaAtRiskRecommender } from './sla-at-risk.recommender';

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
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildEvidence(overrides: Partial<SlaAtRiskEvidence> = {}): SlaAtRiskEvidence {
  return {
    order: { orderId: 'ORD-1', customerId: 'CUST-1', priority: 'NORMAL', expectedDispatch: new Date(), status: 'PICKING', orderTime: new Date(), minutesRemaining: 120, breached: false },
    items: [],
    ...overrides,
  };
}

function buildRootCause(overrides: Partial<RootCauseAnalysis> = {}): RootCauseAnalysis {
  return {
    exceptionId: 'EXC-sla-at-risk-1',
    exceptionType: ExceptionType.SLA_AT_RISK,
    primaryCause: { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', score: 90, confidenceLevel: 'HIGH', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('SlaAtRiskRecommender', () => {
  const recommender = new SlaAtRiskRecommender();

  it('1. prioritizes SLA protection over the upstream cause when the order has already breached', async () => {
    const evidence = buildEvidence({ order: { ...buildEvidence().order!, breached: true, minutesRemaining: -30 } });
    const result = await recommender.recommend(buildException(), evidence as unknown as Record<string, unknown>, buildRootCause());

    expect(result.recommendation.actionType).toBe('PRIORITIZE');
  });

  it('2. addresses the upstream cause as an alternative even when PRIORITIZE is primary', async () => {
    const evidence = buildEvidence({ order: { ...buildEvidence().order!, breached: true } });
    const result = await recommender.recommend(buildException(), evidence as unknown as Record<string, unknown>, buildRootCause());

    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).toContain('REPLENISH');
  });

  it('3. addresses the upstream cause directly when the order is not yet urgent', async () => {
    const evidence = buildEvidence({ order: { ...buildEvidence().order!, minutesRemaining: 600, breached: false } });
    const result = await recommender.recommend(buildException(), evidence as unknown as Record<string, unknown>, buildRootCause());

    expect(result.recommendation.actionType).toBe('REPLENISH');
  });

  it('4. maps DISPATCH_DELAY root cause to ESCALATE', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: ExceptionType.DISPATCH_DELAY, category: 'OBSERVED', score: 75, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, rootCause);
    expect(result.recommendation.actionType).toBe('ESCALATE');
  });

  it('5. never treats SLA_AT_RISK itself as the addressed root cause', async () => {
    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, buildRootCause());
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(result.recommendation.reason).not.toContain('SLA_AT_RISK, its earliest');
    expect(types.length).toBeGreaterThan(0);
  });

  it('6. falls back to INVESTIGATE/MONITOR when no upstream cause is found and the order is not urgent', async () => {
    const evidence = buildEvidence({ order: { ...buildEvidence().order!, minutesRemaining: 600, breached: false } });
    const result = await recommender.recommend(
      buildException({ severity: ExceptionSeverity.LOW }),
      evidence as unknown as Record<string, unknown>,
      buildRootCause({ primaryCause: null }),
    );
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('7. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const evidence = buildEvidence() as unknown as Record<string, unknown>;
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, evidence, rootCause);
    const second = await recommender.recommend(exception, evidence, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
