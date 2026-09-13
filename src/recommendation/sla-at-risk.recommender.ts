import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

/** Per-primary-cause candidate action for SLA_AT_RISK — one entry per real cause label the
 *  SlaAtRiskAnalyzer's fixed PIPELINE_ORDER can produce. */
const UPSTREAM_CAUSE_ACTIONS: Partial<Record<string, { actionType: 'REPLENISH' | 'VERIFY' | 'RE_PICK' | 'REASSIGN' | 'PRIORITIZE' | 'ESCALATE'; title: string; action: string; reason: string }>> = {
  INVENTORY_SHORTAGE: {
    actionType: 'REPLENISH',
    title: 'Address the upstream inventory shortage',
    action: 'Initiate replenishment or reassign to an alternate location for the short SKU driving this SLA risk.',
    reason: 'The root cause chain traces this SLA risk back to an inventory shortage, its earliest supported cause.',
  },
  INVENTORY_DISCREPANCY: {
    actionType: 'VERIFY',
    title: 'Verify inventory at the discrepant location',
    action: 'Verify the physical inventory record at the location correlated with this SLA risk.',
    reason: 'The root cause chain traces this SLA risk back to an inventory discrepancy, its earliest supported cause.',
  },
  PICKING_ERROR: {
    actionType: 'RE_PICK',
    title: 'Resolve the upstream picking error',
    action: 'Initiate a controlled re-pick for the item(s) affected by the correlated picking error.',
    reason: 'The root cause chain traces this SLA risk back to a picking error, its earliest supported cause.',
  },
  EXCESSIVE_PICKER_DISTANCE: {
    actionType: 'REASSIGN',
    title: 'Reassign the affected picking task',
    action: 'Reassign the picking task to reduce travel distance and speed up completion.',
    reason: 'The root cause chain traces this SLA risk back to excessive picker distance.',
  },
  EXCESSIVE_PICKING_TIME: {
    actionType: 'REASSIGN',
    title: 'Reassign or expedite the slow picking task',
    action: 'Reassign or expedite the picking task that is running well above the warehouse average.',
    reason: 'The root cause chain traces this SLA risk back to excessive picking time.',
  },
  PICKING_DELAY: {
    actionType: 'PRIORITIZE',
    title: 'Prioritize the affected picking task',
    action: 'Prioritize the affected picking task ahead of other queued work.',
    reason: 'The root cause chain traces this SLA risk back to a picking delay.',
  },
  PACKING_DELAY: {
    actionType: 'PRIORITIZE',
    title: 'Prioritize this order for packing',
    action: 'Prioritize this order in the packing queue ahead of other waiting orders.',
    reason: 'The root cause chain traces this SLA risk back to a packing delay.',
  },
  DISPATCH_DELAY: {
    actionType: 'ESCALATE',
    title: 'Escalate the dispatch delay',
    action: 'Escalate to the dispatch supervisor — this order is packed but not yet departed.',
    reason: 'The root cause chain traces this SLA risk back to a dispatch delay.',
  },
};

export class SlaAtRiskRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.SLA_AT_RISK;

  async recommend(
    exception: PersistedException,
    evidenceRaw: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult> {
    const slaUrgent = isSlaUrgent(exception, evidenceRaw);
    const candidates: ActionCandidateInput[] = [];

    // 1. Protect SLA first — always offered when the order is genuinely urgent, independent of
    // whether an upstream cause was found, per the "protect SLA before addressing root cause" rule.
    if (slaUrgent) {
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: 'Prioritize this order immediately',
          action: 'Prioritize this order for immediate processing across whichever stage it is currently stuck in.',
          reason: 'The order is at imminent risk of, or has already breached, its dispatch SLA.',
          targetCauseType: null,
          expectedImpact: { metric: 'SLA_AT_RISK', expectedOutcome: 'Improve the probability of meeting or minimizing the breach of the dispatch SLA.' },
          overrides: { riskLevel: 'LOW', approvalLevel: 'NOT_REQUIRED' },
        }),
      );
    }

    // 2. Address the earliest supported upstream cause.
    const primaryType = rootCause?.primaryCause?.type;
    const template = primaryType ? UPSTREAM_CAUSE_ACTIONS[primaryType] : undefined;
    if (template) {
      candidates.push(
        buildAction({
          actionType: template.actionType,
          title: template.title,
          action: template.action,
          reason: template.reason,
          targetCauseType: primaryType!,
          expectedImpact: { metric: 'SLA_AT_RISK', expectedOutcome: 'Resolve the earliest upstream cause and protect the dispatch SLA.' },
        }),
      );
    }

    if (candidates.length === 0) candidates.push(buildFallbackAction(exception, rootCause));

    const ranked = rankCandidates(candidates, rootCause, exception, slaUrgent);
    const [recommendation, ...alternativeRecommendations] = ranked;

    const limitations = [...(rootCause?.limitations ?? [])];
    if (!rootCause?.primaryCause) {
      limitations.push('No upstream cause was identified with sufficient confidence in the fulfillment pipeline.');
    }

    return {
      exceptionId: exception.exceptionId,
      exceptionType: exception.type,
      rootCause: rootCause?.primaryCause
        ? { type: rootCause.primaryCause.type, category: rootCause.primaryCause.category, confidenceLevel: rootCause.primaryCause.confidenceLevel }
        : null,
      recommendation,
      alternativeRecommendations,
      limitations,
      analyzedAt: new Date(),
    };
  }
}
