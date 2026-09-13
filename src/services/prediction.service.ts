import { predictionEngine } from '../engine';
import { predictionRegistry } from '../engine/prediction-registry';
import {
  PersistedException,
  PersistedPrediction,
  PredictionConfidence,
  PredictionRunSummary,
  PredictionWindow,
  RiskSignal,
} from '../interfaces';
import { exceptionRepository, PredictionFilters, predictionRepository } from '../repositories';
import { EntityType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';
import { AppError } from '../utils/AppError';

export interface EntityPredictorEvaluation {
  predictionType: PredictionType;
  status: PredictionStatus | 'INSUFFICIENT_DATA';
  riskScore: number | null;
  riskLevel: RiskLevel;
  confidence: PredictionConfidence | null;
  predictionWindow: PredictionWindow | null;
  signals: RiskSignal[];
  explanation: string;
  limitations: string[];
  confirmedExceptionId: string | null;
  /** null only when status is INSUFFICIENT_DATA — nothing is persisted in that case. */
  persisted: PersistedPrediction | null;
}

export interface EntityEvaluationView {
  entityType: EntityType;
  entityId: string;
  /** Currently OPEN exceptions for this entity — context for "was this prediction suppressed/confirmed?" (Step 18). */
  existingOpenExceptions: PersistedException[];
  evaluations: EntityPredictorEvaluation[];
}

export interface EntityPredictionsView {
  entityId: string;
  predictions: PersistedPrediction[];
  /** Simplest explainable aggregation (Step 16): the highest risk score among this entity's
   *  currently ACTIVE/CONFIRMED predictions, not a weighted composite — every individual
   *  risk stays visible in `predictions` alongside it. */
  overallRisk: { score: number; level: RiskLevel; predictionType: PredictionType } | null;
}

export class PredictionService {
  async runEvaluation(): Promise<PredictionRunSummary> {
    return predictionEngine.run();
  }

  async list(filters: PredictionFilters): Promise<PersistedPrediction[]> {
    return predictionRepository.findAll(filters);
  }

  async getById(id: number): Promise<PersistedPrediction> {
    const prediction = await predictionRepository.findById(id);
    if (!prediction) {
      throw AppError.notFound(`Prediction ${id} not found`);
    }
    return prediction;
  }

  async getByEntityId(entityId: string): Promise<EntityPredictionsView> {
    const predictions = await predictionRepository.findByEntityId(entityId);
    const active = predictions.filter((p) => p.status !== PredictionStatus.RESOLVED && p.riskScore !== null);
    const highest = active.reduce<PersistedPrediction | null>((best, p) => (best === null || (p.riskScore ?? 0) > (best.riskScore ?? 0) ? p : best), null);

    return {
      entityId,
      predictions,
      overallRisk: highest ? { score: highest.riskScore as number, level: highest.riskLevel, predictionType: highest.predictionType } : null,
    };
  }

  /** Evaluates every predictor applicable to this entity's type, live, and persists each
   *  result the same idempotent way the bulk engine run does — see Step 18. */
  async evaluateEntity(entityType: EntityType, entityId: string): Promise<EntityEvaluationView> {
    const predictors = predictionRegistry.getByEntityType(entityType);
    if (predictors.length === 0) {
      throw AppError.badRequest(`No predictor is registered for entity type ${entityType}`);
    }

    const evaluations: EntityPredictorEvaluation[] = [];
    for (const predictor of predictors) {
      const result = await predictor.evaluateOne(entityId);
      if (result.status === 'INSUFFICIENT_DATA') {
        evaluations.push({
          predictionType: predictor.predictionType,
          status: 'INSUFFICIENT_DATA',
          riskScore: null,
          riskLevel: result.riskLevel,
          confidence: null,
          predictionWindow: null,
          signals: [],
          explanation: result.explanation,
          limitations: result.limitations,
          confirmedExceptionId: null,
          persisted: null,
        });
        continue;
      }

      const outcome = await predictionEngine.persist(result);
      evaluations.push({
        predictionType: predictor.predictionType,
        status: outcome.status,
        riskScore: result.riskScore,
        riskLevel: result.riskLevel,
        confidence: result.confidence,
        predictionWindow: result.predictionWindow,
        signals: result.signals,
        explanation: result.explanation,
        limitations: result.limitations,
        confirmedExceptionId: outcome.confirmedExceptionId,
        persisted: outcome.persisted,
      });
    }

    const existingOpenExceptions = await exceptionRepository.findOpenByEntity(entityType, entityId);

    return { entityType, entityId, existingOpenExceptions, evaluations };
  }
}

export const predictionService = new PredictionService();
