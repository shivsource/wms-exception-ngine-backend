import { CauseConfidence, CauseOrigin } from './root-cause-analysis.interface';
import { ExceptionSeverity, ExceptionType } from '../types/enums';

/**
 * Result shapes produced by the Recommendation Engine (src/recommendation/). Answers
 * "WHAT SHOULD THE OPERATIONS TEAM DO?" by scoring candidate actions against the output
 * of the Root Cause Engine (src/root-cause/) — it never re-derives root cause or evidence,
 * and it never executes anything; only a future Action Engine will.
 */

/** Small, fixed taxonomy — every value here must be traceable to at least one real root
 *  cause label an existing RootCauseAnalyzer can actually produce (see recommendation/shared.ts). */
export type RecommendationActionType =
  | 'VERIFY'
  | 'CHECK_INVENTORY'
  | 'CHECK_LOCATION'
  | 'REASSIGN'
  | 'REPLENISH'
  | 'PRIORITIZE'
  | 'RE_PICK'
  | 'RE_PACK'
  | 'ADJUST'
  | 'ESCALATE'
  | 'INVESTIGATE'
  | 'MONITOR';

export type RecommendationActionability = 'IMMEDIATE' | 'PLANNED' | 'INVESTIGATE' | 'MONITOR';
export type RecommendationRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Whether human approval would be required IF this were automated by a future Action Engine.
 *  The current engine never executes anything regardless of this value. */
export type ApprovalLevel = 'NOT_REQUIRED' | 'RECOMMENDED' | 'REQUIRED';

/** One atomic fact backing an action — either domain evidence or a scoring-factor explanation. */
export interface RecommendationEvidenceItem {
  field: string;
  value: unknown;
  reason: string;
}

export interface RecommendedAction {
  actionType: RecommendationActionType;
  title: string;
  action: string;
  /** Reuses the existing ExceptionSeverity enum rather than inventing a parallel priority type. */
  priority: ExceptionSeverity;
  actionability: RecommendationActionability;
  /** 0-100, additive, the sum of the 5 named scoring factors — see scoreCandidateAction. */
  score: number;
  /** Reuses RootCause's own confidence type. Equals the root cause's confidence, never higher. */
  confidenceLevel: CauseConfidence;
  reason: string;
  supportingEvidence: RecommendationEvidenceItem[];
  /** Qualitative only — never a claimed percentage/monetary figure the data can't support. */
  expectedImpact: { metric: string; expectedOutcome: string };
  risk: { level: RecommendationRiskLevel; description: string };
  approval: { level: ApprovalLevel; reason: string };
}

/** Pointer back to the driving root cause — not a duplicate of the full RootCauseAnalysis. */
export interface RecommendationRootCauseSummary {
  type: string;
  category: CauseOrigin;
  confidenceLevel: CauseConfidence;
}

export interface RecommendationResult {
  exceptionId: string;
  exceptionType: ExceptionType;
  /** Null only when root cause analysis itself was unavailable (no evidence at all). */
  rootCause: RecommendationRootCauseSummary | null;
  /** Unlike RootCauseAnalysis.primaryCause, this is NEVER null — operations always needs some
   *  guidance, so the worst case is a low-risk INVESTIGATE/MONITOR fallback, not an absent field. */
  recommendation: RecommendedAction;
  alternativeRecommendations: RecommendedAction[];
  limitations: string[];
  analyzedAt: Date;
}
