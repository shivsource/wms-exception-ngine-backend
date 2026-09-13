import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class PackingDelayRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.PACKING_DELAY;

  async recommend(
    exception: PersistedException,
    evidenceRaw: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult> {
    const slaUrgent = isSlaUrgent(exception, evidenceRaw);
    const causeTypes = new Set(
      [rootCause?.primaryCause, ...(rootCause?.contributingCauses ?? [])].filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.type),
    );

    const candidates: ActionCandidateInput[] = [];

    if (causeTypes.has(ExceptionType.PICKING_DELAY)) {
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: 'Prioritize this order for packing',
          action: 'Prioritize this order in the packing queue once picking completes — a correlated picking delay was found on this order.',
          reason: 'The root cause analysis correlated a picking delay exception with this order.',
          targetCauseType: ExceptionType.PICKING_DELAY,
          expectedImpact: { metric: 'PACKING_DELAY', expectedOutcome: 'Reduce the compounding effect of the upstream picking delay.' },
        }),
      );
    }

    if (causeTypes.has('PACKING_QUEUE_BACKLOG')) {
      candidates.push(
        buildAction({
          actionType: 'ESCALATE',
          title: 'Escalate the packing backlog to a supervisor',
          action: 'Escalate the packing queue backlog to a supervisor — many other orders are also waiting on packing right now.',
          reason: 'The root cause analysis found a significant number of other orders also waiting on packing.',
          targetCauseType: 'PACKING_QUEUE_BACKLOG',
          expectedImpact: { metric: 'PACKING_DELAY', expectedOutcome: 'Address the underlying packing capacity/workload issue, not just this order.' },
        }),
      );
    }

    if (causeTypes.has('ORDER_COMPLEXITY')) {
      candidates.push(
        buildAction({
          actionType: 'MONITOR',
          title: 'Monitor — order size is a contributing factor',
          action: 'No direct intervention available; monitor given this order\'s high item count/quantity.',
          reason: 'Order complexity correlates with longer packing but is not independently actionable in this WMS model.',
          targetCauseType: 'ORDER_COMPLEXITY',
          expectedImpact: { metric: 'PACKING_DELAY', expectedOutcome: 'No specific improvement expected from this factor alone.' },
        }),
      );
    }

    if (candidates.length === 0) candidates.push(buildFallbackAction(exception, rootCause));

    const ranked = rankCandidates(candidates, rootCause, exception, slaUrgent);
    const [recommendation, ...alternativeRecommendations] = ranked;

    const limitations = [...(rootCause?.limitations ?? [])];
    if (!rootCause?.primaryCause) {
      limitations.push('No root cause was identified with sufficient confidence, so only an investigative action is recommended.');
    }
    limitations.push('No packing-error or damaged-package data exists for this order — no packing record has been created yet.');

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
