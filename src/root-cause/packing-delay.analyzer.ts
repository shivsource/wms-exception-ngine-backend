import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  PackingDelayEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { findOrdersAwaitingPackingTooLong } from '../queries';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

interface RawOrderScopedEvidence {
  orderId?: string;
}

export class PackingDelayAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.PACKING_DELAY;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as PackingDelayEvidence;

    if (!evidence.order) {
      return this.insufficientEvidenceResult(exception, [
        'No order context is available for this packing delay, so no upstream cause could be correlated.',
      ]);
    }

    const orderCode = evidence.order.orderId;

    const [pickingDelay, complexity, backlog] = await Promise.all([
      this.scorePickingDelay(orderCode),
      Promise.resolve(this.scoreOrderComplexity(evidence)),
      this.scoreQueueBacklog(orderCode),
    ]);

    const candidates = [pickingDelay, backlog, complexity].filter((candidate) => candidate.score > 0);
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
        relationship: `Correlated with order ${orderCode} (${exception.exceptionId}).`,
      }));

    const limitations: string[] = [];
    if (backlog.score > 0) {
      limitations.push(
        'Packing queue backlog is inferred from how many other orders are also waiting on packing right now; it does not indicate whether a specific packer or shortage caused this order to be delayed.',
      );
    }
    if (complexity.score > 0) {
      limitations.push(
        'Order complexity is inferred from item count/quantity; it correlates with longer packing but does not by itself prove this order was delayed because of it.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        `No picking delay was correlated with order ${orderCode}, the order is not unusually complex, and no significant packing backlog exists. The delay may be due to a cause not yet modeled by this engine (e.g. packing staffing/materials, which this schema does not record).`,
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this packing delay is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this packing delay from currently available evidence.';

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

  /** OBSERVED: correlate via the canonical orderId embedded in PICKING_DELAY's own raw evidence. */
  private async scorePickingDelay(orderCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.packingDelay.weights.pickingDelay;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.PICKING_DELAY)).filter(
      (e) => ((e.evidence ?? {}) as RawOrderScopedEvidence).orderId === orderCode,
    );
    if (matches.length === 0) return emptyCandidate(ExceptionType.PICKING_DELAY, 'OBSERVED');

    let score = w.anyMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'pickingDelay.exceptionId', value: matches[0].exceptionId, weight: w.anyMatch, supports: ExceptionType.PICKING_DELAY },
    ];
    const parts = [`A picking delay exception (${matches[0].exceptionId}) is correlated with this order.`];

    if (matches.some((m) => HIGH_SEVERITIES.includes(m.severity))) {
      score += w.highSeverity;
      parts.push('The matched picking delay is rated HIGH or CRITICAL.');
      evidenceItems.push({
        field: 'pickingDelay.severity',
        value: 'HIGH_OR_CRITICAL',
        weight: w.highSeverity,
        supports: ExceptionType.PICKING_DELAY,
      });
    }

    if (matches.length > 1) {
      score += w.multipleMatches;
      parts.push(`${matches.length} picking tasks on this order were delayed.`);
      evidenceItems.push({
        field: 'pickingDelay.matchCount',
        value: matches.length,
        weight: w.multipleMatches,
        supports: ExceptionType.PICKING_DELAY,
      });
    }

    return { type: ExceptionType.PICKING_DELAY, category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED, derived purely from this order's own evidence — no additional query. */
  private scoreOrderComplexity(evidence: PackingDelayEvidence): CandidateResult {
    const w = thresholds.rootCause.packingDelay.weights.orderComplexity;
    const c = thresholds.rootCause.packingDelay.complexity;

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    if (evidence.items.length >= c.itemCountHigh) {
      score += w.itemCount;
      parts.push(`This order has ${evidence.items.length} line items, at or above the complexity threshold (${c.itemCountHigh}).`);
      evidenceItems.push({ field: 'items.length', value: evidence.items.length, weight: w.itemCount, supports: 'ORDER_COMPLEXITY' });
    }

    const totalQuantity = evidence.items.reduce((sum, item) => sum + item.orderedQuantity, 0);
    if (totalQuantity >= c.totalQuantityHigh) {
      score += w.totalQuantity;
      parts.push(`Total ordered quantity across all items is ${totalQuantity} units.`);
      evidenceItems.push({
        field: 'items.totalOrderedQuantity',
        value: totalQuantity,
        weight: w.totalQuantity,
        supports: 'ORDER_COMPLEXITY',
      });
    }

    if (score === 0) return emptyCandidate('ORDER_COMPLEXITY', 'INFERRED');
    return { type: 'ORDER_COMPLEXITY', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED: how many other orders are also stuck waiting on packing right now. */
  private async scoreQueueBacklog(orderCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.packingDelay.weights.queueBacklog;
    const t = thresholds.rootCause.packingDelay.backlog;

    const [orders, pickingTasks, packing] = await Promise.all([
      logisticsDataSource.getOrders(),
      logisticsDataSource.getPickingTasks(),
      logisticsDataSource.getPacking(),
    ]);
    const overdue = findOrdersAwaitingPackingTooLong(orders, pickingTasks, packing, thresholds.packingDelay.thresholdMinutes, new Date());
    const otherOrders = overdue.filter((o) => o.orderId !== orderCode).length;

    const score = otherOrders >= t.highOtherOrders ? w.high : otherOrders >= t.mediumOtherOrders ? w.medium : 0;
    if (score === 0) return emptyCandidate('PACKING_QUEUE_BACKLOG', 'INFERRED');

    return {
      type: 'PACKING_QUEUE_BACKLOG',
      category: 'INFERRED',
      score,
      evidence: [
        { field: 'backlog.otherOrdersAwaitingPacking', value: otherOrders, weight: score, supports: 'PACKING_QUEUE_BACKLOG' },
      ],
      explanationParts: [`${otherOrders} other order(s) are also waiting on packing longer than the threshold right now.`],
    };
  }

  private insufficientEvidenceResult(exception: PersistedException, limitations: string[]): RootCauseAnalysis {
    return {
      exceptionId: exception.exceptionId,
      exceptionType: exception.type,
      primaryCause: null,
      contributingCauses: [],
      supportingEvidence: [],
      causalChain: [],
      limitations,
      analysisExplanation: 'No supported root cause could be identified for this packing delay from currently available evidence.',
      analyzedAt: new Date(),
    };
  }
}
