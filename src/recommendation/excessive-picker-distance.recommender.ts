import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class ExcessivePickerDistanceRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKER_DISTANCE;

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

    if (causeTypes.has('MULTI_LOCATION_ORDER')) {
      candidates.push(
        buildAction({
          actionType: 'REASSIGN',
          title: 'Reassign or split this task to reduce travel',
          action: 'Reassign this task, or split it across pickers by location zone, to reduce total travel distance.',
          reason: 'The root cause analysis found this task\'s items spread across an unusually high number of locations.',
          targetCauseType: 'MULTI_LOCATION_ORDER',
          expectedImpact: { metric: 'EXCESSIVE_PICKER_DISTANCE', expectedOutcome: 'Reduce travel distance for this and similarly spread-out tasks.' },
        }),
      );
    }

    if (causeTypes.has('POOR_LOCATION_ASSIGNMENT')) {
      candidates.push(
        buildAction({
          actionType: 'REASSIGN',
          title: 'Reassign this task to a different picker',
          action: 'Reassign this task to a different picker given this picker\'s recurring excessive-distance pattern.',
          reason: 'The root cause analysis found this picker has excessive-distance exceptions recorded on other tasks too.',
          targetCauseType: 'POOR_LOCATION_ASSIGNMENT',
          expectedImpact: { metric: 'EXCESSIVE_PICKER_DISTANCE', expectedOutcome: 'Reduce distance for this task without waiting on a wider process fix.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'ESCALATE',
          title: 'Escalate the recurring pattern to a supervisor',
          action: 'Flag this picker\'s recurring excessive-distance pattern to a supervisor for task-allocation review.',
          reason: 'A pattern across multiple tasks — not a single anomalous one — warrants a supervisory review.',
          targetCauseType: 'POOR_LOCATION_ASSIGNMENT',
          expectedImpact: { metric: 'EXCESSIVE_PICKER_DISTANCE', expectedOutcome: 'Address the recurring pattern at its source, not just this instance.' },
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
    limitations.push('No warehouse-layout or inventory-misplacement data exists in this schema, so those causes are never evaluated or recommended against.');

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
