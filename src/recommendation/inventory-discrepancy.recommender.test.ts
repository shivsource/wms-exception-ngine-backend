import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { InventoryDiscrepancyRecommender } from './inventory-discrepancy.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-inventory-discrepancy-1',
    type: ExceptionType.INVENTORY_DISCREPANCY,
    entityType: EntityType.INVENTORY,
    entityId: 'SKU-1:A1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Inventory discrepancy for SKU-1 at A1',
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
    exceptionId: 'EXC-inventory-discrepancy-1',
    exceptionType: ExceptionType.INVENTORY_DISCREPANCY,
    primaryCause: { type: 'STOCK_RECORD_ERROR', category: 'INFERRED', score: 40, confidenceLevel: 'MEDIUM', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('InventoryDiscrepancyRecommender', () => {
  const recommender = new InventoryDiscrepancyRecommender();

  it('1. recommends INVESTIGATE for STOCK_RECORD_ERROR', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('INVESTIGATE');
  });

  it('2. recommends VERIFY for DAMAGED_INVENTORY — a different action for a different root cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'DAMAGED_INVENTORY', category: 'OBSERVED', score: 70, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('VERIFY');
  });

  it('3. offers RE_PICK for PICKING_ERROR, but prefers the lower-risk VERIFY first', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'PICKING_ERROR', category: 'OBSERVED', score: 65, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).toEqual(expect.arrayContaining(['VERIFY', 'RE_PICK']));
    expect(result.recommendation.actionType).toBe('VERIFY');
  });

  it('4. never recommends REMOVE_FROM_AVAILABLE_STOCK — no such action exists in the taxonomy', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'DAMAGED_INVENTORY', category: 'OBSERVED', score: 70, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('REMOVE_FROM_AVAILABLE_STOCK');
  });

  it('5. never recommends UNRECORDED_MOVEMENT/receiving-related actions — not a produced root cause', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.reason).not.toMatch(/receiving|unrecorded movement/i);
  });

  it('6. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('7. surfaces alternatives when multiple causes are present', async () => {
    const rootCause = buildRootCause({
      contributingCauses: [{ type: 'PICKING_ERROR', category: 'OBSERVED', score: 30, confidenceLevel: 'LOW', explanation: '...' }],
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.alternativeRecommendations.length).toBeGreaterThanOrEqual(1);
  });

  it('8. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
