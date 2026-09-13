import { ExceptionType } from '../types/enums';
import { PersistedException } from './persisted-exception.interface';
import { RecommendationResult } from './recommendation.interface';
import { RootCauseAnalysis } from './root-cause-analysis.interface';

/**
 * Contract every per-type recommendation analyzer must implement. Mirrors RootCauseAnalyzer's
 * shape, but takes the exception's evidence AND its root cause analysis as input — recommendations
 * are driven primarily by rootCause.primaryCause/contributingCauses, not by exceptionType alone.
 */
export interface RecommendationAnalyzer {
  /** The exception type this analyzer produces recommendations for. */
  readonly exceptionType: ExceptionType;

  /** Scores candidate actions against the root cause (and, where useful, the exception's own
   *  structured evidence) and returns the ranked result. Never executes anything. */
  recommend(
    exception: PersistedException,
    evidence: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult>;
}
