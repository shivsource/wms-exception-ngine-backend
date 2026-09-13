import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class DispatchDelayRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.DISPATCH_DELAY;

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

    if (causeTypes.has(ExceptionType.PACKING_DELAY) || causeTypes.has(ExceptionType.PICKING_DELAY)) {
      const upstream = causeTypes.has(ExceptionType.PACKING_DELAY) ? ExceptionType.PACKING_DELAY : ExceptionType.PICKING_DELAY;
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: `Prioritize the upstream ${upstream === ExceptionType.PACKING_DELAY ? 'packing' : 'picking'} delay`,
          action: `Prioritize resolving the correlated ${upstream === ExceptionType.PACKING_DELAY ? 'packing' : 'picking'} delay on this order — dispatch cannot proceed until it clears.`,
          reason: `The root cause analysis correlated a ${upstream} exception with this order.`,
          targetCauseType: upstream,
          expectedImpact: { metric: 'DISPATCH_DELAY', expectedOutcome: 'Clear the upstream blocker so dispatch can proceed.' },
        }),
      );
    }

    if (causeTypes.has('LOADING_DELAY')) {
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: 'Prioritize departure for this loaded order',
          action: 'Prioritize this order for departure — it is already loaded but has not yet departed.',
          reason: 'The root cause analysis found a dispatch record showing this order was loaded but never departed.',
          targetCauseType: 'LOADING_DELAY',
          expectedImpact: { metric: 'DISPATCH_DELAY', expectedOutcome: 'Reduce dispatch delay and protect carrier departure.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'ESCALATE',
          title: 'Escalate the stalled departure',
          action: 'Escalate to the dock supervisor — this order has been loaded and waiting to depart for an extended time.',
          reason: 'A loaded-but-not-departed order past the expected window warrants supervisory attention.',
          targetCauseType: 'LOADING_DELAY',
          expectedImpact: { metric: 'DISPATCH_DELAY', expectedOutcome: 'Surface the stalled departure sooner to limit further delay.' },
        }),
      );
    }

    if (causeTypes.has('DOCK_CONGESTION')) {
      candidates.push(
        buildAction({
          actionType: 'ESCALATE',
          title: 'Escalate dock congestion',
          action: 'Escalate to the dock supervisor — multiple other orders are also waiting to depart from the same dock.',
          reason: 'The root cause analysis found several other orders also waiting at the same dock.',
          targetCauseType: 'DOCK_CONGESTION',
          expectedImpact: { metric: 'DISPATCH_DELAY', expectedOutcome: 'Address the shared dock bottleneck, not just this order.' },
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
    limitations.push(
      'This schema has no truck-schedule or carrier-SLA data, so CONTACT_CARRIER/RESCHEDULE actions are never recommended without carrier-related evidence.',
    );

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
