import { ActionImpact } from './impact.interface';
import { OutcomeResult } from '../types/enums';

/**
 * Domain shape returned by ActionOutcomeRepository — what actually happened after an
 * action executed. Deliberately separate from Action/execution: this is the "OUTCOME"
 * step in Exception -> Evidence -> Root Cause -> Recommendation -> Action -> Execution ->
 * Outcome -> Impact (see ARCHITECTURE.md) and is never merged into the Action row itself.
 *
 * `expectedImpact` and `actualImpact` are kept as separate fields on purpose: in this
 * phase execution is simulated, so actualImpact is derived identically to expectedImpact
 * (both come from the same SimulationResult) — but the schema and the two distinct fields
 * already exist so a future phase where actions execute for real (and actual measurement
 * requires re-querying live WMS state after a real mutation) can populate actualImpact
 * independently without a schema change. See action-outcome.repository.ts and
 * src/actions/outcome-engine.ts.
 */
export interface ActionOutcome {
  id: number;
  outcomeId: string;
  actionDbId: number;
  actionId: string;
  result: OutcomeResult;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  expectedImpact: ActionImpact;
  actualImpact: ActionImpact;
  measuredAt: Date;
  createdAt: Date;
}
