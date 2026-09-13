import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class ExcessivePickingTimeRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKING_TIME;

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

    if (causeTypes.has('PICKING_ERROR')) {
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify the recorded picking error',
          action: 'Verify the SKU/location for the recorded picking error on this task.',
          reason: 'The root cause analysis correlated a picking error exception with this task.',
          targetCauseType: 'PICKING_ERROR',
          expectedImpact: { metric: 'EXCESSIVE_PICKING_TIME', expectedOutcome: 'Identify whether the error explains the extended duration.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'RE_PICK',
          title: 'Initiate a controlled re-pick',
          action: 'Initiate a controlled re-pick for the item(s) affected by the recorded error.',
          reason: 'A picking error on this task may require a re-pick to complete correctly.',
          targetCauseType: 'PICKING_ERROR',
          expectedImpact: { metric: 'EXCESSIVE_PICKING_TIME', expectedOutcome: 'Allow the task to complete without a repeated error.' },
        }),
      );
    }

    if (causeTypes.has('EXCESSIVE_PICKER_DISTANCE')) {
      candidates.push(
        buildAction({
          actionType: 'REASSIGN',
          title: 'Reassign to reduce travel distance',
          action: 'Reassign this task to reduce the picker\'s travel distance, which is correlated with the extended duration.',
          reason: 'The root cause analysis correlated an excessive-distance exception with this same task.',
          targetCauseType: 'EXCESSIVE_PICKER_DISTANCE',
          expectedImpact: { metric: 'EXCESSIVE_PICKING_TIME', expectedOutcome: 'Reduce picking time by lowering travel distance.' },
        }),
      );
    }

    if (causeTypes.has('INVENTORY_DISCREPANCY')) {
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check inventory at the discrepant location',
          action: 'Check inventory records at the location correlated with a discrepancy on this task.',
          reason: 'The root cause analysis correlated an inventory discrepancy with an item on this task.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'EXCESSIVE_PICKING_TIME', expectedOutcome: 'Identify whether the discrepancy explains time lost searching for stock.' },
        }),
      );
    }

    if (causeTypes.has('HIGH_ITEM_COUNT')) {
      candidates.push(
        buildAction({
          actionType: 'MONITOR',
          title: 'Monitor — item count is a contributing factor',
          action: 'No direct intervention available; monitor given this task\'s high item count.',
          reason: 'Item count correlates with longer picks but is not independently actionable in this WMS model.',
          targetCauseType: 'HIGH_ITEM_COUNT',
          expectedImpact: { metric: 'EXCESSIVE_PICKING_TIME', expectedOutcome: 'No specific improvement expected from this factor alone.' },
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
