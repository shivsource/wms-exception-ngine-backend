import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class PickingErrorRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.PICKING_ERROR;

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

    if (causeTypes.has('INVENTORY_DISCREPANCY')) {
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify inventory at the error location',
          action: 'Verify the physical inventory count at the error location before repeating the pick.',
          reason: 'The root cause analysis identified an inventory discrepancy at this exact location.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Reduce recurrence of errors caused by the inventory mismatch.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check inventory records for this SKU',
          action: 'Review inventory records for this SKU across all locations for the same discrepancy pattern.',
          reason: 'A confirmed discrepancy at one location may recur at others for the same SKU.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Prevent the same mismatch from causing further errors.' },
        }),
      );
    }

    if (causeTypes.has('INVENTORY_SHORTAGE')) {
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check inventory availability for this SKU',
          action: 'Check current inventory availability for the affected SKU before attempting a re-pick.',
          reason: 'The root cause analysis identified an inventory shortage for a SKU on this task.',
          targetCauseType: 'INVENTORY_SHORTAGE',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Avoid a repeated short-pick error on the same SKU.' },
        }),
      );
    }

    if (causeTypes.has('LOCATION_MISMATCH')) {
      candidates.push(
        buildAction({
          actionType: 'CHECK_LOCATION',
          title: 'Check the recorded pick location',
          action: 'Physically check the recorded location — the error reason indicates a location mismatch, not a stock issue.',
          reason: 'The root cause analysis identified this error as a location mismatch (WRONG_LOCATION).',
          targetCauseType: 'LOCATION_MISMATCH',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Correct the location record and prevent repeat mismatches.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify the SKU-to-location assignment',
          action: 'Verify the SKU-to-location assignment in the system matches the physical layout.',
          reason: 'A location mismatch may reflect a stale or incorrect system record.',
          targetCauseType: 'LOCATION_MISMATCH',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Prevent future picks from being misdirected to the wrong location.' },
        }),
      );
    }

    if (causeTypes.has('PICKER_PERFORMANCE')) {
      // The root cause analyzer only ever raises PICKER_PERFORMANCE from a recurring pattern across
      // OTHER tasks — never from this single error — so escalating here never penalizes one mistake.
      candidates.push(
        buildAction({
          actionType: 'ESCALATE',
          title: 'Escalate to supervisor for coaching review',
          action: 'Notify the warehouse supervisor of a recurring error pattern for this picker across multiple tasks.',
          reason: 'The root cause analysis found this picker has errors recorded on multiple other tasks, not just this one.',
          targetCauseType: 'PICKER_PERFORMANCE',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Reduce recurrence of errors for this picker through supervisory review.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'INVESTIGATE',
          title: 'Investigate the recurring error pattern',
          action: 'Review this picker\'s recent error history for a common contributing factor (training, task assignment, etc.).',
          reason: 'A recurring pattern across tasks warrants investigation before any corrective action.',
          targetCauseType: 'PICKER_PERFORMANCE',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'Identify whether the pattern has an addressable root cause.' },
        }),
      );
    }

    if (causeTypes.has('HIGH_PICKING_COMPLEXITY')) {
      candidates.push(
        buildAction({
          actionType: 'MONITOR',
          title: 'Monitor — task complexity is a contributing factor',
          action: 'No direct intervention available; monitor for recurrence given this task\'s high item count/error density.',
          reason: 'Task complexity correlates with more errors but is not independently actionable in this WMS model.',
          targetCauseType: 'HIGH_PICKING_COMPLEXITY',
          expectedImpact: { metric: 'PICKING_ERROR', expectedOutcome: 'No specific improvement expected from this factor alone.' },
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
