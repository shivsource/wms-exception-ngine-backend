import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  DispatchDelayEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { countAwaitingDepartureAtDock } from '../queries';
import { exceptionRepository } from '../repositories';
import { CanonicalDispatch } from '../canonical/types';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

interface RawOrderScopedEvidence {
  orderId?: string;
}

export class DispatchDelayAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.DISPATCH_DELAY;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as DispatchDelayEvidence;

    if (!evidence.order) {
      return this.insufficientEvidenceResult(exception, [
        'No order context is available for this dispatch delay, so no upstream cause could be correlated.',
      ]);
    }

    const orderCode = evidence.order.orderId;
    const dispatchRows = await logisticsDataSource.getDispatch({ orderId: orderCode });
    // At most one relevant dispatch record per order at this point (same reasoning as the evidence collector).
    const dispatchRow = dispatchRows[0] ?? null;

    const [packingDelay, pickingDelay, dockCongestion] = await Promise.all([
      this.scorePackingDelay(orderCode),
      this.scorePickingDelay(orderCode),
      dispatchRow?.dock ? this.scoreDockCongestion(dispatchRow.dock, orderCode) : Promise.resolve(emptyCandidate('DOCK_CONGESTION', 'INFERRED')),
    ]);
    const loadingDelay = this.scoreLoadingDelay(dispatchRow);

    const candidates = [packingDelay, pickingDelay, loadingDelay, dockCongestion].filter((candidate) => candidate.score > 0);
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
    if (!dispatchRow) {
      limitations.push(
        'No dispatch record exists yet for this order (it has not been loaded/assigned to a truck), so loading-stage and dock-congestion signals could not be evaluated.',
      );
    }
    if (dockCongestion.score > 0) {
      limitations.push(
        'Dock congestion is inferred from how many other orders are also waiting at the same dock right now; it does not indicate whether this specific order was blocked by it.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        `No correlated packing delay, picking delay, loading delay, or dock congestion was found for order ${orderCode}. This schema has no truck-schedule or carrier-SLA data, so TRUCK_DELAY/CARRIER_DELAY cannot be evaluated — the delay may be due to a cause not yet modeled by this engine.`,
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this dispatch delay is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this dispatch delay from currently available evidence.';

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

  /** OBSERVED: PACKING_DELAY shares this order's code as its own entityId — a direct match, no lookup needed. */
  private async scorePackingDelay(orderCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.dispatchDelay.weights.packingDelay;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.PACKING_DELAY)).filter((e) => e.entityId === orderCode);
    return this.scoreOrderCorrelatedCause(ExceptionType.PACKING_DELAY, matches, w);
  }

  /** OBSERVED: correlate via the canonical orderId embedded in PICKING_DELAY's own raw evidence. */
  private async scorePickingDelay(orderCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.dispatchDelay.weights.pickingDelay;
    const matches = (await exceptionRepository.findAllByType(ExceptionType.PICKING_DELAY)).filter(
      (e) => ((e.evidence ?? {}) as RawOrderScopedEvidence).orderId === orderCode,
    );
    return this.scoreOrderCorrelatedCause(ExceptionType.PICKING_DELAY, matches, w);
  }

  private scoreOrderCorrelatedCause(
    type: ExceptionType,
    matches: PersistedException[],
    w: { anyMatch: number; highSeverity: number; multipleMatches: number },
  ): CandidateResult {
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

  /** OBSERVED: a dispatch record exists (loaded onto a truck/dock) but hasn't departed — queried directly, not from the evidence layer. */
  private scoreLoadingDelay(dispatchRow: CanonicalDispatch | null): CandidateResult {
    const w = thresholds.rootCause.dispatchDelay.weights.loadingDelay;
    const t = thresholds.dispatchDelay.severity;
    if (!dispatchRow || !dispatchRow.loadingTime || dispatchRow.departureTime) {
      return emptyCandidate('LOADING_DELAY', 'OBSERVED');
    }

    const minutesSinceLoading = minutesBetween(dispatchRow.loadingTime, new Date());
    let score = w.baseFact;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'dispatch.loadingTime', value: dispatchRow.loadingTime.toISOString(), weight: w.baseFact, supports: 'LOADING_DELAY' },
    ];
    const parts = [`The order was loaded at ${dispatchRow.loadingTime.toISOString()} but has not departed.`];

    const ratioScore =
      minutesSinceLoading >= t.critical ? w.criticalRatio : minutesSinceLoading >= t.high ? w.highRatio : minutesSinceLoading >= t.medium ? w.mediumRatio : 0;
    if (ratioScore > 0) {
      score += ratioScore;
      parts.push(`It has been ${minutesSinceLoading} minutes since loading.`);
      evidenceItems.push({
        field: 'dispatch.minutesSinceLoading',
        value: minutesSinceLoading,
        weight: ratioScore,
        supports: 'LOADING_DELAY',
      });
    }

    return { type: 'LOADING_DELAY', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED: how many other orders are also waiting at the same dock right now. */
  private async scoreDockCongestion(dock: string, orderCode: string): Promise<CandidateResult> {
    const w = thresholds.rootCause.dispatchDelay.weights.dockCongestion;
    const t = thresholds.rootCause.dispatchDelay.dockCongestion;

    const dockDispatches = await logisticsDataSource.getDispatch({ dock, departed: false });
    const otherOrders = countAwaitingDepartureAtDock(dockDispatches, dock, orderCode);
    const score = otherOrders >= t.highOtherOrders ? w.high : otherOrders >= t.mediumOtherOrders ? w.medium : 0;
    if (score === 0) return emptyCandidate('DOCK_CONGESTION', 'INFERRED');

    return {
      type: 'DOCK_CONGESTION',
      category: 'INFERRED',
      score,
      evidence: [{ field: 'dock.otherOrdersAwaitingDeparture', value: otherOrders, weight: score, supports: 'DOCK_CONGESTION' }],
      explanationParts: [`${otherOrders} other order(s) are also waiting to depart from dock ${dock} right now.`],
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
      analysisExplanation: 'No supported root cause could be identified for this dispatch delay from currently available evidence.',
      analyzedAt: new Date(),
    };
  }
}
