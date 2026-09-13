import { Action } from './action.interface';
import { PersistedException } from './persisted-exception.interface';
import { ActionType } from '../types/enums';

/**
 * Output of one simulator run. `before`/`after` are plain operational-state snapshots
 * (shape is actionType-specific) built from real, current WMS data plus deterministic
 * business logic — never randomly generated. `changes` is the diff a human/UI would want
 * to show directly (e.g. { pickerId: { from: 'PICKER-1', to: 'PICKER-2' } }).
 */
export interface SimulationResult {
  success: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changes: Record<string, unknown>;
  /** Explicit caveats — e.g. why no alternate picker was available, so the sim used a no-op result. */
  notes: string[];
}

/**
 * Contract every per-ActionType simulator must implement. Mirrors ExceptionRule/
 * RecommendationAnalyzer's shape. Never mutates the source WMS — simulate() only reads
 * current state (via logisticsDataSource) and projects a deterministic after-state.
 */
export interface ActionSimulator {
  readonly actionType: ActionType;
  simulate(action: Action, exception: PersistedException): Promise<SimulationResult>;
}
