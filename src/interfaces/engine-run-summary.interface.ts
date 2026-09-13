export interface RuleExecutionSummary {
  ruleName: string;
  exceptionType: string;
  detectedCount: number;
  persistedCount: number;
  duplicateCount: number;
  durationMs: number;
  error?: string;
}

export interface EngineRunSummary {
  startedAt: Date;
  durationMs: number;
  rules: RuleExecutionSummary[];
  totalDetected: number;
  totalPersisted: number;
  totalDuplicates: number;
  totalErrors: number;
}
