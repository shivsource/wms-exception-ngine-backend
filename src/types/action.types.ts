/** Row shape of the engine-owned `actions` table (see migration 0004). */
export interface ActionRow {
  id: number;
  action_id: string;
  exception_id: number;
  exception_business_id: string;
  exception_type: string;
  recommendation_id: number;
  recommendation_business_id: string;
  action_type: string;
  status: string;
  title: string;
  reason: string;
  // mysql2 auto-parses JSON columns into an object on read, same caveat as exceptions.evidence.
  parameters: Record<string, unknown> | string;
  created_at: Date;
  approved_at: Date | null;
  executed_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

/** Row shape of the engine-owned `action_outcomes` table (see migration 0005). */
export interface ActionOutcomeRow {
  id: number;
  outcome_id: string;
  action_id: number;
  action_business_id: string;
  result: string;
  before_metrics: Record<string, unknown> | string;
  after_metrics: Record<string, unknown> | string;
  expected_impact: Record<string, unknown> | string;
  actual_impact: Record<string, unknown> | string;
  measured_at: Date;
  created_at: Date;
}
