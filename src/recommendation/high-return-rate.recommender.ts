import { PersistedException, RecommendationAnalyzer, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

/** Return reasons this WMS actually records that warrant investigation (never a product-data
 *  edit — this schema has no size-chart/description field to verify against). CUSTOMER_CHANGED_MIND
 *  is deliberately excluded — it is not a warehouse-side cause this engine can act on. */
const INVESTIGATABLE_REASONS = new Set(['WRONG_SIZE', 'WRONG_ITEM', 'PRODUCT_DAMAGED', 'DEFECTIVE', 'MISSING_PART']);

export class HighReturnRateRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.HIGH_RETURN_RATE;

  async recommend(
    exception: PersistedException,
    evidenceRaw: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult> {
    const slaUrgent = isSlaUrgent(exception, evidenceRaw);
    const primary = rootCause?.primaryCause;
    const causeTypes = new Set(
      [rootCause?.primaryCause, ...(rootCause?.contributingCauses ?? [])].filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.type),
    );

    const candidates: ActionCandidateInput[] = [];

    if (primary && INVESTIGATABLE_REASONS.has(primary.type)) {
      const lowConfidence = primary.confidenceLevel === 'LOW';
      candidates.push(
        buildAction({
          actionType: lowConfidence ? 'MONITOR' : 'INVESTIGATE',
          title: lowConfidence ? `Monitor for recurrence of ${primary.type}` : `Investigate the ${primary.type} pattern`,
          action: lowConfidence
            ? `Continue monitoring — only a small number of returns cite ${primary.type} so far, insufficient to justify a product-level investigation.`
            : `Investigate the ${primary.type} pattern for this product — review recent returns citing this reason for a common thread.`,
          reason: lowConfidence
            ? 'The root cause analysis found the sample size too small to establish a recurring/systemic issue.'
            : 'The root cause analysis found a recurring pattern of this return reason for this product.',
          targetCauseType: primary.type,
          expectedImpact: { metric: 'HIGH_RETURN_RATE', expectedOutcome: `Reduce recurrence of ${primary.type} returns for this product.` },
        }),
      );
    }

    if (primary?.type === 'CUSTOMER_CHANGED_MIND') {
      candidates.push(
        buildAction({
          actionType: 'MONITOR',
          title: 'Monitor — not a warehouse-side cause',
          action: 'No operational action available; this return reason reflects customer preference, not a fulfillment issue.',
          reason: 'The root cause analysis found the recorded reason is customer-driven, not warehouse-driven.',
          targetCauseType: 'CUSTOMER_CHANGED_MIND',
          expectedImpact: { metric: 'HIGH_RETURN_RATE', expectedOutcome: 'No fulfillment-side improvement expected for this reason.' },
        }),
      );
    }

    if (causeTypes.has(ExceptionType.PICKING_ERROR)) {
      candidates.push(
        buildAction({
          actionType: 'INVESTIGATE',
          title: 'Investigate picking process for this SKU',
          action: 'Investigate the picking process for this SKU — a correlated picking error exception references it.',
          reason: 'The root cause analysis correlated a picking error exception with this SKU.',
          targetCauseType: ExceptionType.PICKING_ERROR,
          expectedImpact: { metric: 'HIGH_RETURN_RATE', expectedOutcome: 'Reduce returns caused by picking mistakes for this SKU.' },
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
      'This schema has no product-description/size-chart field, so no product-metadata edit is ever recommended — only investigation of the pattern.',
    );
    if (primary?.type === 'CUSTOMER_CHANGED_MIND') {
      limitations.push('CUSTOMER_CHANGED_MIND is not a warehouse-side cause — no operational action addresses it; the recommendation is to monitor only.');
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
