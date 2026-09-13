import { logisticsDataSource } from '../adapters';
import {
  PersistedException,
  PickingDelayEvidence,
  RecommendationAnalyzer,
  RecommendationResult,
  RootCauseAnalysis,
} from '../interfaces';
import { ExceptionType } from '../types/enums';
import { ActionCandidateInput, buildAction, buildFallbackAction, isSlaUrgent, rankCandidates } from './shared';

export class PickingDelayRecommender implements RecommendationAnalyzer {
  readonly exceptionType = ExceptionType.PICKING_DELAY;

  async recommend(
    exception: PersistedException,
    evidenceRaw: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult> {
    const evidence = evidenceRaw as unknown as PickingDelayEvidence | null;
    const slaUrgent = isSlaUrgent(exception, evidenceRaw);
    const causeTypes = new Set(
      [rootCause?.primaryCause, ...(rootCause?.contributingCauses ?? [])].filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.type),
    );

    const candidates: ActionCandidateInput[] = [];
    const pendingItems = evidence?.items.filter((item) => item.pending > 0) ?? [];
    const location = pendingItems[0]?.location;

    if (causeTypes.has('INVENTORY_SHORTAGE')) {
      const hasAlternateStock = await this.hasAlternateStock(pendingItems.map((i) => i.sku));
      candidates.push(
        buildAction({
          actionType: hasAlternateStock ? 'REASSIGN' : 'REPLENISH',
          title: hasAlternateStock ? 'Reassign the picking task to a confirmed alternate location' : 'Initiate replenishment for the short SKU',
          action: hasAlternateStock
            ? `Reassign the affected picking task to an alternate inventory location with confirmed available stock${location ? ` instead of ${location}` : ''}.`
            : 'Initiate replenishment for the short SKU; no alternate location currently has confirmed available stock.',
          reason: 'The root cause analysis identified an inventory shortage rather than a picker or process issue.',
          targetCauseType: 'INVENTORY_SHORTAGE',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'Reduce further picking delay and protect the order dispatch SLA.' },
          operationalImpactConfirmed: hasAlternateStock,
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: 'Prioritize this task once stock is available',
          action: 'Prioritize this picking task ahead of others once the shortage is resolved or an alternate location is confirmed.',
          reason: 'Protects the order SLA while the inventory shortage is being addressed.',
          // Not tagged to INVENTORY_SHORTAGE: this action doesn't fix the shortage, it only
          // triages around it — so it shouldn't score as if it directly addressed the cause.
          targetCauseType: null,
          expectedImpact: { metric: 'SLA_AT_RISK', expectedOutcome: 'Improve the probability of meeting the dispatch SLA once stock is available.' },
        }),
      );
    }

    if (causeTypes.has('INVENTORY_DISCREPANCY')) {
      candidates.push(
        buildAction({
          actionType: 'VERIFY',
          title: 'Verify inventory at the affected location',
          action: `Verify the physical inventory count${location ? ` at ${location}` : ''} against the system record before continuing the pick.`,
          reason: 'The root cause analysis identified an inventory discrepancy at the pick location.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'Reduce additional picking delay caused by the inventory mismatch.' },
        }),
      );
      candidates.push(
        buildAction({
          actionType: 'CHECK_INVENTORY',
          title: 'Check inventory records for this SKU',
          action: 'Review inventory records for the affected SKU across all locations for the same discrepancy pattern.',
          reason: 'A confirmed discrepancy at one location may recur at others for the same SKU.',
          targetCauseType: 'INVENTORY_DISCREPANCY',
          expectedImpact: { metric: 'INVENTORY_DISCREPANCY', expectedOutcome: 'Prevent the same mismatch from delaying other tasks for this SKU.' },
        }),
      );
    }

    if (causeTypes.has('PICKING_ERROR')) {
      candidates.push(
        buildAction({
          actionType: 'RE_PICK',
          title: 'Initiate a controlled re-pick',
          action: 'Verify the SKU and location, then initiate a controlled re-pick for the affected line item(s).',
          reason: 'The root cause analysis identified a recorded picking error on this task.',
          targetCauseType: 'PICKING_ERROR',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'Resolve the error and allow the task to complete.' },
        }),
      );
    }

    if (causeTypes.has('EXCESSIVE_PICKER_DISTANCE') || causeTypes.has('PICKER_OVERLOAD')) {
      candidates.push(
        buildAction({
          actionType: 'REASSIGN',
          title: 'Reassign or reallocate this task',
          action: causeTypes.has('PICKER_OVERLOAD')
            ? 'Reassign this task to a picker with fewer concurrent active tasks.'
            : 'Reassign this task to optimize the picker\'s travel path, or split it across nearer locations.',
          reason: causeTypes.has('PICKER_OVERLOAD')
            ? 'The root cause analysis identified this picker as concurrently overloaded with other tasks.'
            : 'The root cause analysis identified excessive picker travel distance as a factor.',
          targetCauseType: causeTypes.has('PICKER_OVERLOAD') ? 'PICKER_OVERLOAD' : 'EXCESSIVE_PICKER_DISTANCE',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'Reduce picking time by lowering travel distance or picker load.' },
        }),
      );
    }

    if (causeTypes.has('EXCESSIVE_PICKING_TIME')) {
      candidates.push(
        buildAction({
          actionType: 'PRIORITIZE',
          title: 'Prioritize and monitor this task',
          action: 'Prioritize this task for supervisor attention given it is already running well above the warehouse average.',
          reason: 'The root cause analysis identified picking time significantly above the warehouse average.',
          targetCauseType: 'EXCESSIVE_PICKING_TIME',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'Surface the stalled task sooner to limit further delay.' },
        }),
      );
    }

    if (causeTypes.has('HIGH_ORDER_COMPLEXITY')) {
      candidates.push(
        buildAction({
          actionType: 'MONITOR',
          title: 'Monitor — order size is a contributing factor',
          action: 'No direct intervention available; monitor for completion given the order\'s high item count.',
          reason: 'Order complexity correlates with longer picks but is not independently actionable in this WMS model.',
          targetCauseType: 'HIGH_ORDER_COMPLEXITY',
          expectedImpact: { metric: 'PICKING_DELAY', expectedOutcome: 'No specific improvement expected from this factor alone.' },
        }),
      );
    }

    if (candidates.length === 0) {
      candidates.push(buildFallbackAction(exception, rootCause));
    }

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

  private async hasAlternateStock(skus: string[]): Promise<boolean> {
    if (skus.length === 0) return false;
    const rows = await Promise.all(skus.map((sku) => logisticsDataSource.getInventory({ sku })));
    return rows.flat().some((row) => row.availableQuantity > 0);
  }
}
