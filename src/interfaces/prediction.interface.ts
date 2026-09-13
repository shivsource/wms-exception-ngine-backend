import { EntityType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

/**
 * Result shapes produced by the Prediction/Risk Scoring Engine (src/predictors/). Answers
 * "is this operational entity likely to become an exception BEFORE it actually does, how
 * severe, why, and when?" — deliberately separate from DetectedException (src/interfaces/
 * detected-exception.interface.ts): a prediction is never itself an exception, and this
 * engine never creates rows in the `exceptions` table. See ARCHITECTURE.md.
 */

/** How much historical/derived data backed this evaluation — "if meaningful" per predictor,
 *  not a statistical confidence interval. LOW means the score leaned on incomplete signals
 *  (e.g. no historical baseline) but was still computable from what was available. */
export type PredictionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** One atomic, explainable fact that contributed to (or was evaluated for, at zero
 *  contribution) a prediction's risk score. Mirrors SupportingEvidenceItem's philosophy:
 *  never a black-box number. `contribution` is points added to riskScore, capped by the
 *  named weight in config/thresholds.ts — never an arbitrary/unexplained number. */
export interface RiskSignal {
  signal: string;
  value: number | string | boolean | null;
  expected?: number | null;
  unit?: string;
  /** Points this signal contributed toward riskScore (0 if evaluated but not risk-contributing). */
  contribution: number;
  reason: string;
}

export interface PredictionWindow {
  value: number;
  unit: 'MINUTES';
}

/**
 * The live/computed outcome of evaluating one entity against one predictor — what a
 * predictor's evaluate methods return, before the engine persists it. `status` here is the
 * status this evaluation implies for the persisted row (see PredictionStatus); the engine
 * decides ACTIVE vs CONFIRMED by checking `exceptionRepository`, not the predictor itself,
 * except when the predictor determines there isn't enough data to score at all.
 */
export interface PredictionEvaluationResult {
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  /** ACTIVE/CONFIRMED are set by the engine after correlating with `exceptions`; a predictor
   *  itself only ever returns ACTIVE (candidate) or INSUFFICIENT_DATA. */
  status: PredictionStatus | 'INSUFFICIENT_DATA';
  /** null only when status is INSUFFICIENT_DATA — never a fabricated 0. */
  riskScore: number | null;
  riskLevel: RiskLevel;
  confidence: PredictionConfidence | null;
  predictionWindow: PredictionWindow | null;
  signals: RiskSignal[];
  explanation: string;
  /** Explicit caveats: signals that couldn't be evaluated, why confidence is capped, why
   *  status is INSUFFICIENT_DATA. Mirrors RootCauseAnalysis.limitations. */
  limitations: string[];
  evaluatedAt: Date;
}
