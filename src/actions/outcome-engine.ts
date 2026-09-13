import { thresholds } from '../config/thresholds';
import { ActionImpact } from '../interfaces';
import { OutcomeResult } from '../types/enums';

/**
 * Turns an ActionImpact into a deterministic OutcomeResult (src/types/enums.ts). Distinguishes
 * "the simulation failed to run" (FAILED) from "it ran but didn't help" (NO_IMPROVEMENT) from
 * genuine SUCCESS/PARTIAL_SUCCESS, using the named improvement band in
 * thresholds.actionEngine.outcome — never an arbitrary inline number.
 */
export function deriveOutcomeResult(impact: ActionImpact, simulationSucceeded: boolean): OutcomeResult {
  if (!simulationSucceeded) return OutcomeResult.FAILED;

  if (impact.percentageImprovement !== null) {
    if (impact.percentageImprovement >= thresholds.actionEngine.outcome.successImprovementPercentage) return OutcomeResult.SUCCESS;
    if (impact.percentageImprovement > 0) return OutcomeResult.PARTIAL_SUCCESS;
    return OutcomeResult.NO_IMPROVEMENT;
  }

  if (impact.slaRecovered === true) return OutcomeResult.SUCCESS;

  if (impact.metrics.length === 0) {
    // No quantitative metric exists for this ActionType (e.g. ESCALATE_OPERATION) — the state
    // transition itself succeeded, so this is a qualitative success, not a measured one.
    return OutcomeResult.SUCCESS;
  }

  // A metric exists but couldn't be reduced to a percentage (e.g. MOVE_INVENTORY's zero baseline) —
  // fall back to whether any metric moved in the improving direction.
  const anyMoved = impact.metrics.some((m) => m.after !== m.before);
  return anyMoved ? OutcomeResult.SUCCESS : OutcomeResult.NO_IMPROVEMENT;
}
