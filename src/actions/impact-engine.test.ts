import { describe, expect, it } from 'vitest';
import { computeImpact } from './impact-engine';
import { Action, PersistedException, SimulationResult } from '../interfaces';
import { ActionStatus, ActionType, EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.PICKING_DELAY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.REASSIGN_PICKER,
    status: ActionStatus.EXECUTING,
    title: 'Reassign',
    reason: 'overloaded',
    parameters: { taskId: 'TASK-1' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-1',
    type: ExceptionType.PICKING_DELAY,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    severity: ExceptionSeverity.HIGH,
    status: ExceptionStatus.OPEN,
    title: 'Picking delay',
    description: null,
    evidence: null,
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('computeImpact', () => {
  it('1. reports zero impact and explains a failed simulation', () => {
    const simulation: SimulationResult = { success: false, before: {}, after: {}, changes: {}, notes: ['no alternate picker'] };
    const impact = computeImpact(buildAction(), buildException(), simulation);

    expect(impact.metrics).toEqual([]);
    expect(impact.percentageImprovement).toBeNull();
    expect(impact.notes.join(' ')).toContain('no alternate picker');
  });

  it('2. computes minutesSaved and percentageImprovement for REASSIGN_PICKER', () => {
    const simulation: SimulationResult = {
      success: true,
      before: { pickerId: 'PICKER-1', pickingTimeMinutes: 90, concurrentActiveTasks: 3 },
      after: { pickerId: 'PICKER-2', pickingTimeMinutes: 30, concurrentActiveTasks: 0 },
      changes: { pickerId: { from: 'PICKER-1', to: 'PICKER-2' } },
      notes: [],
    };

    const impact = computeImpact(buildAction(), buildException(), simulation);

    expect(impact.minutesSaved).toBe(60);
    expect(impact.percentageImprovement).toBeCloseTo(66.67, 1);
    expect(impact.tasksAffected).toBe(1);
    expect(impact.severityChange?.before).toBe(ExceptionSeverity.HIGH);
  });

  it('3. computes shortfall-based percentageImprovement for REPLENISH_INVENTORY and resolves severity to LOW', () => {
    const action = buildAction({ actionType: ActionType.REPLENISH_INVENTORY, exceptionType: ExceptionType.INVENTORY_SHORTAGE, parameters: { sku: 'SKU-1' } });
    const exception = buildException({ type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT, entityId: 'SKU-1', severity: ExceptionSeverity.HIGH });
    const simulation: SimulationResult = {
      success: true,
      before: { totalAvailable: 10, shortfallUnits: 10 },
      after: { totalAvailable: 20, shortfallUnits: 0 },
      changes: { totalAvailable: { from: 10, to: 20 } },
      notes: [],
    };

    const impact = computeImpact(action, exception, simulation);

    expect(impact.percentageImprovement).toBe(100);
    expect(impact.severityChange?.after).toBe(ExceptionSeverity.LOW);
  });

  it('4. computes slaRecovered for SLA_AT_RISK via PRIORITIZE_ORDER', () => {
    const action = buildAction({
      actionType: ActionType.PRIORITIZE_ORDER,
      exceptionType: ExceptionType.SLA_AT_RISK,
      parameters: { exceptionType: ExceptionType.SLA_AT_RISK, entityType: EntityType.ORDER, entityId: 'ORD-1' },
    });
    const exception = buildException({ type: ExceptionType.SLA_AT_RISK, entityType: EntityType.ORDER, entityId: 'ORD-1', severity: ExceptionSeverity.CRITICAL });
    const simulation: SimulationResult = {
      success: true,
      before: { minutesRemaining: -10, upstreamWaitingMinutes: 45 },
      after: { minutesRemaining: 35, upstreamWaitingMinutes: 0 },
      changes: { minutesRemaining: { from: -10, to: 35 } },
      notes: [],
    };

    const impact = computeImpact(action, exception, simulation);

    expect(impact.slaRecovered).toBe(true);
    expect(impact.ordersAffected).toBe(1);
  });

  it('5. ESCALATE_OPERATION carries no quantitative metric', () => {
    const action = buildAction({ actionType: ActionType.ESCALATE_OPERATION, parameters: {} });
    const simulation: SimulationResult = { success: true, before: { escalated: false }, after: { escalated: true }, changes: { escalated: { from: false, to: true } }, notes: [] };

    const impact = computeImpact(action, buildException(), simulation);

    expect(impact.metrics).toEqual([]);
    expect(impact.percentageImprovement).toBeNull();
  });
});
