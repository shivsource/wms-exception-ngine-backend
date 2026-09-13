/** Row shape of the engine-owned `exception_recommendations` table (see migration 0003). */
export interface ExceptionRecommendationRow {
  id: number;
  recommendation_id: string;
  exception_id: number;
  exception_type: string;
  action_type: string;
  title: string;
  priority: string;
  risk_level: string;
  approval_level: string;
  confidence_level: string;
  score: number;
  status: string;
  // mysql2 auto-parses JSON columns into an object on read, same caveat as exceptions.evidence.
  result: Record<string, unknown> | string;
  analyzed_at: Date;
  created_at: Date;
  updated_at: Date;
}
