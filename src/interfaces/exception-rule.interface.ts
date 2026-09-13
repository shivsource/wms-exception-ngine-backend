import { ExceptionType } from '../types/enums';
import { DetectedException } from './detected-exception.interface';

/**
 * Contract every exception rule must implement. The engine (Step 7) discovers and
 * runs rules purely through this interface — it never knows about SQL or specific
 * business logic, and a rule never touches the database directly (repositories do).
 */
export interface ExceptionRule {
  /** Stable, human-readable identifier used in logs (e.g. "InventoryShortageRule"). */
  readonly name: string;

  /** The exception type this rule produces. */
  readonly exceptionType: ExceptionType;

  evaluate(): Promise<DetectedException[]>;
}
