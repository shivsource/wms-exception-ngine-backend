-- Action Engine history. Engine-owned (like `exceptions`, `root_cause_analyses`, and
-- `exception_recommendations`). One row per operational intervention created from a
-- recommendation snapshot. `parameters`/`title`/`reason` are set once at creation
-- (append-only content, like exception_recommendations.result); `status` and the four
-- lifecycle timestamps are the only fields ever mutated afterward, by approve/execute
-- calls (see action.service.ts) — never a WMS mutation, only this engine's own record.
CREATE TABLE IF NOT EXISTS actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  action_id VARCHAR(64) NOT NULL UNIQUE,
  exception_id BIGINT NOT NULL,
  exception_business_id VARCHAR(64) NOT NULL,
  exception_type VARCHAR(100) NOT NULL,
  recommendation_id INT NOT NULL,
  recommendation_business_id VARCHAR(64) NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  title VARCHAR(255) NOT NULL,
  reason TEXT NOT NULL,
  parameters JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  executed_at DATETIME NULL,
  completed_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_action_exception FOREIGN KEY (exception_id) REFERENCES exceptions(id),
  CONSTRAINT fk_action_recommendation FOREIGN KEY (recommendation_id) REFERENCES exception_recommendations(id),
  INDEX idx_action_exception (exception_id),
  INDEX idx_action_status (status)
);
