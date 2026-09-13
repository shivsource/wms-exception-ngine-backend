import { describe, expect, it } from 'vitest';
import { Action, PersistedException } from '../../interfaces';
import { ActionStatus, ActionType, EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../../types/enums';
import { EscalateOperationSimulator } from './escalate-operation.simulator';

function buildAction(): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.DISPATCH_DELAY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.ESCALATE_OPERATION,
    status: ActionStatus.PROPOSED,
    title: 'Escalate',
    reason: 'dock congestion',
    parameters: { exceptionType: ExceptionType.DISPATCH_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-5' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
  };
}

function buildException(): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-1',
    type: ExceptionType.DISPATCH_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-5',
    severity: ExceptionSeverity.HIGH,
    status: ExceptionStatus.OPEN,
    title: 'Dispatch delay',
    description: null,
    evidence: { orderCode: 'ORD-5', minutesWaiting: 120 },
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('EscalateOperationSimulator', () => {
  it('1. records the escalation state transition with no fabricated quantitative metric', async () => {
    const result = await new EscalateOperationSimulator().simulate(buildAction(), buildException());

    expect(result.success).toBe(true);
    expect(result.changes).toEqual({ escalated: { from: false, to: true } });
    expect(result.after).toMatchObject({ escalated: true, escalatedTo: 'SUPERVISOR' });
  });
});
