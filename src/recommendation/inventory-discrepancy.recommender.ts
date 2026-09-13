import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class InventoryDiscrepancyRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.INVENTORY_DISCREPANCY;

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

    if (causeTypes.has('DAMAGED_INVENTORY')) {
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify the damaged-quantity record',
          action: 'Physically verify the damaged units at this location — damaged quantity exceeds physical quantity in the record.',
          reason: 'The root cause analysis found damage specifically exceeds the recorded physical quantity.',
          targetCauseType: 'DAMAGED_INVENTORY',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Reconcile the damaged-quantity record with the physical count.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check inventory records for this SKU',
          action: 'Review inventory records for this SKU across other locations for the same pattern.',
          reason: 'Damage-driven discrepancies may recur at other locations holding the same SKU.',
          targetCauseType: 'DAMAGED_INVENTORY',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Catch related discrepancies before they cause further issues.' },
        }),
      );
    }

    if (causeTypes.has('PICKING_ERROR')) {
      candidates.push(
        buildAction({
          actionType: 'RE_PICK',
          title: 'Initiate a controlled re-pick',
          action: 'Initiate a controlled re-pick for the affected SKU+location — a correlated picking error was recorded here.',
          reason: 'The root cause analysis correlated a picking error exception at this exact SKU and location.',
          targetCauseType: 'PICKING_ERROR',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Confirm the true count and correct the discrepancy.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify the picking record',
          action: 'Verify the picked quantity recorded against the physical count at this location.',
          reason: 'A picking error at this location may directly explain the discrepancy.',
          targetCauseType: 'PICKING_ERROR',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Determine whether the picking error explains the mismatch.' },
        }),
      );
    }

    if (causeTypes.has('STOCK_RECORD_ERROR')) {
      // High-risk inventory modification: any downstream adjustment here requires approval, but
      // this engine only ever recommends investigating — it never proposes the adjustment itself
      // without a more specific cause (damage/picking error) to justify it.
      candidates.push(
        buildAction({
          actionType: 'INVESTIGATE',
          title: 'Investigate the reservation mismatch',
          action: 'Investigate the reservation record at this location — no damage or picking error explains the mismatch.',
          reason: 'The root cause analysis found no damage or correlated picking error, defaulting to a likely record-keeping error.',
          targetCauseType: 'STOCK_RECORD_ERROR',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Identify the source of the mismatch before any data correction.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify the physical count',
          action: 'Verify the physical count at this location against the system record.',
          reason: 'A physical recount is the most direct way to confirm or resolve an unexplained mismatch.',
          targetCauseType: 'STOCK_RECORD_ERROR',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Establish ground truth for the reservation record.' },
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
