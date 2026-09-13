import { ExceptionType } from '../types/enums';
import { PersistedException } from './persisted-exception.interface';

/**
 * Contract every per-type explanation generator must implement. Pure deterministic
 * templating over structured evidence — no LLM calls, no inference beyond what the
 * evidence already states (no root cause, no recommendation, no prediction).
 */
export interface ExplanationGenerator {
  /** The exception type this generator produces narrative text for. */
  readonly exceptionType: ExceptionType;

  /** Renders the evidence into a human-readable narrative. */
  explain(exception: PersistedException, evidence: Record<string, unknown>): string;
}
