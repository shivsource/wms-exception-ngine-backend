import { ExceptionType } from '../types/enums';
import { PersistedException } from './persisted-exception.interface';
import { RootCauseAnalysis } from './root-cause-analysis.interface';

/**
 * Contract every per-type root cause analyzer must implement. Mirrors ExplanationGenerator's
 * (exception, evidence) shape, but async: unlike a narrative template, root-causing requires
 * correlating against sibling exceptions and other repository state beyond the exception's
 * own structured evidence.
 */
export interface RootCauseAnalyzer {
  /** The exception type this analyzer determines root causes for. */
  readonly exceptionType: ExceptionType;

  /** Scores candidate causes against structured evidence (from EvidenceService) and correlated
   *  repository state, and returns the ranked result. Never invents a cause with no supporting evidence. */
  analyze(exception: PersistedException, evidence: Record<string, unknown>): Promise<RootCauseAnalysis>;
}
