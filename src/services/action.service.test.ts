import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories', () => ({
  exceptionRepository: { findById: vi.fn() },
  actionRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    findAllByException: vi.fn(),
    approve: vi.fn(),
    markExecuting: vi.fn(),
    markCompleted: vi.fn(),
  },
  actionOutcomeRepository: {
    create: vi.fn(),
    findLatestByAction: vi.fn(),
  },
}));

vi.mock('./exception.service', () => ({
  exceptionService: { createRecommendation: vi.fn() },
}));

import { actionOutcomeRepository, actionRepository, exceptionRepository } from '../repositories';
import { Action, PersistedException, RecommendationResult } from '../interfaces';
import { exceptionService } from './exception.service';
import { ActionStatus, ActionType, EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';
import { AppError } from '../utils/AppError';
import { ActionService } from './action.service';

const findExceptionById = vi.mocked(exceptionRepository.findById);
const createAction = vi.mocked(actionRepository.create);
const findActionById = vi.mocked(actionRepository.findById);
const approveAction = vi.mocked(actionRepository.approve);
const markExecuting = vi.mocked(actionRepository.markExecuting);
const markCompleted = vi.mocked(actionRepository.markCompleted);
const createOutcome = vi.mocked(actionOutcomeRepository.create);
const findLatestOutcome = vi.mocked(actionOutcomeRepository.findLatestByAction);
const createRecommendation = vi.mocked(exceptionService.createRecommendation);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 5,
    exceptionId: 'EXC-5',
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
    ...overrides,
  };
}

function buildRecommendationResult(actionType: RecommendationResult['recommendation']['actionType']): RecommendationResult {
  return {
    exceptionId: 'EXC-5',
    exceptionType: ExceptionType.DISPATCH_DELAY,
    rootCause: { type: 'DOCK_CONGESTION', category: 'OBSERVED', confidenceLevel: 'HIGH' },
    recommendation: {
      actionType,
      title: 'Escalate dock congestion',
      action: 'Escalate to supervisor',
      priority: ExceptionSeverity.HIGH,
      actionability: 'IMMEDIATE',
      score: 80,
      confidenceLevel: 'HIGH',
      reason: 'congestion',
      supportingEvidence: [],
      expectedImpact: { metric: 'DISPATCH_DELAY', expectedOutcome: '...' },
      risk: { level: 'LOW', description: '...' },
      approval: { level: 'NOT_REQUIRED', reason: '...' },
    },
    alternativeRecommendations: [],
    limitations: [],
    analyzedAt: new Date(),
  };
}

function buildPersistedRecommendation(actionType: RecommendationResult['recommendation']['actionType']) {
  return {
    id: 10,
    recommendationId: 'REC-10',
    exceptionDbId: 5,
    exceptionType: 'DISPATCH_DELAY',
    actionType,
    title: 'Escalate dock congestion',
    priority: 'HIGH',
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    confidenceLevel: 'HIGH',
    score: 80,
    status: 'PENDING',
    result: buildRecommendationResult(actionType),
    analyzedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 1,
    actionId: 'ACT-1',
    exceptionDbId: 5,
    exceptionId: 'EXC-5',
    exceptionType: ExceptionType.DISPATCH_DELAY,
    recommendationDbId: 10,
    recommendationId: 'REC-10',
    actionType: ActionType.ESCALATE_OPERATION,
    status: ActionStatus.PROPOSED,
    title: 'Escalate',
    reason: 'congestion',
    parameters: { exceptionType: ExceptionType.DISPATCH_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-5' },
    createdAt: new Date(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ActionService', () => {
  const service = new ActionService();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createFromException', () => {
    it('1. creates an Action for a mappable recommendation (Recommendation -> Action)', async () => {
      findExceptionById.mockResolvedValue(buildException());
      createRecommendation.mockResolvedValue(buildPersistedRecommendation('ESCALATE') as never);
      createAction.mockResolvedValue(buildAction());

      const action = await service.createFromException(5);

      expect(action.actionType).toBe(ActionType.ESCALATE_OPERATION);
      expect(createAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: ActionType.ESCALATE_OPERATION, exceptionDbId: 5, recommendationDbId: 10 }),
      );
    });

    it('2. throws 422 for a RECOMMENDATION_ONLY verb (MONITOR)', async () => {
      findExceptionById.mockResolvedValue(buildException());
      createRecommendation.mockResolvedValue(buildPersistedRecommendation('MONITOR') as never);

      await expect(service.createFromException(5)).rejects.toMatchObject({ statusCode: 422 } satisfies Partial<AppError>);
      expect(createAction).not.toHaveBeenCalled();
    });

    it('3. throws 404 when the exception does not exist', async () => {
      findExceptionById.mockResolvedValue(null);

      await expect(service.createFromException(999)).rejects.toMatchObject({ statusCode: 404 });
      expect(createRecommendation).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('4. approves a PROPOSED action', async () => {
      findActionById.mockResolvedValue(buildAction());
      approveAction.mockResolvedValue(buildAction({ status: ActionStatus.APPROVED }));

      const result = await service.approve(1);
      expect(result.status).toBe(ActionStatus.APPROVED);
    });

    it('5. rejects approving a non-PROPOSED action', async () => {
      findActionById.mockResolvedValue(buildAction({ status: ActionStatus.EXECUTED }));

      await expect(service.approve(1)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('execute', () => {
    it('6. executes a PROPOSED action end-to-end and records an outcome', async () => {
      findActionById.mockResolvedValue(buildAction());
      findExceptionById.mockResolvedValue(buildException());
      markCompleted.mockResolvedValue(buildAction({ status: ActionStatus.EXECUTED }));
      createOutcome.mockImplementation(async (input) => ({
        id: 1,
        outcomeId: 'OUT-1',
        actionDbId: input.actionDbId,
        actionId: input.actionId,
        result: input.result,
        beforeMetrics: input.beforeMetrics,
        afterMetrics: input.afterMetrics,
        expectedImpact: input.expectedImpact,
        actualImpact: input.actualImpact,
        measuredAt: input.measuredAt,
        createdAt: new Date(),
      }));

      const result = await service.execute(1);

      expect(markExecuting).toHaveBeenCalledWith(1);
      expect(result.alreadyExecuted).toBe(false);
      expect(result.outcome.beforeMetrics).toEqual({ escalated: false });
      expect(result.outcome.afterMetrics).toMatchObject({ escalated: true });
    });

    it('7. is idempotent: an already-EXECUTED action returns the existing outcome without re-simulating', async () => {
      findActionById.mockResolvedValue(buildAction({ status: ActionStatus.EXECUTED }));
      findLatestOutcome.mockResolvedValue({
        id: 1,
        outcomeId: 'OUT-1',
        actionDbId: 1,
        actionId: 'ACT-1',
        result: 'SUCCESS' as never,
        beforeMetrics: {},
        afterMetrics: {},
        expectedImpact: {} as never,
        actualImpact: {} as never,
        measuredAt: new Date(),
        createdAt: new Date(),
      });

      const result = await service.execute(1);

      expect(result.alreadyExecuted).toBe(true);
      expect(markExecuting).not.toHaveBeenCalled();
    });

    it('8. rejects executing an already-EXECUTING action', async () => {
      findActionById.mockResolvedValue(buildAction({ status: ActionStatus.EXECUTING }));

      await expect(service.execute(1)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('9. rejects executing a CANCELLED action', async () => {
      findActionById.mockResolvedValue(buildAction({ status: ActionStatus.CANCELLED }));

      await expect(service.execute(1)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('getOutcome', () => {
    it('10. throws 404 when the action has never been executed', async () => {
      findActionById.mockResolvedValue(buildAction());
      findLatestOutcome.mockResolvedValue(null);

      await expect(service.getOutcome(1)).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
