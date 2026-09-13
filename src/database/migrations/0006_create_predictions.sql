-- Prediction/Risk Scoring Engine store. Engine-owned (like `exceptions`), but unlike
-- `exceptions` a prediction row IS mutated in place while its risk is still developing:
-- re-evaluating the same entity updates risk_score/signals/status rather than inserting a
-- new row every run (idempotency is enforced at the application layer, in
-- PredictionRepository/PredictionEngine — mirroring how `exceptions` dedupes open rows via
-- findExistingOpen — not by a DB uniqueness constraint, since a *resolved* prediction must
-- never block a fresh future risk episode for the same entity+type from being created).
CREATE TABLE IF NOT EXISTS predictions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prediction_id VARCHAR(64) NOT NULL UNIQUE,
  prediction_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  risk_score INT NULL,
  risk_level VARCHAR(20) NOT NULL,
  confidence VARCHAR(20) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  prediction_window_minutes INT NULL,
  signals JSON NOT NULL,
  explanation TEXT NOT NULL,
  limitations JSON NOT NULL,
  confirmed_exception_id VARCHAR(64) NULL,
  predicted_at DATETIME NOT NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_prediction_lookup (prediction_type, entity_type, entity_id, status),
  INDEX idx_prediction_status (status),
  INDEX idx_prediction_risk_level (risk_level),
  INDEX idx_prediction_entity (entity_id)
);
