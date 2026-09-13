-- Outcome/Impact Engine history. Engine-owned, append-only (like root_cause_analyses):
-- one row per POST /actions/:id/execute call. Deliberately a separate table from
-- `actions`, not extra columns on it — Action, Execution, Outcome, and Impact are
-- distinct concepts (see ARCHITECTURE.md) and an action could in principle be
-- re-executed/re-measured, producing more than one outcome row over time.
CREATE TABLE IF NOT EXISTS action_outcomes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  outcome_id VARCHAR(64) NOT NULL UNIQUE,
  action_id INT NOT NULL,
  action_business_id VARCHAR(64) NOT NULL,
  result VARCHAR(20) NOT NULL,
  before_metrics JSON NOT NULL,
  after_metrics JSON NOT NULL,
  -- Kept as two distinct JSON columns rather than one: this phase simulates execution, so
  -- actual_impact is derived identically to expected_impact today, but a future real-execution
  -- phase can populate actual_impact independently by re-measuring post-mutation WMS state
  -- without a schema change. See ActionOutcome in src/interfaces/action-outcome.interface.ts.
  expected_impact JSON NOT NULL,
  actual_impact JSON NOT NULL,
  measured_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_action_outcome_action FOREIGN KEY (action_id) REFERENCES actions(id),
  INDEX idx_action_outcome_action (action_id)
);
