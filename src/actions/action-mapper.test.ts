import { describe, expect, it } from 'vitest';
import { isUnmappable, mapRecommendationToAction } from './action-mapper';
import { PersistedException, RecommendationResult } from '../interfaces';
import { ActionType, EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-1',
    type: ExceptionType.PICKING_DELAY,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'title',
    description: null,
    evidence: null,
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRecommendation(overrides: Partial<RecommendationResult> = {}): RecommendationResult {
  return {
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.PICKING_DELAY,
    rootCause: { type: 'PICKER_OVERLOAD', category: 'INFERRED', confidenceLevel: 'MEDIUM' },
    recommendation: {
      actionType: 'REASSIGN',
      title: 'Reassign',
      action: 'Reassign the task',
      priority: ExceptionSeverity.MEDIUM,
      actionability: 'IMMEDIATE',
      score: 70,
      confidenceLevel: 'MEDIUM',
      reason: 'overloaded picker',
      supportingEvidence: [],
      expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'faster' },
      risk: { level: 'MEDIUM', description: '...' },
      approval: { level: 'RECOMMENDED', reason: '...' },
    },
    alternativeRecommendations: [],
    limitations: [],
    analyzedAt: new Date(),
    ...overrides,
  };
}

describe('mapRecommendationToAction', () => {
  it('1. maps REASSIGN on PICKING_DELAY (non-shortage cause) to REASSIGN_PICKER', () => {
    const result = mapRecommendationToAction(buildException(), buildRecommendation());
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) {
      expect(result.actionType).toBe(ActionType.REASSIGN_PICKER);
      expect(result.parameters).toEqual({ taskId: 'TASK-1' });
    }
  });

  it('2. maps REASSIGN on PICKING_DELAY with INVENTORY_SHORTAGE root cause to MOVE_INVENTORY', () => {
    const recommendation = buildRecommendation({ rootCause: { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', confidenceLevel: 'HIGH' } });
    const result = mapRecommendationToAction(buildException(), recommendation);
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) {
      expect(result.actionType).toBe(ActionType.MOVE_INVENTORY);
    }
  });

  it('3. REASSIGN on EXCESSIVE_PICKER_DISTANCE (already-completed task) is unmappable', () => {
    const exception = buildException({ type: ExceptionType.EXCESSIVE_PICKER_DISTANCE });
    const result = mapRecommendationToAction(exception, buildRecommendation());
    expect(isUnmappable(result)).toBe(true);
  });

  it('4. REASSIGN on SLA_AT_RISK (order, no task id) is unmappable', () => {
    const exception = buildException({ type: ExceptionType.SLA_AT_RISK, entityType: EntityType.ORDER, entityId: 'ORD-1' });
    const result = mapRecommendationToAction(exception, buildRecommendation());
    expect(isUnmappable(result)).toBe(true);
  });

  it('5. maps REPLENISH on INVENTORY_SHORTAGE to REPLENISH_INVENTORY', () => {
    const exception = buildException({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1' });
    const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType: 'REPLENISH' } });
    const result = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) {
      expect(result.actionType).toBe(ActionType.REPLENISH_INVENTORY);
      expect(result.parameters).toEqual({ sku: 'SKU-1' });
    }
  });

  it('6. maps VERIFY on INVENTORY_DISCREPANCY to RECHECK_INVENTORY with sku/location split from entityId', () => {
    const exception = buildException({ type: ExceptionType.INVENTORY_DISCREPANCY, entityType: EntityType.INVENTORY, entityId: 'SKU-9:A1' });
    const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType: 'VERIFY' } });
    const result = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) {
      expect(result.actionType).toBe(ActionType.RECHECK_INVENTORY);
      expect(result.parameters).toEqual({ sku: 'SKU-9', location: 'A1' });
    }
  });

  it('7. maps PRIORITIZE to PRIORITIZE_ORDER for any exception type', () => {
    const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType: 'PRIORITIZE' } });
    const result = mapRecommendationToAction(buildException(), recommendation);
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) expect(result.actionType).toBe(ActionType.PRIORITIZE_ORDER);
  });

  it('8. maps ESCALATE to ESCALATE_OPERATION', () => {
    const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType: 'ESCALATE' } });
    const result = mapRecommendationToAction(buildException(), recommendation);
    expect(isUnmappable(result)).toBe(false);
    if (!isUnmappable(result)) expect(result.actionType).toBe(ActionType.ESCALATE_OPERATION);
  });

  it.each(['RE_PICK', 'RE_PACK', 'ADJUST', 'INVESTIGATE', 'MONITOR', 'CHECK_LOCATION'] as const)(
    '9. %s is always RECOMMENDATION_ONLY (unmappable)',
    (actionType) => {
      const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType } });
      const result = mapRecommendationToAction(buildException(), recommendation);
      expect(isUnmappable(result)).toBe(true);
    },
  );

  it('10. VERIFY on a non-discrepancy exception is unmappable', () => {
    const recommendation = buildRecommendation({ recommendation: { ...buildRecommendation().recommendation, actionType: 'VERIFY' } });
    const result = mapRecommendationToAction(buildException({ type: ExceptionType.PICKING_ERROR }), recommendation);
    expect(isUnmappable(result)).toBe(true);
  });
});
