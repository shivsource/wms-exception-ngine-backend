import { ExceptionType } from '../types/enums';

/**
 * Result shapes produced by the Root Cause Engine (src/root-cause/). Answers "WHY did
 * this happen?" by scoring candidate causes against evidence already gathered by the
 * Evidence layer (src/evidence/) plus sibling exceptions already persisted in the
 * `exceptions` table — it never re-derives evidence and never invents a cause that
 * scored zero.
 */

/** Whether a cause is a fact directly read off the evidence, or a projection inferred from it. */
export type CauseOrigin = 'OBSERVED' | 'INFERRED';

/** HIGH/MEDIUM/LOW are score bands for a candidate that scored above zero; INSUFFICIENT_EVIDENCE
 *  is reserved for the whole analysis when no candidate scored above zero at all. */
export type CauseConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_EVIDENCE';

/** One atomic fact that contributed points to a candidate cause's score. */
export interface SupportingEvidenceItem {
  /** Dotted path into evidence/correlated data this fact was read from. */
  field: string;
  value: unknown;
  /** Points this fact contributed toward `supports`'s score. */
  weight: number;
  /** Which candidate cause type this fact backs. */
  supports: string;
}

/** A single scored, ranked root-cause candidate. */
export interface RootCause {
  /** An ExceptionType value for causes backed by a sibling exception, or a root-cause-only
   *  label (e.g. 'PICKER_OVERLOAD') for signals that have no corresponding exception type. */
  type: string;
  category: CauseOrigin;
  /** 0-100, the sum of every matched scoring rule for this candidate. */
  score: number;
  confidenceLevel: CauseConfidence;
  /** Deterministic template explanation, built from the same facts as supportingEvidence. */
  explanation: string;
}

/** One hop in the causal graph: `from` is believed to cause `to`, for a stated reason. */
export interface CausalChainLink {
  from: string;
  to: string;
  relationship: string;
}

export interface RootCauseAnalysis {
  exceptionId: string;
  exceptionType: ExceptionType;
  /** Highest-scoring candidate, or null if every candidate scored zero. */
  primaryCause: RootCause | null;
  /** Remaining candidates that scored above zero, sorted descending by score. */
  contributingCauses: RootCause[];
  /** Union of every supporting fact across primaryCause and contributingCauses. */
  supportingEvidence: SupportingEvidenceItem[];
  /** Only ever built from OBSERVED causes — an inferred cause is never asserted as a causal link. */
  causalChain: CausalChainLink[];
  /** Explicit caveats: signals that couldn't be evaluated, or why confidence is capped. */
  limitations: string[];
  analysisExplanation: string;
  analyzedAt: Date;
}
