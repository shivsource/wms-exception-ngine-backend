import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistedException, PersistedPrediction, PredictionEvaluationResult, RiskPredictor } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findOpenByEntity: vi.fn() },
  predictionRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByEntityId: vi.fn(),
  },
}));

vi.mock('../engine', () => ({
  predictionEngine: { run: vi.fn(), persist: vi.fn() },
}));

vi.mock('../engine/prediction-registry', () => ({
  predictionRegistry: { getByEntityType: vi.fn() },
}));

import { exceptionRepository, predictionRepository } from '../repositories';
import { predictionEngine } from '../engine';
import { predictionRegistry } from '../engine/prediction-registry';
import { PredictionService } from './prediction.service';
import { AppError } from '../utils/AppError';

const findOpenByEntity = vi.mocked(exceptionRepository.findOpenByEntity);
const findAll = vi.mocked(predictionRepository.findAll);
const findById = vi.mocked(predictionRepository.findById);
const findByEntityId = vi.mocked(predictionRepository.findByEntityId);
const runEngine = vi.mocked(predictionEngine.run);
const persist = vi.mocked(predictionEngine.persist);
const getByEntityType = vi.mocked(predictionRegistry.getByEntityType);

function buildPersisted(overrides: Partial<PersistedPrediction> = {}): PersistedPrediction {
  return {
    id: 1,
    predictionId: 'PRED-1',
    predictionType: PredictionType.SLA_BREACH_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    riskScore: 40,
    riskLevel: RiskLevel.MEDIUM,
    confidence: 'HIGH',
    status: PredictionStatus.ACTIVE,
    predictionWindow: { value: 30, unit: 'MINUTES' },
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

function buildEvaluation(overrides: Partial<PredictionEvaluationResult> = {}): PredictionEvaluationResult {
  return {
    predictionType: PredictionType.SLA_BREACH_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    status: PredictionStatus.ACTIVE,
    riskScore: 40,
    riskLevel: RiskLevel.MEDIUM,
    confidence: 'HIGH',
    predictionWindow: { value: 30, unit: 'MINUTES' },
    signals: [],
    explanation: 'test',
    limitations: [],
    evaluatedAt: new Date(),
    ...overrides,
  };
}

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 5,
    exceptionId: 'EXC-5',
    type: ExceptionType.SLA_AT_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    severity: ExceptionSeverity.HIGH,
    status: ExceptionStatus.OPEN,
    title: 'SLA at risk',
    description: null,
    evidence: null,
    detectedAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PredictionService', () => {
  const service = new PredictionService();

  beforeEach(() => {
    findOpenByEntity.mockReset().mockResolvedValue([]);
    findAll.mockReset();
    findById.mockReset();
    findByEntityId.mockReset();
    runEngine.mockReset();
    persist.mockReset();
    getByEntityType.mockReset();
  });

  it('1. runEvaluation delegates to the prediction engine', async () => {
    const summary = {
      startedAt: new Date(),
      durationMs: 1,
      predictors: [],
      totalEvaluated: 0,
      totalCreated: 0,
      totalUpdated: 0,
      totalConfirmed: 0,
      totalResolved: 0,
      totalErrors: 0,
    };
    runEngine.mockResolvedValue(summary);

    const result = await service.runEvaluation();

    expect(result).toBe(summary);
  });

  it('2. getById throws a 404 AppError when the prediction does not exist', async () => {
    findById.mockResolvedValue(null);

    await expect(service.getById(999)).rejects.toThrow(AppError);
  });

  it('3. getByEntityId computes overallRisk as the highest score among ACTIVE/CONFIRMED predictions, ignoring RESOLVED', async () => {
    findByEntityId.mockResolvedValue([
      buildPersisted({ id: 1, riskScore: 40, riskLevel: RiskLevel.MEDIUM, predictionType: PredictionType.SLA_BREACH_RISK }),
      buildPersisted({ id: 2, riskScore: 90, riskLevel: RiskLevel.CRITICAL, predictionType: PredictionType.DISPATCH_DELAY_RISK }),
      buildPersisted({ id: 3, riskScore: 99, riskLevel: RiskLevel.CRITICAL, status: PredictionStatus.RESOLVED }),
    ]);

    const result = await service.getByEntityId('ORD-1');

    expect(result.overallRisk).toEqual({ score: 90, level: RiskLevel.CRITICAL, predictionType: PredictionType.DISPATCH_DELAY_RISK });
    expect(result.predictions).toHaveLength(3);
  });

  it('4. getByEntityId returns a null overallRisk when there are no active/confirmed predictions', async () => {
    findByEntityId.mockResolvedValue([buildPersisted({ status: PredictionStatus.RESOLVED })]);

    const result = await service.getByEntityId('ORD-1');

    expect(result.overallRisk).toBeNull();
  });

  it('5. evaluateEntity rejects an entity type with no registered predictor', async () => {
    getByEntityType.mockReturnValue([]);

    await expect(service.evaluateEntity(EntityType.PRODUCT, 'SKU-1')).rejects.toThrow(AppError);
  });

  it('6. evaluateEntity does not persist an INSUFFICIENT_DATA evaluation', async () => {
    const predictor: RiskPredictor = {
      name: 'SlaBreachPredictor',
      predictionType: PredictionType.SLA_BREACH_RISK,
      entityType: EntityType.ORDER,
      evaluateAll: vi.fn(),
      evaluateOne: vi.fn().mockResolvedValue({
        predictionType: PredictionType.SLA_BREACH_RISK,
        entityType: EntityType.ORDER,
        entityId: 'ORD-1',
        status: 'INSUFFICIENT_DATA',
        riskScore: null,
        riskLevel: RiskLevel.UNKNOWN,
        confidence: null,
        predictionWindow: null,
        signals: [],
        explanation: 'not found',
        limitations: ['not found'],
        evaluatedAt: new Date(),
      }),
    };
    getByEntityType.mockReturnValue([predictor]);

    const result = await service.evaluateEntity(EntityType.ORDER, 'ORD-999');

    expect(persist).not.toHaveBeenCalled();
    expect(result.evaluations[0].status).toBe('INSUFFICIENT_DATA');
    expect(result.evaluations[0].persisted).toBeNull();
  });

  it('7. evaluateEntity persists a computable evaluation and surfaces existing open exceptions for the entity', async () => {
    const evaluation = buildEvaluation();
    const predictor: RiskPredictor = {
      name: 'SlaBreachPredictor',
      predictionType: PredictionType.SLA_BREACH_RISK,
      entityType: EntityType.ORDER,
      evaluateAll: vi.fn(),
      evaluateOne: vi.fn().mockResolvedValue(evaluation),
    };
    getByEntityType.mockReturnValue([predictor]);
    persist.mockResolvedValue({ kind: 'created', status: PredictionStatus.CONFIRMED, confirmedExceptionId: 'EXC-5', persisted: buildPersisted() });
    findOpenByEntity.mockResolvedValue([buildException()]);

    const result = await service.evaluateEntity(EntityType.ORDER, 'ORD-1');

    expect(result.evaluations[0].status).toBe(PredictionStatus.CONFIRMED);
    expect(result.evaluations[0].confirmedExceptionId).toBe('EXC-5');
    expect(result.existingOpenExceptions).toHaveLength(1);
    expect(result.existingOpenExceptions[0].exceptionId).toBe('EXC-5');
  });
});
