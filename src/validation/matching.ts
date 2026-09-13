import { ExceptionSnapshot, PredictionSnapshot, ValidationResult, WarningQuality } from './types';
import { validationConfig } from './validation-config';

/**
 * Deterministic prediction -> actual-exception matching (Section 8) and warning-time
 * quality classification (Section 29). Pure functions only — no I/O, no Date.now(), no
 * randomness — so the same inputs always produce the same outputs (Section 21).
 */

export interface MatchOutcome {
  result: ValidationResult;
  matchedException: ExceptionSnapshot | null;
  /** Fractional minutes (never rounded away — Section 10) between prediction and match.
   *  Only set for TRUE_POSITIVE. */
  warningTimeMinutes: number | null;
}

/**
 * Evaluates one (prediction, candidateExceptions) pair against the 5 matching rules in
 * Section 8:
 *   1. entityType matches       — enforced by the caller (candidateExceptions is pre-scoped)
 *   2. entityId matches         — enforced by the caller
 *   3. predictionType <-> exceptionType — enforced by the caller (PREDICTS_EXCEPTION_TYPE)
 *   4. exception occurs AFTER the prediction's timestamp — enforced here
 *   5. exception occurs within the prediction's window, if one exists — enforced here
 *
 * `candidateExceptions` must contain every exception of the matching type ever detected for
 * this entity across the whole timeline (both before and after the prediction), so this
 * function alone can distinguish TRUE_POSITIVE from CONFIRMED_BEFORE_PREDICTION.
 */
export function evaluatePrediction(params: {
  prediction: PredictionSnapshot | null;
  candidateExceptions: ExceptionSnapshot[];
  simulationEndTime: Date;
}): MatchOutcome {
  const { prediction, simulationEndTime } = params;
  const candidates = [...params.candidateExceptions].sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());

  if (!prediction) {
    if (candidates.length === 0) {
      return { result: 'TRUE_NEGATIVE', matchedException: null, warningTimeMinutes: null };
    }
    return { result: 'FALSE_NEGATIVE', matchedException: candidates[0] ?? null, warningTimeMinutes: null };
  }

  const predictedAtMs = prediction.predictedAt.getTime();
  const windowEndsAtMs = prediction.predictionWindow ? predictedAtMs + prediction.predictionWindow.value * 60_000 : null;
  const toleranceMs = validationConfig.windowToleranceMinutes * 60_000;

  // Rule 4: strictly AFTER the prediction — an exception at or before predictedAt never counts.
  const future = candidates.filter((e) => e.detectedAt.getTime() > predictedAtMs);
  // Rule 5: within the prediction window (plus rounding tolerance — see validation-config.ts),
  // if the predictor reported one.
  const withinWindow = windowEndsAtMs === null ? future : future.filter((e) => e.detectedAt.getTime() <= windowEndsAtMs + toleranceMs);

  if (withinWindow.length > 0) {
    const matched = withinWindow[0] as ExceptionSnapshot;
    const warningTimeMinutes = (matched.detectedAt.getTime() - predictedAtMs) / 60_000;
    return { result: 'TRUE_POSITIVE', matchedException: matched, warningTimeMinutes };
  }

  // No valid future match. If the only candidates are at/before the prediction, the
  // exception already existed when we "predicted" it — that's confirmation, not prediction
  // (Section 25/11).
  if (future.length === 0 && candidates.length > 0) {
    return { result: 'CONFIRMED_BEFORE_PREDICTION', matchedException: candidates[0] ?? null, warningTimeMinutes: null };
  }

  // A future exception exists but fell outside the prediction window — not a valid match
  // (Section 24), and not evaluable as pending either since the window has already closed
  // relative to that exception. Falls through to the open/closed check below.

  // The prediction's window (if any) hasn't elapsed yet by the end of the simulated
  // timeline — we genuinely don't know yet whether it will still resolve to a match.
  if (windowEndsAtMs !== null && windowEndsAtMs > simulationEndTime.getTime() && prediction.finalStatus !== 'RESOLVED') {
    return { result: 'PENDING', matchedException: null, warningTimeMinutes: null };
  }

  return { result: 'FALSE_POSITIVE', matchedException: null, warningTimeMinutes: null };
}

/** Warning-time quality band for a TRUE_POSITIVE (Section 29) — configurable, validation-only
 *  thresholds (validation-config.ts), never business/prediction thresholds. */
export function classifyWarningQuality(warningTimeMinutes: number | null): WarningQuality {
  if (warningTimeMinutes === null) return 'NOT_APPLICABLE';
  const { excellentMinutes, goodMinutes, limitedMinutes } = validationConfig.warningQuality;
  if (warningTimeMinutes >= excellentMinutes) return 'EXCELLENT';
  if (warningTimeMinutes >= goodMinutes) return 'GOOD';
  if (warningTimeMinutes >= limitedMinutes) return 'LIMITED';
  return 'TOO_LATE';
}

/** Whether a persisted prediction's risk level is strong enough to count as "the system
 *  warned someone" — see validationConfig.meaningfulRiskLevels for why this exists. */
export function isMeaningfulRiskLevel(riskLevel: PredictionSnapshot['riskLevel']): boolean {
  return (validationConfig.meaningfulRiskLevels as readonly string[]).includes(riskLevel);
}
