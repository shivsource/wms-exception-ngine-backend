import { MockLogisticsDataSourceSeed } from '../adapters/mock';
import { EntityType, ExceptionSeverity, ExceptionType, PredictionType, RiskLevel } from '../types/enums';
import { PredictionConfidence, PredictionWindow, RiskSignal } from '../interfaces';

/**
 * Prediction Validation / Backtesting framework — types.
 *
 * This module is an EVALUATION LAYER around the existing Prediction Engine
 * (src/engine/prediction-engine.ts) and Exception Engine (src/engine/exception-engine.ts).
 * It introduces zero new prediction/detection logic: it simulates operational state
 * progressing over time, runs the real engines against that state at each simulated
 * timestamp, and compares what the Prediction Engine said would happen against what the
 * Exception Engine later actually detected. See ARCHITECTURE.md's layering for why the
 * intelligence layer never appears here directly — only the two orchestrating engines and
 * MockLogisticsDataSource (already the proven DB-free implementation of LogisticsDataSource).
 */

/** Every possible outcome of comparing one prediction against what actually happened.
 *  Mirrors the definitions given in the validation brief (Section 9) exactly. */
export type ValidationResult =
  | 'TRUE_POSITIVE'
  | 'FALSE_POSITIVE'
  | 'FALSE_NEGATIVE'
  | 'TRUE_NEGATIVE'
  | 'NOT_MEASURABLE'
  | 'CONFIRMED_BEFORE_PREDICTION'
  | 'PENDING';

/** Warning-time quality band for a TRUE_POSITIVE prediction — validation-only thresholds,
 *  never business/prediction thresholds (see validation-config.ts). */
export type WarningQuality = 'EXCELLENT' | 'GOOD' | 'LIMITED' | 'TOO_LATE' | 'NOT_APPLICABLE';

/** One point in simulated time. `state` is applied on top of whatever the previous step left
 *  in MockLogisticsDataSource (mirrors its own `.seed()` semantics: only the arrays you
 *  provide are replaced — arrays you omit simply carry forward unchanged), so a step only
 *  needs to describe what actually changed at that instant, not the whole world every time.
 *  The simulation engine fully clears every array before a scenario's first step, so nothing
 *  ever leaks in from a previous scenario or from later in this scenario's own timeline
 *  (Section 22/23 — no future-data leakage). */
export interface TimelineStep {
  /** Minutes after the scenario's t0 anchor. May be fractional (e.g. 0.5 = 30 seconds). */
  offsetMinutes: number;
  label: string;
  state: MockLogisticsDataSourceSeed;
}

/** One (predictionType, entity) pair this scenario evaluates against the shared timeline.
 *  Almost every scenario has exactly one target; SCENARIO 10 (multiple simultaneous risks)
 *  has several, evaluated and reported independently per Section "27/10" of the brief. */
export interface ValidationTarget {
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  expectedResult: ValidationResult;
}

/** Pre-seeds an exception as already OPEN before the simulation's first engine run —
 *  used only by the CONFIRMED_BEFORE_PREDICTION scenario. */
export interface PreExistingException {
  type: ExceptionType;
  entityType: EntityType;
  entityId: string;
  severity: ExceptionSeverity;
  detectedAtOffsetMinutes: number;
}

export interface PredictionValidationScenario {
  scenarioId: string;
  name: string;
  description: string;
  /** Fixed anchor instant every `offsetMinutes` in this scenario is relative to — a literal
   *  constant, never `new Date()`, so the whole suite is deterministic (Section 21). */
  t0: Date;
  targets: ValidationTarget[];
  timeline: TimelineStep[];
  preExistingExceptions?: PreExistingException[];
  /** SCENARIO 12 (INSUFFICIENT_DATA): calls predictor.evaluateOne(entityId) directly instead
   *  of running the engines — evaluateAll() candidate filters would never surface such an
   *  entity in the first place (see PickingDelayPredictor/SlaBreachPredictor evaluateOne). */
  insufficientDataEntityId?: string;
  /** SCENARIO 13 (IDEMPOTENCY): after the last timeline step, re-run both engines twice more
   *  at the same simulated instant with no state change, and assert no duplicate rows. */
  verifyIdempotencyAtEnd?: boolean;
}

/** The prediction as first observed, preserved verbatim — see Section 6/28 of the brief:
 *  "do not regenerate the prediction later and overwrite the original." `predictedAt` is the
 *  EARLIEST timestamp this (predictionType, entity) pair was persisted as ACTIVE/CONFIRMED
 *  with at least MEDIUM risk (the "episode" concept, Section 27/28) — never the live row's
 *  own `predictedAt`, which the real engine legitimately bumps forward on every re-evaluation. */
export interface PredictionSnapshot {
  predictionId: string;
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  predictedAt: Date;
  riskScore: number | null;
  riskLevel: RiskLevel;
  highestRiskScore: number | null;
  confidence: PredictionConfidence | null;
  predictionWindow: PredictionWindow | null;
  signals: RiskSignal[];
  explanation: string;
  /** Final status this (predictionType, entity) episode reached by the end of the timeline. */
  finalStatus: 'ACTIVE' | 'CONFIRMED' | 'RESOLVED';
  confirmedExceptionId: string | null;
  observationCount: number;
}

export interface ExceptionSnapshot {
  exceptionId: string;
  type: ExceptionType;
  entityType: EntityType;
  entityId: string;
  detectedAt: Date;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  targetIndex: number;
  predictionType: PredictionType;
  entityType: EntityType;
  entityId: string;
  prediction: PredictionSnapshot | null;
  actualOutcome: {
    exceptionOccurred: boolean;
    exceptionType: ExceptionType | null;
    exceptionTimestamp: Date | null;
    exceptionId: string | null;
  };
  validation: {
    result: ValidationResult;
    warningTimeMinutes: number | null;
    warningQuality: WarningQuality;
  };
  expectedResult: ValidationResult;
  passed: boolean;
  idempotencyPassed: boolean | null;
}
