import { RiskLevel } from '../types/enums';

/**
 * Tunable numbers for the VALIDATION FRAMEWORK ONLY — never business/prediction thresholds.
 * These decide how we judge a prediction's operational usefulness after the fact (e.g. "is
 * 45 minutes of warning GOOD or EXCELLENT?"); they must never be confused with
 * config/thresholds.ts, which decides what the predictors/rules themselves score and detect.
 * Mirrors config/thresholds.ts's philosophy: named, explainable, centralized — not magic
 * numbers scattered through the validation code.
 */
export const validationConfig = {
  /**
   * A persisted prediction only counts as "the system warned someone" once its risk level
   * reaches this band. Several predictors (INVENTORY_SHORTAGE_RISK in particular) evaluate
   * and persist a row for EVERY qualifying entity on every run, regardless of how low the
   * risk is — a LOW-risk row is not a meaningful warning an operator would act on, so it must
   * not count toward precision/recall. This is a validation-layer interpretation policy, not
   * a change to what the predictors persist.
   */
  meaningfulRiskLevels: [RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL] as RiskLevel[],

  /** Warning-time quality bands for a TRUE_POSITIVE (Section 29). */
  warningQuality: {
    excellentMinutes: 60,
    goodMinutes: 30,
    limitedMinutes: 5,
  },

  /** Warning-time histogram buckets for the report (Section 14/16), in minutes. */
  warningTimeBucketsMinutes: [5, 15, 30, 60, 120] as const,

  /**
   * Tolerance (minutes) applied when checking whether an exception fell within a
   * prediction's window (Section 24). Several predictors report a window as a countdown to
   * the SAME whole-minute-rounded threshold the paired exception rule enforces with a strict
   * `>` comparison (e.g. PickingDelayPredictor's window and PickingDelayRule's stuck-after
   * check both resolve to `startTime + 60min`) — so the earliest instant the rule can
   * possibly fire is inherently a fraction of a minute past the window's own reported edge,
   * purely from independent minute-rounding on each side, not a real "outside the window"
   * miss. This tolerance absorbs that rounding noise without weakening the window rule for
   * any genuinely late match.
   */
  windowToleranceMinutes: 2,

  /** Thresholds used only to phrase the report's plain-language interpretation
   *  (Section 30) — transparent and overridable, never hardcoded conclusions. */
  interpretation: {
    usefulPrecisionMin: 0.6,
    usefulRecallMin: 0.6,
    usefulAvgWarningMinutesMin: 15,
    minSampleSizeForConfidence: 30,
  },
} as const;
