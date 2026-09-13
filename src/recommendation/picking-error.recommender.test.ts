import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { PickingErrorRecommender } from './picking-error.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-picking-error-1',
    type: ExceptionType.PICKING_ERROR,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Picking errors on task TASK-1',
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
    exceptionId: 'EXC-picking-error-1',
    exceptionType: ExceptionType.PICKING_ERROR,
    primaryCause: { type: 'LOCATION_MISMATCH', category: 'OBSERVED', score: 65, confidenceLevel: 'MEDIUM', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('PickingErrorRecommender', () => {
  const recommender = new PickingErrorRecommender();

  it('1. recommends CHECK_LOCATION for LOCATION_MISMATCH', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('CHECK_LOCATION');
  });

  it('2. recommends VERIFY for INVENTORY_DISCREPANCY — a different action for a different root cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'INVENTORY_DISCREPANCY', category: 'OBSERVED', score: 75, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('VERIFY');
  });

  it('3. recommends ESCALATE for a recurring PICKER_PERFORMANCE pattern', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'PICKER_PERFORMANCE', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('ESCALATE');
  });

  it('4. never escalates or penalizes from a single isolated error (no PICKER_PERFORMANCE cause)', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'LOCATION_MISMATCH', category: 'OBSERVED', score: 50, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('ESCALATE');
  });

  it('5. falls back to MONITOR/INVESTIGATE for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
    expect(result.recommendation.confidenceLevel).toBe('LOW');
  });

  it('6. surfaces multiple contributing-cause alternatives', async () => {
    const rootCause = buildRootCause({
      contributingCauses: [{ type: 'HIGH_PICKING_COMPLEXITY', category: 'INFERRED', score: 30, confidenceLevel: 'LOW', explanation: '...' }],
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.alternativeRecommendations.length).toBeGreaterThanOrEqual(1);
  });

  it('7. never recommends an unsupported action (e.g. ADJUST for a picking error)', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('ADJUST');
  });

  it('8. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
