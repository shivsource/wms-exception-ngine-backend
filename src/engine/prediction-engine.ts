import { PersistedPrediction, PredictionEvaluationResult, PredictionRunSummary, PredictorExecutionSummary } from '../interfaces';
import { PREDICTS_EXCEPTION_TYPE } from '../predictors';
import { exceptionRepository, predictionRepository } from '../repositories';
import { PredictionStatus } from '../types/enums';
import { logger } from '../utils/logger';
import { predictionRegistry } from './prediction-registry';

type PersistOutcome = { kind: 'created' | 'updated'; status: PredictionStatus; confirmedExceptionId: string | null; persisted: PersistedPrediction };

/**
 * Orchestrates every registered predictor. Mirrors ExceptionEngine's shape and
 * responsibilities: no scoring logic of its own — it only knows how to run a
 * RiskPredictor, correlate against `exceptions` to decide ACTIVE vs CONFIRMED, dedupe
 * against already-active predictions (update in place), resolve predictions whose entity
 * no longer qualifies, and report what happened.
 */
export class PredictionEngine {
  async run(): Promise<PredictionRunSummary> {
    const startedAt = new Date();
    const runStart = Date.now();
    const predictorSummaries: PredictorExecutionSummary[] = [];

    for (const predictor of predictionRegistry.getAll()) {
      const predictorStart = Date.now();
      try {
        const results = await predictor.evaluateAll();
        const currentEntityIds = new Set<string>();
        let createdCount = 0;
        let updatedCount = 0;
        let confirmedCount = 0;

        for (const result of results) {
          currentEntityIds.add(result.entityId);
          const outcome = await this.persist(result);
          if (outcome.kind === 'created') createdCount++;
          else updatedCount++;
          if (outcome.status === PredictionStatus.CONFIRMED) confirmedCount++;
        }

        const resolvedCount = await this.resolveStale(predictor.predictionType, currentEntityIds);

        const summary: PredictorExecutionSummary = {
          predictorName: predictor.name,
          predictionType: predictor.predictionType,
          evaluatedCount: results.length,
          createdCount,
          updatedCount,
          confirmedCount,
          resolvedCount,
          durationMs: Date.now() - predictorStart,
        };
        predictorSummaries.push(summary);
        logger.info(`Predictor executed: ${predictor.name}`, { ...summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        predictorSummaries.push({
          predictorName: predictor.name,
          predictionType: predictor.predictionType,
          evaluatedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          confirmedCount: 0,
          resolvedCount: 0,
          durationMs: Date.now() - predictorStart,
          error: message,
        });
        logger.error(`Predictor failed: ${predictor.name}`, { error: message });
      }
    }

    const summary: PredictionRunSummary = {
      startedAt,
      durationMs: Date.now() - runStart,
      predictors: predictorSummaries,
      totalEvaluated: predictorSummaries.reduce((sum, p) => sum + p.evaluatedCount, 0),
      totalCreated: predictorSummaries.reduce((sum, p) => sum + p.createdCount, 0),
      totalUpdated: predictorSummaries.reduce((sum, p) => sum + p.updatedCount, 0),
      totalConfirmed: predictorSummaries.reduce((sum, p) => sum + p.confirmedCount, 0),
      totalResolved: predictorSummaries.reduce((sum, p) => sum + p.resolvedCount, 0),
      totalErrors: predictorSummaries.filter((p) => p.error).length,
    };

    logger.info('Prediction engine run complete', {
      durationMs: summary.durationMs,
      totalEvaluated: summary.totalEvaluated,
      totalCreated: summary.totalCreated,
      totalUpdated: summary.totalUpdated,
      totalConfirmed: summary.totalConfirmed,
      totalResolved: summary.totalResolved,
      totalErrors: summary.totalErrors,
    });

    return summary;
  }

  /**
   * Persists one evaluation, idempotently: correlates against `exceptions` (Step 15 — never
   * presents an already-confirmed exception as an active prediction) to decide ACTIVE vs
   * CONFIRMED, then updates the existing ACTIVE/CONFIRMED row for this entity if one exists,
   * or inserts a new one (Step 14 — no duplicate rows on repeated evaluation).
   */
  async persist(result: PredictionEvaluationResult): Promise<PersistOutcome> {
    const exceptionType = PREDICTS_EXCEPTION_TYPE[result.predictionType];
    const openException = await exceptionRepository.findExistingOpen(exceptionType, result.entityType, result.entityId);
    const status = openException ? PredictionStatus.CONFIRMED : PredictionStatus.ACTIVE;
    const confirmedExceptionId = openException?.exceptionId ?? null;

    const existing = await predictionRepository.findActiveOrConfirmed(result.predictionType, result.entityType, result.entityId);
    if (existing) {
      const persisted = await predictionRepository.update(existing.id, result, status, confirmedExceptionId);
      return { kind: 'updated', status, confirmedExceptionId, persisted };
    }
    const persisted = await predictionRepository.create(result, status, confirmedExceptionId);
    return { kind: 'created', status, confirmedExceptionId, persisted };
  }

  /** Resolves any ACTIVE/CONFIRMED prediction of this type whose entity did not appear among
   *  this run's candidates — the risk has dissipated, or the entity moved past this stage. */
  private async resolveStale(predictionType: PredictionEvaluationResult['predictionType'], currentEntityIds: Set<string>): Promise<number> {
    const activeOrConfirmed = await predictionRepository.findActiveOrConfirmedByType(predictionType);
    let resolvedCount = 0;
    for (const prediction of activeOrConfirmed) {
      if (!currentEntityIds.has(prediction.entityId)) {
        await predictionRepository.resolve(prediction.id);
        resolvedCount++;
      }
    }
    return resolvedCount;
  }
}

export const predictionEngine = new PredictionEngine();
