import { EntityType, PredictionType } from '../types/enums';
import { PredictionEvaluationResult } from './prediction.interface';

/**
 * Contract every risk predictor must implement. Mirrors ExceptionRule (src/interfaces/
 * exception-rule.interface.ts): the engine (src/engine/prediction-engine.ts) discovers and
 * runs predictors purely through this interface, never through SQL or type-specific logic.
 */
export interface RiskPredictor {
  /** Stable, human-readable identifier used in logs (e.g. "SlaBreachPredictor"). */
  readonly name: string;

  readonly predictionType: PredictionType;

  /** The kind of entity this predictor evaluates (e.g. ORDER, PICKING_TASK, PRODUCT). */
  readonly entityType: EntityType;

  /** Evaluates every current candidate entity — used by the engine's full run (POST /predictions/evaluate). */
  evaluateAll(): Promise<PredictionEvaluationResult[]>;

  /**
   * Evaluates exactly one entity by id, regardless of whether it's currently a "candidate" —
   * used by the manual single-entity endpoint. Never throws for a not-found/not-applicable
   * entity; returns an INSUFFICIENT_DATA result with a clear reason instead.
   */
  evaluateOne(entityId: string): Promise<PredictionEvaluationResult>;
}
