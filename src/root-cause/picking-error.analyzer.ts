import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  PersistedException,
  PickingErrorEvidence,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, latestByEntityId, matchInventoryDiscrepancies, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

// The only error_reason values this WMS actually records (verified against real data) —
// SHORT_PICK/LOCATION_EMPTY are stock-related, WRONG_LOCATION is a location mismatch.
// There is no field anywhere that indicates a wrong-SKU pick, so SKU_CONFUSION is never scored.
const STOCK_RELATED_ERROR_REASONS = new Set(['SHORT_PICK', 'LOCATION_EMPTY']);
const LOCATION_MISMATCH_REASON = 'WRONG_LOCATION';

export class PickingErrorAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.PICKING_ERROR;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as PickingErrorEvidence;
    const taskCode = exception.entityId;

    const [discrepancy, shortage, complexity, pickerPerformance] = await Promise.all([
      this.scoreInventoryDiscrepancy(evidence),
      this.scoreInventoryShortage(evidence),
      this.scoreHighPickingComplexity(evidence),
      this.scorePickerPerformance(evidence, taskCode),
    ]);
    const locationMismatch = this.scoreLocationMismatch(evidence);

    // Fixed declaration order keeps tie-breaking (and therefore the whole analysis)
    // deterministic — Array#sort is stable, so equal scores keep this order.
    const candidates = [discrepancy, shortage, locationMismatch, complexity, pickerPerformance].filter(
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
    if (pickerPerformance.score > 0) {
      limitations.push(
        'Picker performance is inferred from error exceptions recorded on other tasks for this picker — it is a correlated pattern, not confirmed causation for this specific error.',
      );
    }
    if (complexity.score > 0) {
      limitations.push(
        'Picking complexity is inferred from task item count/error density; it correlates with more error-prone tasks but does not by itself prove this error happened because of it.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        `This task recorded ${evidence.errorCount} isolated error(s) with no matching inventory shortage, discrepancy, location-mismatch pattern, or recurring picker error history. ` +
          'The error may be due to a cause not yet modeled by this engine, or an isolated one-off mistake.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this picking error is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this picking error from currently available evidence.';

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

  /** OBSERVED: correlate errored sku+location pairs against INVENTORY_DISCREPANCY exceptions. */
  private async scoreInventoryDiscrepancy(evidence: PickingErrorEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingError.weights.inventoryDiscrepancy;
    if (evidence.errors.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    const discrepancies = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_DISCREPANCY);
    const matches = matchInventoryDiscrepancies(evidence.errors, discrepancies);
    if (matches.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const exactMatch = matches.find((m) => m.exact);
    if (exactMatch) {
      score += w.exactMatch;
      parts.push(
        `Inventory discrepancy recorded at ${exactMatch.entry.location} for SKU ${exactMatch.entry.sku} (${exactMatch.exception.exceptionId}) — the exact location of the picking error.`,
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
        `Inventory discrepancy recorded for SKU ${entry.sku} at a different location (${exc.entityId}) than the picking error's location (${entry.location}).`,
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
      parts.push(`${matches.length} picking errors on this task are affected by inventory discrepancies.`);
      evidenceItems.push({
        field: 'inventoryDiscrepancy.affectedErrorCount',
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

  /** OBSERVED: correlate errored SKUs against INVENTORY_SHORTAGE exceptions. */
  private async scoreInventoryShortage(evidence: PickingErrorEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingError.weights.inventoryShortage;
    const skus = Array.from(new Set(evidence.errors.map((error) => error.sku)));
    if (skus.length === 0) return emptyCandidate('INVENTORY_SHORTAGE', 'OBSERVED');

    const shortages = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_SHORTAGE);
    const latestBySku = latestByEntityId(shortages.filter((shortage) => skus.includes(shortage.entityId)));
    if (latestBySku.size === 0) return emptyCandidate('INVENTORY_SHORTAGE', 'OBSERVED');

    const [firstSku, firstException] = Array.from(latestBySku.entries())[0];
    let score = w.skuMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: `inventoryShortage.${firstSku}.status`,
        value: firstException.status,
        weight: w.skuMatch,
        supports: 'INVENTORY_SHORTAGE',
      },
    ];
    const parts = [
      `SKU ${firstSku}, involved in a picking error on this task, has an inventory shortage exception (${firstException.exceptionId}).`,
    ];

    if (Array.from(latestBySku.values()).some((exc) => HIGH_SEVERITIES.includes(exc.severity))) {
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

    const hasStockRelatedReason = evidence.errors.some(
      (error) => latestBySku.has(error.sku) && STOCK_RELATED_ERROR_REASONS.has(error.errorReason),
    );
    if (hasStockRelatedReason) {
      score += w.stockRelatedReason;
      parts.push(
        'The recorded error reason (SHORT_PICK/LOCATION_EMPTY) is consistent with a genuine stock shortage rather than a location mixup.',
      );
      evidenceItems.push({
        field: 'errors.errorReason',
        value: 'STOCK_RELATED',
        weight: w.stockRelatedReason,
        supports: 'INVENTORY_SHORTAGE',
      });
    }

    return { type: 'INVENTORY_SHORTAGE', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED, no correlation query — WRONG_LOCATION is a location mismatch by definition. */
  private scoreLocationMismatch(evidence: PickingErrorEvidence): CandidateResult {
    const w = thresholds.rootCause.pickingError.weights.locationMismatch;
    const wrongLocationErrors = evidence.errors.filter((error) => error.errorReason === LOCATION_MISMATCH_REASON);
    if (wrongLocationErrors.length === 0) return emptyCandidate('LOCATION_MISMATCH', 'OBSERVED');

    let score = w.anyMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'errors.errorReason', value: LOCATION_MISMATCH_REASON, weight: w.anyMatch, supports: 'LOCATION_MISMATCH' },
    ];
    const parts = [
      `${wrongLocationErrors.length} of ${evidence.errorCount} picking error(s) on this task were recorded as ${LOCATION_MISMATCH_REASON}.`,
    ];

    if (wrongLocationErrors.length > 1) {
      score += w.multipleMatches;
      parts.push(`Multiple ${LOCATION_MISMATCH_REASON} errors were recorded on this task.`);
      evidenceItems.push({
        field: 'errors.wrongLocationCount',
        value: wrongLocationErrors.length,
        weight: w.multipleMatches,
        supports: 'LOCATION_MISMATCH',
      });
    }

    if (wrongLocationErrors.length / evidence.errorCount > 0.5) {
      score += w.majorityOfErrors;
      parts.push(`${LOCATION_MISMATCH_REASON} accounts for the majority of errors on this task.`);
      evidenceItems.push({
        field: 'errors.wrongLocationRatio',
        value: Math.round((wrongLocationErrors.length / evidence.errorCount) * 100) / 100,
        weight: w.majorityOfErrors,
        supports: 'LOCATION_MISMATCH',
      });
    }

    return { type: 'LOCATION_MISMATCH', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED, derived from the task's real item count vs. this exception's own errorCount. */
  private async scoreHighPickingComplexity(evidence: PickingErrorEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingError.weights.highPickingComplexity;
    const c = thresholds.rootCause.pickingError.complexity;

    const task = await logisticsDataSource.getPickingTaskById(evidence.task.id);
    const totalItems = task?.items.length ?? 0;
    if (totalItems === 0) return emptyCandidate('HIGH_PICKING_COMPLEXITY', 'INFERRED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    if (totalItems >= c.itemCountHigh) {
      score += w.itemCount;
      parts.push(`This task has ${totalItems} line items, at or above the complexity threshold (${c.itemCountHigh}).`);
      evidenceItems.push({
        field: 'task.totalItemCount',
        value: totalItems,
        weight: w.itemCount,
        supports: 'HIGH_PICKING_COMPLEXITY',
      });
    }

    const density = evidence.errorCount / totalItems;
    if (density >= c.errorDensityHigh) {
      score += w.errorDensity;
      parts.push(`${evidence.errorCount} of ${totalItems} items on this task resulted in errors (${Math.round(density * 100)}%).`);
      evidenceItems.push({
        field: 'task.errorDensity',
        value: Math.round(density * 100) / 100,
        weight: w.errorDensity,
        supports: 'HIGH_PICKING_COMPLEXITY',
      });
    }

    const distinctSkus = new Set(evidence.errors.map((error) => error.sku)).size;
    if (distinctSkus > 1) {
      score += w.multipleSkus;
      parts.push(`Errors span ${distinctSkus} distinct SKUs.`);
      evidenceItems.push({
        field: 'errors.distinctSkuCount',
        value: distinctSkus,
        weight: w.multipleSkus,
        supports: 'HIGH_PICKING_COMPLEXITY',
      });
    }

    if (score === 0) return emptyCandidate('HIGH_PICKING_COMPLEXITY', 'INFERRED');
    return { type: 'HIGH_PICKING_COMPLEXITY', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED: a recurring pattern across other tasks for this picker, never from this task alone. */
  private async scorePickerPerformance(evidence: PickingErrorEvidence, currentTaskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.pickingError.weights.pickerPerformance;
    const t = thresholds.rootCause.pickingError.pickerPerformance;

    const allErrors = await exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR);
    const recurring = allErrors.filter((error) => {
      if (error.entityId === currentTaskCode) return false;
      const raw = (error.evidence ?? {}) as { pickerId?: string };
      return raw.pickerId === evidence.task.pickerId;
    });

    const score =
      recurring.length >= t.highRecurringErrors ? w.high : recurring.length >= t.mediumRecurringErrors ? w.medium : 0;
    if (score === 0) return emptyCandidate('PICKER_PERFORMANCE', 'INFERRED');

    return {
      type: 'PICKER_PERFORMANCE',
      category: 'INFERRED',
      score,
      evidence: [
        {
          field: 'pickerPerformance.recurringErrorTaskCount',
          value: recurring.length,
          weight: score,
          supports: 'PICKER_PERFORMANCE',
        },
      ],
      explanationParts: [
        `Picker ${evidence.task.pickerId} has picking error exceptions recorded on ${recurring.length} other task(s).`,
      ],
    };
  }
}
