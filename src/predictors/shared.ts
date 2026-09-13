import { thresholds } from '../config/thresholds';
import { PredictionEvaluationResult, RiskSignal } from '../interfaces';
import { EntityType, ExceptionType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

/** The ExceptionType a given PredictionType is a leading indicator for. Used by the engine to
 *  decide ACTIVE vs CONFIRMED (see prediction-engine.ts) — never used to create an exception. */
export const PREDICTS_EXCEPTION_TYPE: Record<PredictionType, ExceptionType> = {
  [PredictionType.SLA_BREACH_RISK]: ExceptionType.SLA_AT_RISK,
  [PredictionType.PICKING_DELAY_RISK]: ExceptionType.PICKING_DELAY,
  [PredictionType.INVENTORY_SHORTAGE_RISK]: ExceptionType.INVENTORY_SHORTAGE,
  [PredictionType.DISPATCH_DELAY_RISK]: ExceptionType.DISPATCH_DELAY,
};

/** Rounds and clamps a raw additive score into the valid 0-100 range every predictor must report. */
export function capScore(raw: number): number {
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** Classifies a capped 0-100 risk score into a RiskLevel band (thresholds.prediction.riskLevel). */
export function classifyRiskLevel(score: number): RiskLevel {
  const { medium, high, critical } = thresholds.prediction.riskLevel;
  if (score >= critical) return RiskLevel.CRITICAL;
  if (score >= high) return RiskLevel.HIGH;
  if (score >= medium) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

/**
 * Scales a weight by how urgently `minutesRemaining` is closing in on zero within
 * `windowMinutes` — 0 at the start of the window, 1.0 at (or past) the deadline. Shared by
 * every predictor with an SLA-urgency signal (SLA breach, dispatch delay) so the scaling
 * behaves identically everywhere it's used.
 */
export function urgencyRatio(minutesRemaining: number, windowMinutes: number): number {
  if (windowMinutes <= 0) return 1;
  const ratio = 1 - minutesRemaining / windowMinutes;
  return Math.min(1, Math.max(0, ratio));
}

/** Scales a weight by how far `actual` has grown past `expected`, saturating at `saturateAtRatio`
 *  (e.g. 2.0 = fully-contributing once actual reaches 2x expected). 0 when actual <= expected. */
export function overageRatio(actual: number, expected: number, saturateAtRatio = 2): number {
  if (expected <= 0) return 0;
  const ratio = actual / expected;
  if (ratio <= 1) return 0;
  return Math.min(1, (ratio - 1) / (saturateAtRatio - 1));
}

/** Builds a result with no risk signals — used whenever a predictor cannot compute a score at
 *  all (entity not found, or a required field the predictor needs isn't recorded). Never a
 *  fabricated 0 riskScore; always a documented reason via `limitations`. */
export function insufficientData(
  predictionType: PredictionType,
  entityType: EntityType,
  entityId: string,
  reasons: string[],
): PredictionEvaluationResult {
  return {
    predictionType,
    entityType,
    entityId,
    status: 'INSUFFICIENT_DATA',
    riskScore: null,
    riskLevel: RiskLevel.UNKNOWN,
    confidence: null,
    predictionWindow: null,
    signals: [],
    explanation: `Insufficient operational data to calculate ${predictionType.toLowerCase().replace(/_/g, ' ')}.`,
    limitations: reasons,
    evaluatedAt: new Date(),
  };
}

/** Sums every signal's contribution, capped 0-100 — the one place a predictor turns its
 *  signal list into a final score, so every predictor caps identically. */
export function scoreFromSignals(signals: RiskSignal[]): number {
  return capScore(signals.reduce((sum, s) => sum + s.contribution, 0));
}

/** ACTIVE candidate result, before the engine correlates it against `exceptions` to decide
 *  ACTIVE vs CONFIRMED. Every predictor builds its non-insufficient-data result this way so
 *  scoring/classification/explanation stay consistent across predictors. */
export function activeResult(params: {
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  signals: RiskSignal[];
  confidence: PredictionEvaluationResult['confidence'];
  predictionWindow: PredictionEvaluationResult['predictionWindow'];
  explanation: string;
  limitations?: string[];
}): PredictionEvaluationResult {
  const riskScore = scoreFromSignals(params.signals);
  return {
    predictionType: params.predictionType,
    entityType: params.entityType,
    entityId: params.entityId,
    status: PredictionStatus.ACTIVE,
    riskScore,
    riskLevel: classifyRiskLevel(riskScore),
    confidence: params.confidence,
    predictionWindow: params.predictionWindow,
    signals: params.signals,
    explanation: params.explanation,
    limitations: params.limitations ?? [],
    evaluatedAt: new Date(),
  };
}
