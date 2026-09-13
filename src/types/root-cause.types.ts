/** Row shape of the engine-owned `root_cause_analyses` table (see migration 0002). */
export interface RootCauseAnalysisRow {
  id: number;
  analysis_id: string;
  exception_id: number;
  exception_type: string;
  analyzer_version: string;
  primary_cause_type: string | null;
  primary_cause_score: number | null;
  primary_cause_confidence: string | null;
  // mysql2 auto-parses JSON columns into an object on read, same caveat as exceptions.evidence.
  result: Record<string, unknown> | string;
  analyzed_at: Date;
  created_at: Date;
}
