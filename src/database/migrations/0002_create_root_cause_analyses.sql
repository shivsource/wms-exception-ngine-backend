-- Root Cause Engine history. Engine-owned (like `exceptions`), append-only: re-analysis
-- over time is preserved as separate rows rather than overwritten in place, so later
-- analytics/recommendation-evaluation/ML work can see how the analysis evolved.
CREATE TABLE IF NOT EXISTS root_cause_analyses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  analysis_id VARCHAR(64) NOT NULL UNIQUE,
  exception_id BIGINT NOT NULL,
  exception_type VARCHAR(100) NOT NULL,
  analyzer_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  primary_cause_type VARCHAR(100) NULL,
  primary_cause_score INT NULL,
  primary_cause_confidence VARCHAR(30) NULL,
  result JSON NOT NULL,
  analyzed_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_root_cause_exception FOREIGN KEY (exception_id) REFERENCES exceptions(id),
  INDEX idx_root_cause_exception (exception_id),
  INDEX idx_root_cause_type (exception_type, primary_cause_type)
);
