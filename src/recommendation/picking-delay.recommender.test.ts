import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistedException, PickingDelayEvidence, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getInventory: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { PickingDelayRecommender } from './picking-delay.recommender';

const getInventory = vi.mocked(logisticsDataSource.getInventory);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-picking-delay-1',
    type: ExceptionType.PICKING_DELAY,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Picking delay on task TASK-1',
    description: null,
    evidence: null,
    detectedAt: new Date('2026-08-20T10:00:00.000Z'),
    resolvedAt: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...overrides,
  };
}

function buildEvidence(overrides: Partial<PickingDelayEvidence> = {}): PickingDelayEvidence {
  return {
    task: { id: 'TASK-1', taskCode: 'TASK-1', pickerId: 'PICKER-1', startTime: new Date(), elapsedMinutes: 90 },
    order: null,
    items: [{ sku: 'SKU-1', productName: 'Widget', location: 'A-17', requestedQuantity: 5, pickedQuantity: 0, pending: 5 }],
    baseline: { avgCompletedMinutes: 30, delayRatio: 3 },
    ...overrides,
  };
}

function buildRootCause(overrides: Partial<RootCauseAnalysis> = {}): RootCauseAnalysis {
  return {
    exceptionId: 'EXC-picking-delay-1',
    exceptionType: ExceptionType.PICKING_DELAY,
    primaryCause: { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', score: 90, confidenceLevel: 'HIGH', explanation: 'Shortage found.' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('PickingDelayRecommender', () => {
  const recommender = new PickingDelayRecommender();

  beforeEach(() => {
    getInventory.mockReset();
    getInventory.mockResolvedValue([]);
  });

  it('1. recommends REPLENISH for INVENTORY_SHORTAGE when no alternate stock is confirmed', async () => {
    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, buildRootCause());

    expect(result.recommendation.actionType).toBe('REPLENISH');
    expect(result.recommendation.reason).toContain('inventory shortage');
  });

  it('2. recommends REASSIGN for INVENTORY_SHORTAGE when alternate stock is confirmed', async () => {
    getInventory.mockResolvedValue([
      { sku: 'SKU-1', locationId: 'B-01', quantity: 50, reservedQuantity: 10, damagedQuantity: 0, availableQuantity: 40, lastUpdated: new Date() },
    ]);

    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, buildRootCause());

    expect(result.recommendation.actionType).toBe('REASSIGN');
  });

  it('3. recommends a different action for a different root cause (PICKING_ERROR)', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'PICKING_ERROR', category: 'OBSERVED', score: 80, confidenceLevel: 'HIGH', explanation: '...' },
    });

    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, rootCause);

    expect(result.recommendation.actionType).toBe('RE_PICK');
  });

  it('4. surfaces alternatives when multiple causes are present', async () => {
    const rootCause = buildRootCause({
      contributingCauses: [{ type: 'EXCESSIVE_PICKER_DISTANCE', category: 'OBSERVED', score: 60, confidenceLevel: 'MEDIUM', explanation: '...' }],
    });

    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, rootCause);

    const actionTypes = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(actionTypes.length).toBeGreaterThan(1);
  });

  it('5. falls back to INVESTIGATE/MONITOR when root cause is INSUFFICIENT_EVIDENCE, never a stronger action', async () => {
    const rootCause = buildRootCause({ primaryCause: null });

    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, rootCause);

    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
    expect(result.recommendation.confidenceLevel).toBe('LOW');
    expect(result.recommendation.approval.level).toBe('NOT_REQUIRED');
  });

  it('6. falls back when rootCause itself is null', async () => {
    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, null);

    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
    expect(result.rootCause).toBeNull();
  });

  it('7. recommendation confidence never exceeds root cause confidence', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', score: 50, confidenceLevel: 'LOW', explanation: '...' },
    });

    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, rootCause);

    expect(result.recommendation.confidenceLevel).toBe('LOW');
  });

  it('8. high exception severity classifies the recommendation with a higher score contribution than low severity', async () => {
    const criticalResult = await recommender.recommend(
      buildException({ severity: ExceptionSeverity.CRITICAL }),
      buildEvidence() as unknown as Record<string, unknown>,
      buildRootCause(),
    );
    const lowResult = await recommender.recommend(
      buildException({ severity: ExceptionSeverity.LOW }),
      buildEvidence() as unknown as Record<string, unknown>,
      buildRootCause(),
    );

    expect(criticalResult.recommendation.score).toBeGreaterThanOrEqual(lowResult.recommendation.score);
  });

  it('9. never recommends an unsupported action type (e.g. CONTACT_CARRIER)', async () => {
    const result = await recommender.recommend(buildException(), buildEvidence() as unknown as Record<string, unknown>, buildRootCause());

    const actionTypes = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(actionTypes).not.toContain('CONTACT_CARRIER');
    expect(actionTypes).not.toContain('RESCHEDULE');
  });

  it('10. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const evidence = buildEvidence() as unknown as Record<string, unknown>;
    const rootCause = buildRootCause();

    const first = await recommender.recommend(exception, evidence, rootCause);
    const second = await recommender.recommend(exception, evidence, rootCause);

    expect(first.analyzedAt).toBeInstanceOf(Date);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
