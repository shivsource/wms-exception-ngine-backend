import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn().mockResolvedValue([]) },
}));

import { exceptionRepository } from '../../repositories';
import { Action, PersistedException } from '../../interfaces';
import { ActionStatus, ActionType, EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../../types/enums';
import { PrioritizeOrderSimulator } from './prioritize-order.simulator';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 1,
    exceptionId: 'EXC-1',
    exceptionType: ExceptionType.PACKING_DELAY,
    recommendationDbId: 1,
    recommendationId: 'REC-1',
    actionType: ActionType.PRIORITIZE_ORDER,
    status: ActionStatus.PROPOSED,
    title: 'Prioritize',
    reason: 'packing overdue',
    parameters: { exceptionType: ExceptionType.PACKING_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-4' },
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
    type: ExceptionType.PACKING_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-4',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Packing delay',
    description: null,
    evidence: { orderCode: 'ORD-4', minutesWaiting: 90 },
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PrioritizeOrderSimulator', () => {
  const simulator = new PrioritizeOrderSimulator();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. eliminates the accrued queue wait for PACKING_DELAY/DISPATCH_DELAY', async () => {
    const result = await simulator.simulate(buildAction(), buildException());

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ waitingMinutes: 90 });
    expect(result.after).toEqual({ waitingMinutes: 0 });
  });

  it('2. eliminates elapsed queue wait for PICKING_DELAY', async () => {
    const action = buildAction({ exceptionType: ExceptionType.PICKING_DELAY, parameters: { exceptionType: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1' } });
    const exception = buildException({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { taskCode: 'TASK-1', elapsedMinutes: 60 } });

    const result = await simulator.simulate(action, exception);

    expect(result.success).toBe(true);
    expect((result.before as { waitingMinutes: number }).waitingMinutes).toBe(60);
  });

  it('3. SLA_AT_RISK recovers the earliest correlated OPEN upstream delay', async () => {
    findAllByType.mockImplementation(async (type: ExceptionType) => {
      if (type === ExceptionType.PACKING_DELAY) {
        return [
          buildException({
            id: 2,
            type: ExceptionType.PACKING_DELAY,
            entityId: 'ORD-4',
            status: ExceptionStatus.OPEN,
            evidence: { orderCode: 'ORD-4', minutesWaiting: 45 },
          }),
        ];
      }
      return [];
    });

    const action = buildAction({
      exceptionType: ExceptionType.SLA_AT_RISK,
      parameters: { exceptionType: ExceptionType.SLA_AT_RISK, entityType: EntityType.ORDER, entityId: 'ORD-4' },
    });
    const exception = buildException({
      type: ExceptionType.SLA_AT_RISK,
      evidence: { orderCode: 'ORD-4', minutesRemaining: 10 },
    });

    const result = await simulator.simulate(action, exception);

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ minutesRemaining: 10, upstreamWaitingMinutes: 45 });
    expect(result.after).toEqual({ minutesRemaining: 55, upstreamWaitingMinutes: 0 });
  });

  it('4. SLA_AT_RISK with no correlated upstream delay has zero recoverable wait', async () => {
    const action = buildAction({
      exceptionType: ExceptionType.SLA_AT_RISK,
      parameters: { exceptionType: ExceptionType.SLA_AT_RISK, entityType: EntityType.ORDER, entityId: 'ORD-9' },
    });
    const exception = buildException({ type: ExceptionType.SLA_AT_RISK, evidence: { orderCode: 'ORD-9', minutesRemaining: 30 } });

    const result = await simulator.simulate(action, exception);

    expect(result.success).toBe(true);
    expect(result.after).toEqual({ minutesRemaining: 30, upstreamWaitingMinutes: 0 });
  });
});
