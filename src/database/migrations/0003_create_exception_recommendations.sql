-- Recommendation Engine history. Engine-owned (like `exceptions` and `root_cause_analyses`).
-- Unlike root_cause_analyses (purely append-only), `status` is expected to be mutated later
-- by a human decision (PENDING -> ACCEPTED/REJECTED/SUPERSEDED/COMPLETED) even though the
-- recommendation content snapshot itself stays immutable — preparation for a future Action Engine.
CREATE TABLE IF NOT EXISTS exception_recommendations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  recommendation_id VARCHAR(64) NOT NULL UNIQUE,
  exception_id BIGINT NOT NULL,
  exception_type VARCHAR(100) NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  approval_level VARCHAR(20) NOT NULL,
  confidence_level VARCHAR(30) NOT NULL,
  score INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  result JSON NOT NULL,
  analyzed_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_exception_recommendation_exception FOREIGN KEY (exception_id) REFERENCES exceptions(id),
  INDEX idx_exception_recommendation_exception (exception_id),
  INDEX idx_exception_recommendation_status (status)
);
