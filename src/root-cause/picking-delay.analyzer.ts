import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  PersistedException,
  PickingDelayEvidence,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { countActiveTasksForPicker } from '../queries';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, latestByEntityId, matchInventoryDiscrepancies, scoreToConfidence } from './shared';

/** Raw (detection-time) evidence shapes read off sibling exception rows — see the matching *.rule.ts. */
interface RawPickingErrorEvidence {
  errorCount: number;
  errors: { sku: string }[];
}
interface RawRatioEvidence {
  ratio: number;
}

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

export class PickingDelayAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.PICKING_DELAY;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as PickingDelayEvidence;
    const taskCode = evidence.task.taskCode;

    const [shortage, discrepancy, pickingError, distance, pickingTime, overload] = await Promise.all([
      this.scoreInventoryShortage(evidence),
      this.scoreInventoryDiscrepancy(evidence),
      this.scorePickingError(evidence, taskCode),
      this.scoreExcessivePickerDistance(taskCode),
      this.scoreExcessivePickingTime(evidence, taskCode),
      this.scorePickerOverload(evidence),
    ]);
    const complexity = this.scoreHighOrderComplexity(evidence);

    // Fixed declaration order below is what makes tie-breaking (and therefore the whole
    // analysis) deterministic: Array#sort is stable, so equal scores keep this order.
    const candidates = [shortage, discrepancy, pickingError, distance, pickingTime, overload, complexity].filter(
      (candidate) => candidate.score > 0,
    );
    candidates.sort((a, b) => b.score - a.score);

    const causes: RootCause[] = candidates.map((candidate) => ({
      type: candidate.type,
      category: candidate.category,
      score: candidate.score,
      confidenceLevel: scoreToConfidence(candidate.score),
      explanation: candidate.explanationParts.join(' '),
    }));

    const primaryCause = causes[0] ?? null;
    const contributingCauses = causes.slice(1);
    const supportingEvidence = candidates.flatMap((candidate) => candidate.evidence);

    const causalChain: CausalChainLink[] = causes
      .filter((cause) => cause.category === 'OBSERVED')
      .map((cause) => ({
        from: cause.type,
        to: exception.type,
        relationship: `Correlated with picking task ${taskCode} (${exception.exceptionId}).`,
      }));

    const limitations: string[] = [];
    if (distance.score === 0) {
      limitations.push(
        'Excessive picker distance could not be evaluated: that rule only fires once a task completes, and no completed-task measurement exists yet for this task.',
      );
    }
    if (overload.score > 0) {
      limitations.push(
        'Picker overload is measured at analysis time, not at the moment the delay began — it is a correlated signal, not confirmed causation.',
      );
    }
    if (complexity.score > 0) {
      limitations.push(
        'Order complexity is inferred from item count/quantity/location spread; it correlates with longer picks but does not by itself prove this task was delayed because of it.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        'No inventory shortage, discrepancy, picking error, excessive distance/time, picker overload, or order-complexity signal was found for this task. The delay may be due to a cause not yet modeled by this engine, or normal operational variance.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this picking delay is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this picking delay from currently available evidence.';

    return {
      exceptionId: exception.exceptionId,
      exceptionType: exception.type,
      primaryCause,
      contributingCauses,
      supportingEvidence,
      causalChain,
      limitations,
      analysisExplanation,
      analyzedAt: new Date(),
    };
  }

  /** OBSERVED: correlate this task's SKUs against open/recent INVENTORY_SHORTAGE exceptions. */
  private async scoreInventoryShortage(evidence: PickingDelayEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.inventoryShortage;
    const skus = Array.from(new Set(evidence.items.map((item) => item.sku)));
    if (skus.length === 0) return emptyCandidate('INVENTORY_SHORTAGE', 'OBSERVED');

    const pendingSkus = new Set(evidence.items.filter((item) => item.pending > 0).map((item) => item.sku));
    const shortages = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_SHORTAGE);
    const latestBySku = latestByEntityId(shortages.filter((shortage) => skus.includes(shortage.entityId)));
    if (latestBySku.size === 0) return emptyCandidate('INVENTORY_SHORTAGE', 'OBSERVED');

    const matches = Array.from(latestBySku.entries());
    const pendingMatches = matches.filter(([sku]) => pendingSkus.has(sku));
    const relevantMatches = pendingMatches.length > 0 ? pendingMatches : matches;

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const [firstSku, firstException] = relevantMatches[0];
    if (pendingMatches.length > 0) {
      score += w.pendingSkuMatch;
      parts.push(
        `SKU ${firstSku}, still pending on this task, has an inventory shortage exception (${firstException.exceptionId}).`,
      );
      evidenceItems.push({
        field: `inventoryShortage.${firstSku}.status`,
        value: firstException.status,
        weight: w.pendingSkuMatch,
        supports: 'INVENTORY_SHORTAGE',
      });
    } else {
      score += w.pickedOnlySkuMatch;
      parts.push(
        `SKU ${firstSku} on this task has a recorded inventory shortage (${firstException.exceptionId}), though it was already picked.`,
      );
      evidenceItems.push({
        field: `inventoryShortage.${firstSku}.status`,
        value: firstException.status,
        weight: w.pickedOnlySkuMatch,
        supports: 'INVENTORY_SHORTAGE',
      });
    }

    if (relevantMatches.some(([, exc]) => HIGH_SEVERITIES.includes(exc.severity))) {
      score += w.highSeverity;
      parts.push('The matched shortage is rated HIGH or CRITICAL.');
      evidenceItems.push({
        field: 'inventoryShortage.severity',
        value: 'HIGH_OR_CRITICAL',
        weight: w.highSeverity,
        supports: 'INVENTORY_SHORTAGE',
      });
    }

    if (latestBySku.size > 1) {
      score += w.multipleSkus;
      parts.push(`${latestBySku.size} distinct SKUs on this task are affected by inventory shortages.`);
      evidenceItems.push({
        field: 'inventoryShortage.affectedSkuCount',
        value: latestBySku.size,
        weight: w.multipleSkus,
        supports: 'INVENTORY_SHORTAGE',
      });
    }

    return { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED: correlate this task's SKU+location pairs against INVENTORY_DISCREPANCY exceptions. */
  private async scoreInventoryDiscrepancy(evidence: PickingDelayEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.inventoryDiscrepancy;
    const pendingItems = evidence.items.filter((item) => item.pending > 0);
    const relevantItems = pendingItems.length > 0 ? pendingItems : evidence.items;
    if (relevantItems.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    const discrepancies = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_DISCREPANCY);
    const matches = matchInventoryDiscrepancies(relevantItems, discrepancies);
    if (matches.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const exactMatch = matches.find((m) => m.exact);
    if (exactMatch) {
      score += w.exactMatch;
      parts.push(
        `Inventory discrepancy recorded at ${exactMatch.entry.location} for SKU ${exactMatch.entry.sku} (${exactMatch.exception.exceptionId}) — the exact pick location for this task.`,
      );
      evidenceItems.push({
        field: `inventoryDiscrepancy.${exactMatch.exception.entityId}`,
        value: exactMatch.exception.status,
        weight: w.exactMatch,
        supports: 'INVENTORY_DISCREPANCY',
      });
    } else {
      const { entry, exception: exc } = matches[0];
      score += w.skuOnlyMatch;
      parts.push(
        `Inventory discrepancy recorded for SKU ${entry.sku} at a different location (${exc.entityId}) than this task's pick location (${entry.location}).`,
      );
      evidenceItems.push({
        field: `inventoryDiscrepancy.${exc.entityId}`,
        value: exc.status,
        weight: w.skuOnlyMatch,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    if (matches.length > 1) {
      score += w.multipleItems;
      parts.push(`${matches.length} line items on this task are affected by inventory discrepancies.`);
      evidenceItems.push({
        field: 'inventoryDiscrepancy.affectedItemCount',
        value: matches.length,
        weight: w.multipleItems,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    if (matches.some(({ exception: exc }) => HIGH_SEVERITIES.includes(exc.severity))) {
      score += w.highSeverity;
      parts.push('The matched discrepancy is rated HIGH or CRITICAL.');
      evidenceItems.push({
        field: 'inventoryDiscrepancy.severity',
        value: 'HIGH_OR_CRITICAL',
        weight: w.highSeverity,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    return {
      type: 'INVENTORY_DISCREPANCY',
      category: 'OBSERVED',
      score,
      evidence: evidenceItems,
      explanationParts: parts,
    };
  }

  /** OBSERVED: a PICKING_ERROR exception recorded on this exact task. */
  private async scorePickingError(evidence: PickingDelayEvidence, taskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.pickingError;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR)).filter(
      (e) => e.entityId === taskCode,
    );
    if (matches.length === 0) return emptyCandidate('PICKING_ERROR', 'OBSERVED');

    const latest = matches[0];
    const raw = (latest.evidence ?? {}) as unknown as RawPickingErrorEvidence;
    const errorCount = raw.errorCount ?? 0;

    let score = w.sameTask;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'pickingError.exceptionId', value: latest.exceptionId, weight: w.sameTask, supports: 'PICKING_ERROR' },
    ];
    const parts = [`A picking error exception (${latest.exceptionId}) was recorded on the same task ${taskCode}.`];

    if (errorCount >= thresholds.pickingError.high) {
      score += w.highErrorCount;
      parts.push(`${errorCount} errors were recorded, at or above the high-severity threshold (${thresholds.pickingError.high}).`);
      evidenceItems.push({
        field: 'pickingError.errorCount',
        value: errorCount,
        weight: w.highErrorCount,
        supports: 'PICKING_ERROR',
      });
    } else if (errorCount >= thresholds.pickingError.medium) {
      score += w.mediumErrorCount;
      parts.push(`${errorCount} error(s) were recorded on this task.`);
      evidenceItems.push({
        field: 'pickingError.errorCount',
        value: errorCount,
        weight: w.mediumErrorCount,
        supports: 'PICKING_ERROR',
      });
    }

    const errorSkus = new Set((raw.errors ?? []).map((e) => e.sku));
    const pendingSkus = new Set(evidence.items.filter((item) => item.pending > 0).map((item) => item.sku));
    if (Array.from(errorSkus).some((sku) => pendingSkus.has(sku))) {
      score += w.pendingItemAffected;
      parts.push('At least one item with a recorded picking error is still pending on this task.');
      evidenceItems.push({
        field: 'pickingError.pendingItemOverlap',
        value: true,
        weight: w.pendingItemAffected,
        supports: 'PICKING_ERROR',
      });
    }

    return { type: 'PICKING_ERROR', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED only — no live distance field exists to infer from while a task is still in progress. */
  private async scoreExcessivePickerDistance(taskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.excessivePickerDistance;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKER_DISTANCE)).filter(
      (e) => e.entityId === taskCode,
    );
    if (matches.length === 0) return emptyCandidate('EXCESSIVE_PICKER_DISTANCE', 'OBSERVED');

    const latest = matches[0];
    const ratio = ((latest.evidence ?? {}) as unknown as RawRatioEvidence).ratio ?? 0;
    const t = thresholds.excessivePickerDistance;

    let score = w.sameTask;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: 'excessivePickerDistance.exceptionId',
        value: latest.exceptionId,
        weight: w.sameTask,
        supports: 'EXCESSIVE_PICKER_DISTANCE',
      },
    ];
    const parts = [`An excessive picker distance exception (${latest.exceptionId}) was recorded for the same task ${taskCode}.`];

    const ratioScore = ratio >= t.critical ? w.criticalRatio : ratio >= t.high ? w.highRatio : ratio >= t.medium ? w.mediumRatio : 0;
    if (ratioScore > 0) {
      score += ratioScore;
      parts.push(`Distance walked was ${ratio}x the warehouse average.`);
      evidenceItems.push({
        field: 'excessivePickerDistance.ratio',
        value: ratio,
        weight: ratioScore,
        supports: 'EXCESSIVE_PICKER_DISTANCE',
      });
    }

    return {
      type: 'EXCESSIVE_PICKER_DISTANCE',
      category: 'OBSERVED',
      score,
      evidence: evidenceItems,
      explanationParts: parts,
    };
  }

  /** OBSERVED if the task has since completed (a sibling exception exists); otherwise INFERRED
   *  from the live baseline.delayRatio already present in this exception's own evidence. */
  private async scoreExcessivePickingTime(evidence: PickingDelayEvidence, taskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.excessivePickingTime;
    const t = thresholds.excessivePickingTime;

    const matches = (await exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKING_TIME)).filter(
      (e) => e.entityId === taskCode,
    );

    if (matches.length > 0) {
      const latest = matches[0];
      const ratio = ((latest.evidence ?? {}) as unknown as RawRatioEvidence).ratio ?? 0;

      let score = w.observed.sameTask;
      const evidenceItems: CandidateResult['evidence'] = [
        {
          field: 'excessivePickingTime.exceptionId',
          value: latest.exceptionId,
          weight: w.observed.sameTask,
          supports: 'EXCESSIVE_PICKING_TIME',
        },
      ];
      const parts = [`An excessive picking time exception (${latest.exceptionId}) was recorded for the same task, once it completed.`];

      const ratioScore =
        ratio >= t.critical ? w.observed.criticalRatio : ratio >= t.high ? w.observed.highRatio : ratio >= t.medium ? w.observed.mediumRatio : 0;
      if (ratioScore > 0) {
        score += ratioScore;
        parts.push(`Completed picking time was ${ratio}x the warehouse average.`);
        evidenceItems.push({
          field: 'excessivePickingTime.ratio',
          value: ratio,
          weight: ratioScore,
          supports: 'EXCESSIVE_PICKING_TIME',
        });
      }

      return {
        type: 'EXCESSIVE_PICKING_TIME',
        category: 'OBSERVED',
        score,
        evidence: evidenceItems,
        explanationParts: parts,
      };
    }

    const ratio = evidence.baseline.delayRatio;
    if (ratio === null) return emptyCandidate('EXCESSIVE_PICKING_TIME', 'INFERRED');

    const score = ratio >= t.critical ? w.inferred.criticalRatio : ratio >= t.high ? w.inferred.highRatio : ratio >= t.medium ? w.inferred.mediumRatio : 0;
    if (score === 0) return emptyCandidate('EXCESSIVE_PICKING_TIME', 'INFERRED');

    return {
      type: 'EXCESSIVE_PICKING_TIME',
      category: 'INFERRED',
      score,
      evidence: [
        {
          field: 'baseline.delayRatio',
          value: ratio,
          weight: score,
          supports: 'EXCESSIVE_PICKING_TIME',
        },
      ],
      explanationParts: [
        `This task has been running ${ratio.toFixed(1)}x the warehouse average completion time ` +
          `(${Math.round(evidence.baseline.avgCompletedMinutes)} min) while still in progress — no completed-task ` +
          'measurement exists yet, so this is inferred from the live elapsed time rather than observed directly.',
      ],
    };
  }

  /** INFERRED — a busy picker correlates with delay but doesn't prove it caused this specific task's delay. */
  private async scorePickerOverload(evidence: PickingDelayEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingDelay.weights.pickerOverload;
    const t = thresholds.rootCause.pickingDelay.pickerOverload;
    const pickerTasks = await logisticsDataSource.getPickingTasks({ pickerId: evidence.task.pickerId });
    const concurrent = countActiveTasksForPicker(pickerTasks, evidence.task.pickerId, evidence.task.id);

    const score = concurrent >= t.highConcurrentTasks ? w.high : concurrent >= t.mediumConcurrentTasks ? w.medium : 0;
    if (score === 0) return emptyCandidate('PICKER_OVERLOAD', 'INFERRED');

    return {
      type: 'PICKER_OVERLOAD',
      category: 'INFERRED',
      score,
      evidence: [
        {
          field: 'pickerOverload.concurrentActiveTasks',
          value: concurrent,
          weight: score,
          supports: 'PICKER_OVERLOAD',
        },
      ],
      explanationParts: [`Picker ${evidence.task.pickerId} has ${concurrent} other active picking task(s) assigned right now.`],
    };
  }

  /** INFERRED, derived purely from this exception's own evidence — no additional query. */
  private scoreHighOrderComplexity(evidence: PickingDelayEvidence): CandidateResult {
    const w = thresholds.rootCause.pickingDelay.weights.highOrderComplexity;
    const c = thresholds.rootCause.pickingDelay.complexity;

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    if (evidence.items.length >= c.itemCountHigh) {
      score += w.itemCount;
      parts.push(`This task has ${evidence.items.length} line items, at or above the complexity threshold (${c.itemCountHigh}).`);
      evidenceItems.push({
        field: 'items.length',
        value: evidence.items.length,
        weight: w.itemCount,
        supports: 'HIGH_ORDER_COMPLEXITY',
      });
    }

    const totalQuantity = evidence.items.reduce((sum, item) => sum + item.requestedQuantity, 0);
    if (totalQuantity >= c.totalQuantityHigh) {
      score += w.totalQuantity;
      parts.push(`Total requested quantity across all items is ${totalQuantity} units.`);
      evidenceItems.push({
        field: 'items.totalRequestedQuantity',
        value: totalQuantity,
        weight: w.totalQuantity,
        supports: 'HIGH_ORDER_COMPLEXITY',
      });
    }

    const distinctLocations = new Set(evidence.items.map((item) => item.location)).size;
    if (distinctLocations >= c.distinctLocationsHigh) {
      score += w.distinctLocations;
      parts.push(`Items are spread across ${distinctLocations} distinct pick locations.`);
      evidenceItems.push({
        field: 'items.distinctLocationCount',
        value: distinctLocations,
        weight: w.distinctLocations,
        supports: 'HIGH_ORDER_COMPLEXITY',
      });
    }

    if (score === 0) return emptyCandidate('HIGH_ORDER_COMPLEXITY', 'INFERRED');
    return { type: 'HIGH_ORDER_COMPLEXITY', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }
}
