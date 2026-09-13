import { EntityType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';
import { PredictionConfidence, PredictionWindow, RiskSignal } from './prediction.interface';

/** Domain shape returned by PredictionRepository — the DB row translated out of raw JSON/strings. */
export interface PersistedPrediction {
  id: number;
  predictionId: string;
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  /** null only for a currently-ACTIVE/CONFIRMED row is never the case in practice — kept
   *  nullable only to mirror PredictionEvaluationResult's shape; INSUFFICIENT_DATA evaluations
   *  are never persisted (see prediction-engine.ts) so a stored row always has a real score. */
  riskScore: number | null;
  riskLevel: RiskLevel;
  confidence: PredictionConfidence | null;
  status: PredictionStatus;
  predictionWindow: PredictionWindow | null;
  signals: RiskSignal[];
  explanation: string;
  limitations: string[];
  /** Set when status transitions to CONFIRMED — the exception this prediction warned about. */
  confirmedExceptionId: string | null;
  predictedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
