import { thresholds } from '../config/thresholds';
import {
  ApprovalLevel,
  CauseConfidence,
  PersistedException,
  RecommendationActionability,
  RecommendationActionType,
  RecommendationEvidenceItem,
  RecommendationRiskLevel,
  RecommendedAction,
  RootCauseAnalysis,
} from '../interfaces';
import { ExceptionSeverity } from '../types/enums';

/**
 * Working shape a recommender builds before scoring — everything needed to compute the 5
 * factors in scoreCandidateAction, plus the human-facing text. Kept internal to
 * src/recommendation/, mirroring root-cause/shared.ts's CandidateResult pattern.
 */
export interface ActionCandidateInput {
  actionType: RecommendationActionType;
  title: string;
  action: string;
  reason: string;
  /** Which root cause label (primary or contributing) this action addresses, or null for a
   *  generic/fallback action not tied to a specific cause. */
  targetCauseType: string | null;
  actionability: RecommendationActionability;
  riskLevel: RecommendationRiskLevel;
  riskDescription: string;
  approvalLevel: ApprovalLevel;
  approvalReason: string;
  expectedImpact: { metric: string; expectedOutcome: string };
  /** Whether this action's feasibility was confirmed against real WMS data (e.g. an alternate
   *  stock location actually has availability) rather than merely plausible. */
  operationalImpactConfirmed: boolean;
  supportingEvidence: RecommendationEvidenceItem[];
}

/** Per-actionType defaults for risk/approval/actionability — the same action always carries the
 *  same baseline operational weight regardless of which exception type triggered it. A recommender
 *  may override via `buildAction`'s `overrides` when a specific scenario genuinely differs. */
const ACTION_TYPE_DEFAULTS: Record<
  RecommendationActionType,
  { riskLevel: RecommendationRiskLevel; approvalLevel: ApprovalLevel; actionability: RecommendationActionability; riskDescription: string; approvalReason: string }
> = {
  VERIFY: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Confirming a data point does not change any WMS state.',
    approvalReason: 'Verification is read-only and does not modify WMS state.',
  },
  CHECK_INVENTORY: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Inspecting inventory records does not change any WMS state.',
    approvalReason: 'This is a read-only inventory check.',
  },
  CHECK_LOCATION: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'IMMEDIATE',
    riskDescription: 'A physical location check does not change any WMS state.',
    approvalReason: 'This is a read-only location check.',
  },
  REASSIGN: {
    riskLevel: 'MEDIUM',
    approvalLevel: 'RECOMMENDED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Changes the active picking/task assignment, affecting in-progress work.',
    approvalReason: 'Reassignment changes an active warehouse workflow.',
  },
  REPLENISH: {
    riskLevel: 'MEDIUM',
    approvalLevel: 'RECOMMENDED',
    actionability: 'PLANNED',
    riskDescription: 'Initiating replenishment commits warehouse resources ahead of confirmed need.',
    approvalReason: 'Replenishment has downstream cost/resourcing implications.',
  },
  PRIORITIZE: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Reordering existing work queues does not add new operational risk.',
    approvalReason: 'Reprioritizing already-queued work is a routine supervisory decision.',
  },
  RE_PICK: {
    riskLevel: 'MEDIUM',
    approvalLevel: 'RECOMMENDED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Re-picking repeats warehouse labor and may further delay the order.',
    approvalReason: 'Re-picking consumes additional labor and time on an already-affected order.',
  },
  RE_PACK: {
    riskLevel: 'MEDIUM',
    approvalLevel: 'RECOMMENDED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Re-packing repeats warehouse labor and may further delay dispatch.',
    approvalReason: 'Re-packing consumes additional labor and time on an already-affected order.',
  },
  ADJUST: {
    riskLevel: 'HIGH',
    approvalLevel: 'REQUIRED',
    actionability: 'PLANNED',
    riskDescription: 'Directly modifies inventory reservation data shared across other orders.',
    approvalReason: 'Adjusting reservation data can affect other orders drawing on the same stock.',
  },
  ESCALATE: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'IMMEDIATE',
    riskDescription: 'Notifying a supervisor does not itself change any WMS state.',
    approvalReason: 'Escalation is informational and does not modify WMS state.',
  },
  INVESTIGATE: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'INVESTIGATE',
    riskDescription: 'Manual review does not change any WMS state.',
    approvalReason: 'Investigation is read-only and does not modify WMS state.',
  },
  MONITOR: {
    riskLevel: 'LOW',
    approvalLevel: 'NOT_REQUIRED',
    actionability: 'MONITOR',
    riskDescription: 'No operational change is made; this is a wait-and-observe step.',
    approvalReason: 'Monitoring does not modify WMS state.',
  },
};

/** Builds a candidate with sensible actionType-based defaults, overridable per scenario. */
export function buildAction(params: {
  actionType: RecommendationActionType;
  title: string;
  action: string;
  reason: string;
  targetCauseType: string | null;
  expectedImpact: { metric: string; expectedOutcome: string };
  operationalImpactConfirmed?: boolean;
  supportingEvidence?: RecommendationEvidenceItem[];
  overrides?: Partial<{
    riskLevel: RecommendationRiskLevel;
    riskDescription: string;
    approvalLevel: ApprovalLevel;
    approvalReason: string;
    actionability: RecommendationActionability;
  }>;
}): ActionCandidateInput {
  const defaults = ACTION_TYPE_DEFAULTS[params.actionType];
  return {
    actionType: params.actionType,
    title: params.title,
    action: params.action,
    reason: params.reason,
    targetCauseType: params.targetCauseType,
    actionability: params.overrides?.actionability ?? defaults.actionability,
    riskLevel: params.overrides?.riskLevel ?? defaults.riskLevel,
    riskDescription: params.overrides?.riskDescription ?? defaults.riskDescription,
    approvalLevel: params.overrides?.approvalLevel ?? defaults.approvalLevel,
    approvalReason: params.overrides?.approvalReason ?? defaults.approvalReason,
    expectedImpact: params.expectedImpact,
    operationalImpactConfirmed: params.operationalImpactConfirmed ?? false,
    supportingEvidence: params.supportingEvidence ?? [],
  };
}

/** The always-available fallback — used whenever no stronger candidate applies, and whenever
 *  root cause is null/INSUFFICIENT_EVIDENCE (per the "never invent a confident action" rule). */
export function buildFallbackAction(exception: PersistedException, rootCause: RootCauseAnalysis | null): ActionCandidateInput {
  const hasAnySignal = !!rootCause?.primaryCause;
  return buildAction({
    actionType: hasAnySignal ? 'INVESTIGATE' : 'MONITOR',
    title: hasAnySignal ? 'Investigate further before acting' : 'Monitor — no actionable signal yet',
    action: hasAnySignal
      ? 'Manually review the identified contributing signals before taking an operational action.'
      : 'No supported root cause was identified; continue monitoring for recurrence or additional evidence.',
    reason: hasAnySignal
      ? 'Root cause confidence is too low to justify a stronger operational action.'
      : 'No root cause evidence is currently available for this exception.',
    targetCauseType: null,
    expectedImpact: {
      metric: exception.type,
      expectedOutcome: 'Gather enough evidence to support a confident operational recommendation.',
    },
  });
}

/** Whether this order's dispatch timing makes urgency-boosting actions (e.g. PRIORITIZE) more
 *  appropriate than slower ones (e.g. REPLENISH) — reads fields already present on several
 *  evidence shapes (SlaAtRiskEvidence, etc.) rather than issuing a new query. */
export function isSlaUrgent(exception: PersistedException, evidence: Record<string, unknown> | null): boolean {
  if (exception.severity === ExceptionSeverity.CRITICAL) return true;
  const order = (evidence as { order?: { minutesRemaining?: number; breached?: boolean } } | null)?.order;
  if (order?.breached) return true;
  if (typeof order?.minutesRemaining === 'number' && order.minutesRemaining <= thresholds.recommendation.slaUrgentMinutesRemaining) {
    return true;
  }
  return false;
}

/** The confidence a recommendation is reported with — always the root cause's own confidence,
 *  never invented higher. Falls back to LOW (not INSUFFICIENT_EVIDENCE) because a recommendation
 *  is always produced, even in the worst case. */
export function recommendationConfidence(rootCause: RootCauseAnalysis | null): CauseConfidence {
  return rootCause?.primaryCause?.confidenceLevel ?? 'LOW';
}

function derivePriority(exception: PersistedException, candidate: ActionCandidateInput): ExceptionSeverity {
  if (candidate.actionability === 'MONITOR') return ExceptionSeverity.LOW;
  if (candidate.actionability === 'INVESTIGATE') {
    return exception.severity === ExceptionSeverity.CRITICAL ? ExceptionSeverity.MEDIUM : ExceptionSeverity.LOW;
  }
  return exception.severity;
}

/**
 * The shared 5-factor, 100-point scoring rubric (thresholds.recommendation.weights): root cause
 * match, evidence support, SLA impact, operational impact, and operational risk. Every recommender
 * uses this exact function — nothing invents its own scoring math.
 */
export function scoreCandidateAction(
  candidate: ActionCandidateInput,
  rootCause: RootCauseAnalysis | null,
  exception: PersistedException,
  slaUrgent: boolean,
): { score: number; breakdown: RecommendationEvidenceItem[] } {
  const w = thresholds.recommendation.weights;
  const breakdown: RecommendationEvidenceItem[] = [];
  let score = 0;

  let matchScore: number = w.genericFallback;
  let matchReason = 'This is a generic fallback action, not tied to a specific identified cause.';
  if (candidate.targetCauseType && rootCause?.primaryCause?.type === candidate.targetCauseType) {
    matchScore = w.rootCauseMatch;
    matchReason = `Directly addresses the primary root cause (${candidate.targetCauseType}).`;
  } else if (candidate.targetCauseType && rootCause?.contributingCauses.some((c) => c.type === candidate.targetCauseType)) {
    matchScore = w.contributingCauseMatch;
    matchReason = `Addresses a contributing cause (${candidate.targetCauseType}), not the primary one.`;
  } else if (!candidate.targetCauseType && slaUrgent && candidate.actionability === 'IMMEDIATE') {
    // A generic (not cause-specific) action that acts immediately IS the relevant thing to do
    // when the SLA is genuinely urgent — this is what lets PRIORITIZE outscore a slower fix like
    // REPLENISH when dispatch is imminent, per the "protect SLA first" rule.
    matchScore = w.rootCauseMatch;
    matchReason = 'Directly protects the at-risk SLA, the immediate operational priority right now.';
  }
  score += matchScore;
  breakdown.push({ field: 'rootCauseMatch', value: matchScore, reason: matchReason });

  const confidence = rootCause?.primaryCause?.confidenceLevel ?? 'INSUFFICIENT_EVIDENCE';
  const evidenceScore = confidence === 'HIGH' ? w.evidenceHigh : confidence === 'MEDIUM' ? w.evidenceMedium : confidence === 'LOW' ? w.evidenceLow : 0;
  score += evidenceScore;
  breakdown.push({ field: 'evidenceSupport', value: evidenceScore, reason: `Root cause confidence is ${confidence}.` });

  const slaScore = slaUrgent
    ? w.slaUrgent
    : exception.severity === ExceptionSeverity.CRITICAL || exception.severity === ExceptionSeverity.HIGH
      ? w.slaSeverity
      : 0;
  score += slaScore;
  breakdown.push({
    field: 'slaImpact',
    value: slaScore,
    reason: slaUrgent ? 'Order dispatch is imminent or already breached.' : `Exception severity is ${exception.severity}.`,
  });

  const opScore = candidate.operationalImpactConfirmed ? w.operationalConfirmed : w.operationalPlausible;
  score += opScore;
  breakdown.push({
    field: 'operationalImpact',
    value: opScore,
    reason: candidate.operationalImpactConfirmed
      ? 'Feasibility was confirmed against current WMS data.'
      : 'Plausible but not confirmed against live WMS data.',
  });

  const riskScore = candidate.riskLevel === 'LOW' ? w.riskLow : candidate.riskLevel === 'MEDIUM' ? w.riskMedium : 0;
  score += riskScore;
  breakdown.push({ field: 'operationalRisk', value: riskScore, reason: `Action risk classified as ${candidate.riskLevel}.` });

  return { score, breakdown };
}

/** Converts a scored candidate into the public RecommendedAction shape. */
export function toRecommendedAction(
  candidate: ActionCandidateInput,
  rootCause: RootCauseAnalysis | null,
  score: number,
  breakdown: RecommendationEvidenceItem[],
  exception: PersistedException,
): RecommendedAction {
  return {
    actionType: candidate.actionType,
    title: candidate.title,
    action: candidate.action,
    priority: derivePriority(exception, candidate),
    actionability: candidate.actionability,
    score,
    confidenceLevel: recommendationConfidence(rootCause),
    reason: candidate.reason,
    supportingEvidence: [...candidate.supportingEvidence, ...breakdown],
    expectedImpact: candidate.expectedImpact,
    risk: { level: candidate.riskLevel, description: candidate.riskDescription },
    approval: { level: candidate.approvalLevel, reason: candidate.approvalReason },
  };
}

/** Scores and ranks every candidate, guaranteeing at least the fallback survives — the one place
 *  every recommender calls to go from raw candidates to a final (primary, alternatives) pair. */
export function rankCandidates(
  candidates: ActionCandidateInput[],
  rootCause: RootCauseAnalysis | null,
  exception: PersistedException,
  slaUrgent: boolean,
): RecommendedAction[] {
  const pool = candidates.length > 0 ? candidates : [buildFallbackAction(exception, rootCause)];
  const scored = pool.map((candidate) => {
    const { score, breakdown } = scoreCandidateAction(candidate, rootCause, exception, slaUrgent);
    return toRecommendedAction(candidate, rootCause, score, breakdown, exception);
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
