/** Row shape of the engine-owned `predictions` table (see migration 0006). */
export interface PredictionRow {
  id: number;
  prediction_id: string;
  prediction_type: string; // PredictionType enum value; column is a free-form varchar(50)
  entity_type: string; // EntityType enum value; column is a free-form varchar(50)
  entity_id: string;
  risk_score: number | null;
  risk_level: string;
  confidence: string | null;
  status: string;
  prediction_window_minutes: number | null;
  // mysql2 auto-parses JSON columns into an object/array on read, same caveat as exceptions.evidence.
  signals: unknown[] | string;
  explanation: string;
  limitations: unknown[] | string;
  confirmed_exception_id: string | null;
  predicted_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
