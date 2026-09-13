import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  ExcessivePickingTimeEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, matchInventoryDiscrepancies, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

interface RawPickingErrorEvidence {
  errorCount: number;
}
interface RawRatioEvidence {
  ratio: number;
}

export class ExcessivePickingTimeAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKING_TIME;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as ExcessivePickingTimeEvidence;
    const taskCode = exception.entityId;

    const [pickingError, distance, discrepancy] = await Promise.all([
      this.scorePickingError(taskCode),
      this.scoreExcessivePickerDistance(taskCode),
      this.scoreInventoryDiscrepancy(evidence),
    ]);
    const highItemCount = this.scoreHighItemCount(evidence);

    const candidates = [pickingError, distance, discrepancy, highItemCount].filter((candidate) => candidate.score > 0);
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
    if (highItemCount.score > 0) {
      limitations.push(
        'Item count is inferred from this completed task\'s own line items; it correlates with a longer pick but does not by itself prove this task was slow because of it.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        'No picking error, excessive distance, or inventory discrepancy was found for this task, and its item count is not unusually high. The delay may be due to a cause not yet modeled by this engine.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this excessive picking time is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this excessive picking time from currently available evidence.';

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

  /** OBSERVED: this task only ever fires once COMPLETED, so a sibling PICKING_ERROR is reliably queryable. */
  private async scorePickingError(taskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.excessivePickingTime.weights.pickingError;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR)).filter(
      (e) => e.entityId === taskCode,
    );
    if (matches.length === 0) return emptyCandidate('PICKING_ERROR', 'OBSERVED');

    const latest = matches[0];
    const errorCount = ((latest.evidence ?? {}) as unknown as RawPickingErrorEvidence).errorCount ?? 0;
    let score = w.sameTask;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'pickingError.exceptionId', value: latest.exceptionId, weight: w.sameTask, supports: 'PICKING_ERROR' },
    ];
    const parts = [`A picking error exception (${latest.exceptionId}) was recorded on the same task.`];

    const errorScore = errorCount >= 3 ? w.highErrorCount : errorCount >= 1 ? w.mediumErrorCount : 0;
    if (errorScore > 0) {
      score += errorScore;
      parts.push(`${errorCount} error(s) were recorded on this task.`);
      evidenceItems.push({ field: 'pickingError.errorCount', value: errorCount, weight: errorScore, supports: 'PICKING_ERROR' });
    }

    return { type: 'PICKING_ERROR', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED: same reliably-queryable-sibling reasoning as scorePickingError. */
  private async scoreExcessivePickerDistance(taskCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.excessivePickingTime.weights.excessivePickerDistance;
    const t = thresholds.excessivePickerDistance;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKER_DISTANCE)).filter(
      (e) => e.entityId === taskCode,
    );
    if (matches.length === 0) return emptyCandidate('EXCESSIVE_PICKER_DISTANCE', 'OBSERVED');

    const latest = matches[0];
    const ratio = ((latest.evidence ?? {}) as unknown as RawRatioEvidence).ratio ?? 0;
    let score = w.sameTask;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: 'excessivePickerDistance.exceptionId',
        value: latest.exceptionId,
        weight: w.sameTask,
        supports: 'EXCESSIVE_PICKER_DISTANCE',
      },
    ];
    const parts = [`An excessive picker distance exception (${latest.exceptionId}) was recorded on the same task.`];

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

  /** OBSERVED: correlate this task's items against INVENTORY_DISCREPANCY exceptions. */
  private async scoreInventoryDiscrepancy(evidence: ExcessivePickingTimeEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.excessivePickingTime.weights.inventoryDiscrepancy;
    if (evidence.items.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    const discrepancies = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_DISCREPANCY);
    const matches = matchInventoryDiscrepancies(evidence.items, discrepancies);
    if (matches.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const exactMatch = matches.find((m) => m.exact);
    if (exactMatch) {
      score += w.exactMatch;
      parts.push(`Inventory discrepancy recorded at ${exactMatch.entry.location} for SKU ${exactMatch.entry.sku} (${exactMatch.exception.exceptionId}).`);
      evidenceItems.push({
        field: `inventoryDiscrepancy.${exactMatch.exception.entityId}`,
        value: exactMatch.exception.status,
        weight: w.exactMatch,
        supports: 'INVENTORY_DISCREPANCY',
      });
    } else {
      const { entry, exception: exc } = matches[0];
      score += w.skuOnlyMatch;
      parts.push(`Inventory discrepancy recorded for SKU ${entry.sku} at ${exc.entityId}.`);
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

  /** INFERRED, derived purely from this task's own evidence — no additional query. */
  private scoreHighItemCount(evidence: ExcessivePickingTimeEvidence): CandidateResult {
    const w = thresholds.rootCause.excessivePickingTime.weights.highItemCount;
    const c = thresholds.rootCause.excessivePickingTime.complexity;

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
        supports: 'HIGH_ITEM_COUNT',
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
        supports: 'HIGH_ITEM_COUNT',
      });
    }

    if (score === 0) return emptyCandidate('HIGH_ITEM_COUNT', 'INFERRED');
    return { type: 'HIGH_ITEM_COUNT', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }
}
