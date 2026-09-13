import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
  SlaAtRiskEvidence,
} from '../interfaces';
import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

/**
 * Upstream-to-downstream order of the fulfillment pipeline. SLA_AT_RISK is a downstream/
 * aggregate exception — the root cause is the EARLIEST stage with supported evidence, not
 * necessarily the highest-scoring one (an order can have both an INVENTORY_SHORTAGE and a
 * PICKING_DELAY; the shortage is the more useful "why", even if the delay scored higher).
 */
const PIPELINE_ORDER: ExceptionType[] = [
  ExceptionType.INVENTORY_SHORTAGE,
  ExceptionType.INVENTORY_DISCREPANCY,
  ExceptionType.PICKING_ERROR,
  ExceptionType.EXCESSIVE_PICKER_DISTANCE,
  ExceptionType.EXCESSIVE_PICKING_TIME,
  ExceptionType.PICKING_DELAY,
  ExceptionType.PACKING_DELAY,
  ExceptionType.DISPATCH_DELAY,
];

interface RawOrderScopedEvidence {
  orderId?: string;
}

export class SlaAtRiskAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.SLA_AT_RISK;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as SlaAtRiskEvidence;

    if (!evidence.order) {
      return this.insufficientEvidenceResult(exception, [
        'No order context is available for this SLA exception, so no upstream cause could be correlated.',
      ]);
    }

    const orderCode = evidence.order.orderId;
    const order = await logisticsDataSource.getOrderById(orderCode);
    if (!order) {
      return this.insufficientEvidenceResult(exception, [
        `Order ${orderCode} could not be found in the source system, so no upstream cause could be correlated.`,
      ]);
    }

    const orderSkus = evidence.items.map((item) => item.sku);
    const [
      pickingDelays,
      pickingErrors,
      excessiveDistances,
      excessiveTimes,
      shortages,
      discrepancies,
      packingDelays,
      dispatchDelays,
    ] = await Promise.all([
      exceptionRepository.findAllByType(ExceptionType.PICKING_DELAY),
      exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR),
      exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKER_DISTANCE),
      exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKING_TIME),
      exceptionRepository.findAllByType(ExceptionType.INVENTORY_SHORTAGE),
      exceptionRepository.findAllByType(ExceptionType.INVENTORY_DISCREPANCY),
      exceptionRepository.findAllByType(ExceptionType.PACKING_DELAY),
      exceptionRepository.findAllByType(ExceptionType.DISPATCH_DELAY),
    ]);

    const byOrderId = (list: PersistedException[]): PersistedException[] =>
      list.filter((e) => ((e.evidence ?? {}) as RawOrderScopedEvidence).orderId === orderCode);
    const byEntityId = (list: PersistedException[], entityId: string): PersistedException[] =>
      list.filter((e) => e.entityId === entityId);

    const matchesByType = new Map<ExceptionType, PersistedException[]>([
      [ExceptionType.INVENTORY_SHORTAGE, shortages.filter((e) => orderSkus.includes(e.entityId))],
      [ExceptionType.INVENTORY_DISCREPANCY, discrepancies.filter((e) => orderSkus.includes(e.entityId.split(':')[0]))],
      [ExceptionType.PICKING_ERROR, byOrderId(pickingErrors)],
      [ExceptionType.EXCESSIVE_PICKER_DISTANCE, byOrderId(excessiveDistances)],
      [ExceptionType.EXCESSIVE_PICKING_TIME, byOrderId(excessiveTimes)],
      [ExceptionType.PICKING_DELAY, byOrderId(pickingDelays)],
      [ExceptionType.PACKING_DELAY, byEntityId(packingDelays, orderCode)],
      [ExceptionType.DISPATCH_DELAY, byEntityId(dispatchDelays, orderCode)],
    ]);

    // Deliberately NOT re-sorted by score: `candidates` already reflects PIPELINE_ORDER, since it
    // was built by mapping over that fixed array and filtering. Score only affects a candidate's
    // own confidence band, never its position relative to other candidates — see PIPELINE_ORDER's comment.
    const candidates = PIPELINE_ORDER.map((type) => this.scoreCorrelatedCause(type, matchesByType.get(type) ?? [])).filter(
      (candidate) => candidate.score > 0,
    );

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
    const causalChain = this.buildCausalChain(causes, exception, orderCode);

    const limitations: string[] = [
      'Primary cause selection for SLA_AT_RISK is based on pipeline position (the earliest supported stage), not on score — SLA risk is treated as a downstream/aggregate exception, never its own root cause.',
    ];
    if (!primaryCause) {
      limitations.push(
        `No correlated inventory, picking, packing, or dispatch exception was found for order ${orderCode}. The SLA risk may be due to a cause not yet modeled by this engine, or simply an aggressive delivery window.`,
      );
    }

    const analysisExplanation = primaryCause
      ? `The earliest supported cause in this order's fulfillment pipeline is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} downstream contributing factor(s) followed: ${contributingCauses.map((c) => c.type).join(' → ')}.`
          : '')
      : 'No supported root cause could be identified for this SLA risk from currently available evidence.';

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

  /** OBSERVED: uniform scoring for "does a sibling exception of this type correlate with this order". */
  private scoreCorrelatedCause(type: ExceptionType, matches: PersistedException[]): CandidateResult {
    const w = thresholds.rootCause.slaAtRisk.weights;
    if (matches.length === 0) return emptyCandidate(type, 'OBSERVED');

    let score = w.anyMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: `${type}.exceptionId`, value: matches[0].exceptionId, weight: w.anyMatch, supports: type },
    ];
    const parts = [`A ${type} exception (${matches[0].exceptionId}) is correlated with this order.`];

    if (matches.some((m) => HIGH_SEVERITIES.includes(m.severity))) {
      score += w.highSeverity;
      parts.push('The matched exception is rated HIGH or CRITICAL.');
      evidenceItems.push({ field: `${type}.severity`, value: 'HIGH_OR_CRITICAL', weight: w.highSeverity, supports: type });
    }

    if (matches.length > 1) {
      score += w.multipleMatches;
      parts.push(`${matches.length} ${type} exceptions are correlated with this order.`);
      evidenceItems.push({ field: `${type}.matchCount`, value: matches.length, weight: w.multipleMatches, supports: type });
    }

    return { type, category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** Chains consecutive found causes in pipeline order, ending at SLA_AT_RISK — the multi-hop capability. */
  private buildCausalChain(causes: RootCause[], exception: PersistedException, orderCode: string): CausalChainLink[] {
    const chain: CausalChainLink[] = [];
    for (let i = 0; i < causes.length; i++) {
      const from = causes[i].type;
      const isLast = i === causes.length - 1;
      const to = isLast ? exception.type : causes[i + 1].type;
      const relationship = isLast
        ? `Correlated with order ${orderCode} (${exception.exceptionId}).`
        : `Both correlated with order ${orderCode}; ${from} precedes ${to} in the picking → packing → dispatch pipeline.`;
      chain.push({ from, to, relationship });
    }
    return chain;
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
      analysisExplanation: 'No supported root cause could be identified for this SLA risk from currently available evidence.',
      analyzedAt: new Date(),
    };
  }
}
