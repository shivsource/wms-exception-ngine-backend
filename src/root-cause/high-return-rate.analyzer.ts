import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  HighReturnRateEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

interface RawPickingErrorEvidence {
  errors: { sku: string }[];
}

export class HighReturnRateAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.HIGH_RETURN_RATE;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as HighReturnRateEvidence;

    const reasonCandidates = this.scoreReturnReasons(evidence);
    const pickingError = await this.scorePickingError(evidence);

    const candidates = [...reasonCandidates, pickingError].filter((candidate) => candidate.score > 0);
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

    const causalChain: CausalChainLink[] = causes.map((cause) => ({
      from: cause.type,
      to: exception.type,
      relationship: `Correlated with SKU ${evidence.product.sku} (${exception.exceptionId}).`,
    }));

    const limitations: string[] = [];
    const { smallSampleThreshold } = thresholds.rootCause.highReturnRate.sampleSize;
    if (primaryCause && primaryCause.type !== ExceptionType.PICKING_ERROR) {
      const supportingCount = evidence.recentReturns.filter((r) => r.reason === primaryCause.type).length;
      if (supportingCount <= smallSampleThreshold) {
        limitations.push(
          `Only ${supportingCount} return${supportingCount === 1 ? '' : 's'} citing ${primaryCause.type} ${supportingCount === 1 ? 'was' : 'were'} observed during the ${evidence.windowDays}-day window, so the evidence is insufficient to establish a recurring/systemic issue.`,
        );
      }
    }
    if (!primaryCause) {
      limitations.push(
        evidence.recentReturns.length === 0
          ? 'No individual return records were found for this window, only the aggregate rate — no specific reason could be attributed.'
          : 'No return reason or correlated picking error was frequent or significant enough to identify a supported root cause.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this high return rate is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this high return rate from currently available evidence.';

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

  /**
   * OBSERVED: one candidate per return reason actually present in the data (never a fixed,
   * hardcoded list) — e.g. WRONG_SIZE, WRONG_ITEM, PRODUCT_DAMAGED, DEFECTIVE, MISSING_PART,
   * CUSTOMER_CHANGED_MIND all fall out of this naturally; a reason this WMS never records
   * (e.g. PACKING_DAMAGE) can never appear, since there is nothing to group by.
   */
  private scoreReturnReasons(evidence: HighReturnRateEvidence): CandidateResult[] {
    const w = thresholds.rootCause.highReturnRate.weights.returnReason;
    const s = thresholds.rootCause.highReturnRate.sampleSize;
    const total = evidence.recentReturns.length;
    if (total === 0) return [];

    const byReason = new Map<string, number>();
    for (const ret of evidence.recentReturns) {
      byReason.set(ret.reason, (byReason.get(ret.reason) ?? 0) + 1);
    }

    const results: CandidateResult[] = [];
    for (const [reason, count] of byReason) {
      let score = w.base;
      const evidenceItems: CandidateResult['evidence'] = [
        { field: `recentReturns.reason.${reason}.count`, value: count, weight: w.base, supports: reason },
      ];
      const parts = [`${count} of ${total} recorded return(s) in the window cite reason ${reason}.`];

      if (count >= s.recurringThreshold) {
        score += w.recurring;
        parts.push(`This reason recurs across ${count} separate returns.`);
        evidenceItems.push({ field: `recentReturns.reason.${reason}.recurring`, value: count, weight: w.recurring, supports: reason });
      }

      const ratio = count / total;
      if (ratio > s.majorityRatio) {
        score += w.majority;
        parts.push(`${reason} accounts for the majority (${Math.round(ratio * 100)}%) of recorded returns.`);
        evidenceItems.push({
          field: `recentReturns.reason.${reason}.ratio`,
          value: Math.round(ratio * 100) / 100,
          weight: w.majority,
          supports: reason,
        });
      }

      if (count >= s.highVolumeThreshold) {
        score += w.highVolume;
        parts.push(`${count} returns is a high enough volume to treat this as a recurring pattern rather than noise.`);
        evidenceItems.push({ field: `recentReturns.reason.${reason}.highVolume`, value: count, weight: w.highVolume, supports: reason });
      }

      results.push({ type: reason, category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts });
    }

    return results;
  }

  /** OBSERVED: correlate this SKU against sibling PICKING_ERROR exceptions whose errors reference it. */
  private async scorePickingError(evidence: HighReturnRateEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.highReturnRate.weights.pickingError;
    const sku = evidence.product.sku;

    const pickingErrors = await exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR);
    const matches = pickingErrors.filter((exc) => {
      const raw = (exc.evidence ?? {}) as unknown as RawPickingErrorEvidence;
      return (raw.errors ?? []).some((e) => e.sku === sku);
    });
    if (matches.length === 0) return emptyCandidate(ExceptionType.PICKING_ERROR, 'OBSERVED');

    let score = w.anyMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'pickingError.exceptionId', value: matches[0].exceptionId, weight: w.anyMatch, supports: ExceptionType.PICKING_ERROR },
    ];
    const parts = [`A picking error exception (${matches[0].exceptionId}) references this SKU.`];

    if (matches.some((m) => HIGH_SEVERITIES.includes(m.severity))) {
      score += w.highSeverity;
      parts.push('The matched picking error is rated HIGH or CRITICAL.');
      evidenceItems.push({
        field: 'pickingError.severity',
        value: 'HIGH_OR_CRITICAL',
        weight: w.highSeverity,
        supports: ExceptionType.PICKING_ERROR,
      });
    }
    if (matches.length > 1) {
      score += w.multipleMatches;
      parts.push(`${matches.length} picking error exceptions reference this SKU.`);
      evidenceItems.push({
        field: 'pickingError.matchCount',
        value: matches.length,
        weight: w.multipleMatches,
        supports: ExceptionType.PICKING_ERROR,
      });
    }

    return { type: ExceptionType.PICKING_ERROR, category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }
}
