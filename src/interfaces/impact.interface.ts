import { ExceptionSeverity } from '../types/enums';

/**
 * One generic before/after measurement — deliberately not a hardcoded column per metric
 * name (PICKING_TIME, SLA_RISK_MINUTES, ...) so the Impact Engine can report whichever
 * metrics a given ActionType's simulation actually produced, without a schema change.
 */
export interface ImpactMetric {
  metric: string;
  before: number;
  after: number;
  unit: string;
}

/**
 * Business impact of one action, computed purely from its SimulationResult's before/after
 * state (src/actions/impact-engine.ts) — never a fabricated financial figure, since this
 * WMS schema carries no reliable cost data. Fields that don't apply to a given action's
 * metrics (e.g. no time-based metric was simulated) are null, not zero.
 */
export interface ActionImpact {
  actionId: string;
  metrics: ImpactMetric[];
  minutesSaved: number | null;
  percentageImprovement: number | null;
  slaRecovered: boolean | null;
  ordersAffected: number;
  tasksAffected: number;
  severityChange: { before: ExceptionSeverity; after: ExceptionSeverity | null } | null;
  /** Explicit caveats — e.g. "no quantitative metric available for ESCALATE_OPERATION". */
  notes: string[];
}
