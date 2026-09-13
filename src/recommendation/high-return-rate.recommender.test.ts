import { describe, expect, it } from 'vitest';
import { PersistedException, RootCauseAnalysis } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { HighReturnRateRecommender } from './high-return-rate.recommender';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1037,
    exceptionId: 'EXC-451ad8b5-0625-4ee6-92a6-a9f399441e4b',
    type: ExceptionType.HIGH_RETURN_RATE,
    entityType: EntityType.PRODUCT,
    entityId: 'SKU-1185',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'High return rate for SKU-1185',
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
    exceptionId: 'EXC-451ad8b5-0625-4ee6-92a6-a9f399441e4b',
    exceptionType: ExceptionType.HIGH_RETURN_RATE,
    primaryCause: { type: 'WRONG_SIZE', category: 'OBSERVED', score: 50, confidenceLevel: 'MEDIUM', explanation: '...' },
    contributingCauses: [],
    supportingEvidence: [],
    causalChain: [],
    limitations: [],
    analysisExplanation: '...',
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('HighReturnRateRecommender', () => {
  const recommender = new HighReturnRateRecommender();

  it('1. recommends INVESTIGATE for WRONG_SIZE at MEDIUM confidence', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    expect(result.recommendation.actionType).toBe('INVESTIGATE');
  });

  it('2. recommends MONITOR (never a product-data change) for WRONG_SIZE at LOW confidence (single return)', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'WRONG_SIZE', category: 'OBSERVED', score: 20, confidenceLevel: 'LOW', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('MONITOR');
  });

  it('3. never recommends a product-metadata edit action — no such field exists in this schema', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause());
    const types = [result.recommendation.actionType, ...result.alternativeRecommendations.map((a) => a.actionType)];
    expect(types).not.toContain('VERIFY_PRODUCT_METADATA');
    expect(result.limitations.some((l) => l.includes('product-description'))).toBe(true);
  });

  it('4. recommends MONITOR for CUSTOMER_CHANGED_MIND — not a warehouse-side cause', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: 'CUSTOMER_CHANGED_MIND', category: 'OBSERVED', score: 50, confidenceLevel: 'MEDIUM', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('MONITOR');
    expect(result.limitations.some((l) => l.includes('not a warehouse-side cause'))).toBe(true);
  });

  it('5. recommends INVESTIGATE for a correlated PICKING_ERROR', async () => {
    const rootCause = buildRootCause({
      primaryCause: { type: ExceptionType.PICKING_ERROR, category: 'OBSERVED', score: 65, confidenceLevel: 'HIGH', explanation: '...' },
    });
    const result = await recommender.recommend(buildException(), {}, rootCause);
    expect(result.recommendation.actionType).toBe('INVESTIGATE');
  });

  it('6. gives higher confidence recommendation for high volume than for a single return', async () => {
    const singleReturn = await recommender.recommend(buildException(), {}, buildRootCause());
    const highVolume = await recommender.recommend(
      buildException(),
      {},
      buildRootCause({ primaryCause: { type: 'WRONG_SIZE', category: 'OBSERVED', score: 95, confidenceLevel: 'HIGH', explanation: '...' } }),
    );
    expect(highVolume.recommendation.confidenceLevel).toBe('HIGH');
    expect(singleReturn.recommendation.confidenceLevel).not.toBe('HIGH');
  });

  it('7. falls back to INVESTIGATE/MONITOR for INSUFFICIENT_EVIDENCE', async () => {
    const result = await recommender.recommend(buildException(), {}, buildRootCause({ primaryCause: null }));
    expect(['INVESTIGATE', 'MONITOR']).toContain(result.recommendation.actionType);
  });

  it('8. produces deterministic output for identical input', async () => {
    const exception = buildException();
    const rootCause = buildRootCause();
    const first = await recommender.recommend(exception, {}, rootCause);
    const second = await recommender.recommend(exception, {}, rootCause);
    expect({ ...first, analyzedAt: null }).toEqual({ ...second, analyzedAt: null });
  });
});
