import { ExceptionSeverity } from '../types/enums';

/**
 * Ascending breakpoints a measured value must reach or exceed to be classified at
 * each severity level. Each rule defines its own thresholds appropriate to its metric.
 */
export interface SeverityThresholds {
  medium: number;
  high: number;
  critical: number;
}

/** Classifies a value against absolute thresholds, e.g. minutes late, error count. */
export function classifyBySeverityThresholds(
  value: number,
  thresholds: SeverityThresholds,
): ExceptionSeverity {
  if (value >= thresholds.critical) return ExceptionSeverity.CRITICAL;
  if (value >= thresholds.high) return ExceptionSeverity.HIGH;
  if (value >= thresholds.medium) return ExceptionSeverity.MEDIUM;
  return ExceptionSeverity.LOW;
}

/**
 * Classifies how far `actual` has drifted from `baseline` (e.g. a picker's time vs.
 * the warehouse average) by converting it to a ratio and reusing the same thresholds.
 * A ratio of 1.0 means "at baseline"; 1.5 means "50% over baseline".
 */
export function classifyByRatio(
  actual: number,
  baseline: number,
  thresholds: SeverityThresholds,
): ExceptionSeverity {
  if (baseline <= 0) return ExceptionSeverity.LOW;
  const ratio = actual / baseline;
  return classifyBySeverityThresholds(ratio, thresholds);
}
