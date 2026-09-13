export interface PredictorExecutionSummary {
  predictorName: string;
  predictionType: string;
  evaluatedCount: number;
  createdCount: number;
  updatedCount: number;
  confirmedCount: number;
  resolvedCount: number;
  durationMs: number;
  error?: string;
}

/** Mirrors EngineRunSummary's shape for the Prediction Engine's own bulk run. */
export interface PredictionRunSummary {
  startedAt: Date;
  durationMs: number;
  predictors: PredictorExecutionSummary[];
  totalEvaluated: number;
  totalCreated: number;
  totalUpdated: number;
  totalConfirmed: number;
  totalResolved: number;
  totalErrors: number;
}
