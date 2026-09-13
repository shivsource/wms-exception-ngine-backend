import { ExceptionType } from '../types/enums';
import { PersistedException } from './persisted-exception.interface';

/**
 * Contract every per-type evidence collector must implement. Mirrors ExceptionRule:
 * the registry (src/evidence/index.ts) discovers collectors purely through this
 * interface, so the EvidenceService never needs to know which repositories or SQL
 * a given exception type requires.
 */
export interface EvidenceCollector {
  /** The exception type this collector gathers supporting evidence for. */
  readonly exceptionType: ExceptionType;

  /** Returns structured evidence for the given exception, or null if none could be gathered. */
  collect(exception: PersistedException): Promise<Record<string, unknown> | null>;
}
