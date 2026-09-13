import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistedException, PersistedPrediction, PredictionEvaluationResult, RiskPredictor } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findExistingOpen: vi.fn() },
  predictionRepository: {
    findActiveOrConfirmed: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    resolve: vi.fn(),
    findActiveOrConfirmedByType: vi.fn(),
  },
}));

vi.mock('./prediction-registry', () => ({
  predictionRegistry: { getAll: vi.fn() },
}));

import { exceptionRepository, predictionRepository } from '../repositories';
import { PredictionEngine } from './prediction-engine';
import { predictionRegistry } from './prediction-registry';

const findExistingOpen = vi.mocked(exceptionRepository.findExistingOpen);
const findActiveOrConfirmed = vi.mocked(predictionRepository.findActiveOrConfirmed);
const create = vi.mocked(predictionRepository.create);
const update = vi.mocked(predictionRepository.update);
const resolve = vi.mocked(predictionRepository.resolve);
const findActiveOrConfirmedByType = vi.mocked(predictionRepository.findActiveOrConfirmedByType);
const getAll = vi.mocked(predictionRegistry.getAll);

function buildEvaluation(overrides: Partial<PredictionEvaluationResult> = {}): PredictionEvaluationResult {
  return {
    predictionType: PredictionType.PICKING_DELAY_RISK,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    status: PredictionStatus.ACTIVE,
    riskScore: 75,
    riskLevel: RiskLevel.HIGH,
    confidence: 'HIGH',
    predictionWindow: { value: 10, unit: 'MINUTES' },
    signals: [],
    explanation: 'test',
    limitations: [],
    evaluatedAt: new Date('2026-08-20T09:00:00.000Z'),
    ...overrides,
  };
}

function buildPersisted(overrides: Partial<PersistedPrediction> = {}): PersistedPrediction {
  return {
    id: 1,
    predictionId: 'PRED-1',
    predictionType: PredictionType.PICKING_DELAY_RISK,
    entityType: EntityType.PICKING_TASK,
    entityId: 'TASK-1',
    riskScore: 75,
    riskLevel: RiskLevel.HIGH,
    confidence: 'HIGH',
    status: PredictionStatus.ACTIVE,
    predictionWindow: { value: 10, unit: 'MINUTES' },
    signals: [],
    explanation: 'test',
    limitations: [],
    confirmedExceptionId: null,
    predictedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 9,
    exceptionId: 'EXC-9',
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

function fakePredictor(evaluateAllResult: PredictionEvaluationResult[]): RiskPredictor {
  return {
    name: 'FakePredictor',
    predictionType: PredictionType.PICKING_DELAY_RISK,
    entityType: EntityType.PICKING_TASK,
    evaluateAll: vi.fn().mockResolvedValue(evaluateAllResult),
    evaluateOne: vi.fn(),
  };
}

describe('PredictionEngine', () => {
  const engine = new PredictionEngine();

  beforeEach(() => {
    findExistingOpen.mockReset().mockResolvedValue(null);
    findActiveOrConfirmed.mockReset().mockResolvedValue(null);
    create.mockReset().mockResolvedValue(buildPersisted());
    update.mockReset().mockResolvedValue(buildPersisted());
    resolve.mockReset().mockResolvedValue(buildPersisted({ status: PredictionStatus.RESOLVED }));
    findActiveOrConfirmedByType.mockReset().mockResolvedValue([]);
    getAll.mockReset();
  });

  it('1. creates a new ACTIVE prediction when no active row and no open exception exist', async () => {
    getAll.mockReturnValue([fakePredictor([buildEvaluation()])]);

    const summary = await engine.run();

    expect(create).toHaveBeenCalledWith(expect.anything(), PredictionStatus.ACTIVE, null);
    expect(update).not.toHaveBeenCalled();
    expect(summary.totalCreated).toBe(1);
    expect(summary.totalUpdated).toBe(0);
  });

  it('2. updates the existing row instead of creating a duplicate on repeated evaluation (idempotency)', async () => {
    findActiveOrConfirmed.mockResolvedValue(buildPersisted());
    getAll.mockReturnValue([fakePredictor([buildEvaluation()])]);

    const summary = await engine.run();

    expect(update).toHaveBeenCalledWith(1, expect.anything(), PredictionStatus.ACTIVE, null);
    expect(create).not.toHaveBeenCalled();
    expect(summary.totalUpdated).toBe(1);
    expect(summary.totalCreated).toBe(0);
  });

  it('3. marks a prediction CONFIRMED (never ACTIVE) once the matching exception is already OPEN', async () => {
    findExistingOpen.mockResolvedValue(buildException());
    getAll.mockReturnValue([fakePredictor([buildEvaluation()])]);

    const summary = await engine.run();

    expect(create).toHaveBeenCalledWith(expect.anything(), PredictionStatus.CONFIRMED, 'EXC-9');
    expect(summary.totalConfirmed).toBe(1);
  });

  it('4. resolves a previously-active prediction whose entity no longer appears among current candidates', async () => {
    findActiveOrConfirmedByType.mockResolvedValue([buildPersisted({ id: 42, entityId: 'TASK-STALE' })]);
    getAll.mockReturnValue([fakePredictor([])]); // no current candidates at all

    const summary = await engine.run();

    expect(resolve).toHaveBeenCalledWith(42);
    expect(summary.totalResolved).toBe(1);
  });

  it('5. does not resolve a prediction whose entity is still among current candidates', async () => {
    findActiveOrConfirmed.mockResolvedValue(buildPersisted({ id: 1, entityId: 'TASK-1' }));
    findActiveOrConfirmedByType.mockResolvedValue([buildPersisted({ id: 1, entityId: 'TASK-1' })]);
    getAll.mockReturnValue([fakePredictor([buildEvaluation({ entityId: 'TASK-1' })])]);

    await engine.run();

    expect(resolve).not.toHaveBeenCalled();
  });

  it('6. records a per-predictor error without aborting the whole run', async () => {
    const failingPredictor: RiskPredictor = {
      name: 'FailingPredictor',
      predictionType: PredictionType.DISPATCH_DELAY_RISK,
      entityType: EntityType.ORDER,
      evaluateAll: vi.fn().mockRejectedValue(new Error('boom')),
      evaluateOne: vi.fn(),
    };
    getAll.mockReturnValue([failingPredictor, fakePredictor([buildEvaluation()])]);

    const summary = await engine.run();

    expect(summary.totalErrors).toBe(1);
    expect(summary.predictors[0].error).toBe('boom');
    expect(summary.totalCreated).toBe(1); // the second, healthy predictor still ran
  });
});
