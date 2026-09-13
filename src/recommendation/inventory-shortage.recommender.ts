import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class InventoryShortageRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.INVENTORY_SHORTAGE;

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

    if (causeTypes.has('STOCK_DEPLETION')) {
      candidates.push(
        buildAction({
          actionType: 'REPLENISH',
          title: 'Initiate replenishment',
          action: 'Initiate replenishment for this SKU — available stock is confirmed depleted across all locations.',
          reason: 'The root cause analysis confirmed genuine stock depletion, not a data or reservation issue.',
          targetCauseType: 'STOCK_DEPLETION',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Restore inventory availability and unblock affected orders.' },
          operationalImpactConfirmed: true,
        }),
      );
    }

    if (causeTypes.has('RESERVATION_OVER_ALLOCATION')) {
      candidates.push(
        buildAction({
          actionType: 'ADJUST',
          title: 'Investigate and adjust reservation levels',
          action: 'Review and adjust the reservation records at the affected location(s) — reserved quantity exceeds physical quantity.',
          reason: 'The root cause analysis found reserved quantity exceeding physical quantity, not a genuine stock shortfall.',
          targetCauseType: 'RESERVATION_OVER_ALLOCATION',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Correct the reservation data so available stock reflects reality.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'INVESTIGATE',
          title: 'Investigate the over-reservation',
          action: 'Investigate why reservations exceed physical quantity at the affected location(s) before adjusting records.',
          reason: 'Understanding the cause of over-reservation should precede any data adjustment.',
          targetCauseType: 'RESERVATION_OVER_ALLOCATION',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Identify whether this is a one-off or a recurring data issue.' },
        }),
      );
    }

    if (causeTypes.has('DAMAGED_INVENTORY')) {
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check damaged inventory records',
          action: 'Verify the damaged-quantity records at the affected location(s) and confirm the units are genuinely unsellable.',
          reason: 'The root cause analysis found damaged inventory accounts for a meaningful share of the shortfall.',
          targetCauseType: 'DAMAGED_INVENTORY',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Confirm the true available stock and inform a replenishment decision.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'REPLENISH',
          title: 'Initiate replenishment for the damaged units',
          action: 'Initiate replenishment to cover the confirmed-damaged portion of stock.',
          reason: 'Damaged units are not available regardless of reservation status.',
          targetCauseType: 'DAMAGED_INVENTORY',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Restore sellable stock levels.' },
        }),
      );
    }

    if (causeTypes.has('INVENTORY_DISCREPANCY')) {
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify inventory at the discrepant location',
          action: 'Verify physical inventory at the location where a discrepancy was correlated with this shortage.',
          reason: 'The root cause analysis correlated this shortage with a separate inventory discrepancy exception.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'INVENTORY_SHORTAGE', expectedOutcome: 'Determine whether the discrepancy explains the shortfall.' },
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
