export enum ExceptionSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum ExceptionStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  IGNORED = 'IGNORED',
}

/** The 10 initial rule-based exception types. Adding a new rule means adding one entry here. */
export enum ExceptionType {
  INVENTORY_SHORTAGE = 'INVENTORY_SHORTAGE',
  INVENTORY_DISCREPANCY = 'INVENTORY_DISCREPANCY',
  PICKING_DELAY = 'PICKING_DELAY',
  PICKING_ERROR = 'PICKING_ERROR',
  EXCESSIVE_PICKING_TIME = 'EXCESSIVE_PICKING_TIME',
  EXCESSIVE_PICKER_DISTANCE = 'EXCESSIVE_PICKER_DISTANCE',
  SLA_AT_RISK = 'SLA_AT_RISK',
  PACKING_DELAY = 'PACKING_DELAY',
  DISPATCH_DELAY = 'DISPATCH_DELAY',
  HIGH_RETURN_RATE = 'HIGH_RETURN_RATE',
}

/** The kind of WMS entity a detected exception is attached to (entity_id refers to this). */
export enum EntityType {
  ORDER = 'ORDER',
  ORDER_ITEM = 'ORDER_ITEM',
  PICKING_TASK = 'PICKING_TASK',
  PICKER = 'PICKER',
  PRODUCT = 'PRODUCT',
  INVENTORY = 'INVENTORY',
  PACKING = 'PACKING',
  DISPATCH = 'DISPATCH',
}

/**
 * Concrete operational interventions the Action Engine can create and simulate — a small,
 * closed taxonomy derived directly from the RecommendationActionType values existing
 * recommenders actually produce (see recommendation/shared.ts and src/actions/action-mapper.ts).
 * Every value here has a deterministic Simulator (src/actions/simulators/). Recommendation
 * verbs that have no deterministic operational state to simulate (VERIFY on a non-discrepancy
 * cause, RE_PICK, RE_PACK, ADJUST, INVESTIGATE, MONITOR, CHECK_LOCATION) never produce an
 * ActionType — see action-mapper.ts's RECOMMENDATION_ONLY reasons.
 */
export enum ActionType {
  REASSIGN_PICKER = 'REASSIGN_PICKER',
  MOVE_INVENTORY = 'MOVE_INVENTORY',
  REPLENISH_INVENTORY = 'REPLENISH_INVENTORY',
  RECHECK_INVENTORY = 'RECHECK_INVENTORY',
  PRIORITIZE_ORDER = 'PRIORITIZE_ORDER',
  ESCALATE_OPERATION = 'ESCALATE_OPERATION',
}

/** Lifecycle of one Action, from proposal through terminal execution state. */
export enum ActionStatus {
  PROPOSED = 'PROPOSED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXECUTING = 'EXECUTING',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/** What actually happened after an action executed, derived deterministically from impact (see src/actions/outcome-engine.ts). */
export enum OutcomeResult {
  SUCCESS = 'SUCCESS',
  PARTIAL_SUCCESS = 'PARTIAL_SUCCESS',
  NO_IMPROVEMENT = 'NO_IMPROVEMENT',
  FAILED = 'FAILED',
}

/**
 * The 4 initial deterministic risk predictors (Prediction/Risk Scoring Engine — src/predictors/).
 * Deliberately distinct values from ExceptionType (never reuses e.g. "SLA_AT_RISK") so a
 * prediction and the exception it predicts can never be confused in code or in API responses —
 * see ARCHITECTURE.md's "Prediction vs exception detection" section. Adding a new predictor
 * means writing its class in src/predictors/ and adding one entry here, exactly like ExceptionType.
 */
export enum PredictionType {
  SLA_BREACH_RISK = 'SLA_BREACH_RISK',
  PICKING_DELAY_RISK = 'PICKING_DELAY_RISK',
  INVENTORY_SHORTAGE_RISK = 'INVENTORY_SHORTAGE_RISK',
  DISPATCH_DELAY_RISK = 'DISPATCH_DELAY_RISK',
}

/**
 * 0-100 risk score classified into a band (see thresholds.prediction.riskLevel). UNKNOWN is
 * reserved for INSUFFICIENT_DATA predictions — never inferred as LOW, since missing data is
 * not the same as zero risk.
 */
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Lifecycle of one Prediction. Deliberately minimal (see ARCHITECTURE.md): EXPIRED is folded
 * into RESOLVED (the risk window closed, whether because the condition cleared or time passed),
 * and FALSE_POSITIVE is omitted — judging a prediction's accuracy against what actually
 * happened is future evaluation/ML work, not something this deterministic engine can decide
 * about itself.
 */
export enum PredictionStatus {
  /** The predicted risk still applies and no matching exception has opened yet. */
  ACTIVE = 'ACTIVE',
  /** The exception this prediction warned about is now OPEN — the prediction is no longer
   *  "at risk of", it already happened. Never presented as an active prediction. */
  CONFIRMED = 'CONFIRMED',
  /** The entity no longer matches this predictor's at-risk criteria on re-evaluation
   *  (risk dissipated, or the entity moved past the relevant operational stage). */
  RESOLVED = 'RESOLVED',
}
