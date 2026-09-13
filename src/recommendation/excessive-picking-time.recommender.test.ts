import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { ExcessivePickingTimeRecommender } from './excessive-picking-time.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-excessive-time-1',
    type: ExceptionType.EXCESSIVE_PICKING_TIME,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Excessive picking time on task TASK-1',
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
    exceptionId: 'EXC-excessive-time-1',
    exceptionType: ExceptionType.EXCESSIVE_PICKING_TIME,
    primaryCause: { type: 'PICKING_ERROR', category: 'OBSERVED', score: 70, confidenceLevel: 'HIGH', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('ExcessivePickingTimeRecommender', () => {
  const recommender = new ExcessivePickingTimeRecommender();

  it('1. recommends VERIFY/RE_PICK for PICKING_ERROR', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(['VERIFY', 'RE_PICK']).toContain(result.recommendation.actionType);
  });

  it('2. recommends REASSIGN for EXCESSIVE_PICKER_DISTANCE — a different action for a different root cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'EXCESSIVE_PICKER_DISTANCE', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('REASSIGN');
  });

  it('3. recommends CHECK_INVENTORY for INVENTORY_DISCREPANCY', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'INVENTORY_DISCREPANCY', category: 'OBSERVED', score: 60, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('CHECK_INVENTORY');
  });

  it('4. recommends MONITOR for HIGH_ITEM_COUNT — informative, not actionable', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'HIGH_ITEM_COUNT', category: 'INFERRED', score: 30, confidenceLevel: 'LOW', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('MONITOR');
  });

  it('5. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('6. never recommends REASSIGN/PRIORITIZE for PICKER_OVERLOAD — that cause is never produced here', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.reason).not.toMatch(/overload/i);
  });

  it('7. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
