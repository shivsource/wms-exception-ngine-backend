import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { ExcessivePickerDistanceRecommender } from './excessive-picker-distance.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-excessive-distance-1',
    type: ExceptionType.EXCESSIVE_PICKER_DISTANCE,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Excessive picker distance on task TASK-1',
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
    exceptionId: 'EXC-excessive-distance-1',
    exceptionType: ExceptionType.EXCESSIVE_PICKER_DISTANCE,
    primaryCause: { type: 'MULTI_LOCATION_ORDER', category: 'INFERRED', score: 45, confidenceLevel: 'LOW', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('ExcessivePickerDistanceRecommender', () => {
  const recommender = new ExcessivePickerDistanceRecommender();

  it('1. recommends REASSIGN for MULTI_LOCATION_ORDER', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('REASSIGN');
  });

  it('2. recommends REASSIGN + ESCALATE alternative for POOR_LOCATION_ASSIGNMENT — a recurring pattern', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'POOR_LOCATION_ASSIGNMENT', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).toContain('ESCALATE');
  });

  it('3. never claims warehouse layout as a cause from a single task', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.limitations.some((l) => l.includes('warehouse-layout'))).toBe(true);
  });

  it('4. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('5. never recommends INVENTORY_MISPLACEMENT-driven actions — not a produced root cause', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.reason).not.toMatch(/misplacement/i);
  });

  it('6. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
