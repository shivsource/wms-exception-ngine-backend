import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  ExcessivePickerDistanceEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { exceptionRepository } from '../repositories';
import { ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

export class ExcessivePickerDistanceAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKER_DISTANCE;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as ExcessivePickerDistanceEvidence;

    const multiLocation = this.scoreMultiLocationOrder(evidence);
    const poorAssignment = await this.scorePoorLocationAssignment(evidence, exception.entityId);

    const candidates = [multiLocation, poorAssignment].filter((candidate) => candidate.score > 0);
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

    // Both candidates here are INFERRED (correlational heuristics, not sibling-exception proof
    // or a computed-total fact), so the causal chain is deliberately always empty for this type.
    const causalChain: CausalChainLink[] = [];

    const limitations: string[] = [];
    if (poorAssignment.score > 0) {
      limitations.push(
        'Poor location assignment is inferred from this picker recording excessive-distance exceptions on other tasks — it is a pattern, not proof this specific task was affected by it.',
      );
    }
    if (multiLocation.score > 0) {
      limitations.push(
        'Multi-location spread correlates with more walking, but does not itself prove this task\'s distance was caused by it rather than e.g. inefficient routing.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        'This task does not show an unusually wide location spread, and this picker has no other recorded excessive-distance exceptions. There is no data on expected/home locations in this schema, so inventory misplacement cannot be evaluated, and a single task cannot support a warehouse-layout claim.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this excessive picker distance is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this excessive picker distance from currently available evidence.';

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

  /** INFERRED: distinct pick locations correlate with more walking, but don't prove it for this task alone. */
  private scoreMultiLocationOrder(evidence: ExcessivePickerDistanceEvidence): CandidateResult {
    const w = thresholds.rootCause.excessivePickerDistance.weights.multiLocationOrder;
    const c = thresholds.rootCause.excessivePickerDistance.complexity;
    if (evidence.items.length === 0) return emptyCandidate('MULTI_LOCATION_ORDER', 'INFERRED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const distinctLocations = new Set(evidence.items.map((item) => item.location)).size;
    if (distinctLocations >= c.distinctLocationsHigh) {
      score += w.distinctLocations;
      parts.push(`This task visits ${distinctLocations} distinct locations, at or above the threshold (${c.distinctLocationsHigh}).`);
      evidenceItems.push({
        field: 'items.distinctLocationCount',
        value: distinctLocations,
        weight: w.distinctLocations,
        supports: 'MULTI_LOCATION_ORDER',
      });
    }

    // Guarded to >1 item: for a single-item task, distinctLocations/items.length is trivially
    // 1.0 ("100% spread"), which isn't a meaningful signal — there's nothing to be spread across.
    const spreadRatio = distinctLocations / evidence.items.length;
    if (evidence.items.length > 1 && spreadRatio >= c.spreadRatioHigh) {
      score += w.spreadRatio;
      parts.push(`${Math.round(spreadRatio * 100)}% of line items are each at a different location.`);
      evidenceItems.push({
        field: 'items.spreadRatio',
        value: Math.round(spreadRatio * 100) / 100,
        weight: w.spreadRatio,
        supports: 'MULTI_LOCATION_ORDER',
      });
    }

    if (evidence.items.length >= c.itemCountHigh) {
      score += w.itemCount;
      parts.push(`The task also has ${evidence.items.length} line items, compounding the distance.`);
      evidenceItems.push({
        field: 'items.length',
        value: evidence.items.length,
        weight: w.itemCount,
        supports: 'MULTI_LOCATION_ORDER',
      });
    }

    if (score === 0) return emptyCandidate('MULTI_LOCATION_ORDER', 'INFERRED');
    return { type: 'MULTI_LOCATION_ORDER', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED: a recurring pattern across other tasks for this picker, never from this task alone. */
  private async scorePoorLocationAssignment(
    evidence: ExcessivePickerDistanceEvidence,
    currentTaskCode: string,
  ): Promise<CandidateResult> {
    const w = thresholds.rootCause.excessivePickerDistance.weights.poorLocationAssignment;
    const t = thresholds.rootCause.excessivePickerDistance.pickerPattern;

    const all = await exceptionRepository.findAllByType(ExceptionType.EXCESSIVE_PICKER_DISTANCE);
    const recurring = all.filter((e) => {
      if (e.entityId === currentTaskCode) return false;
      const raw = (e.evidence ?? {}) as { pickerId?: string };
      return raw.pickerId === evidence.task.pickerId;
    });

    const score = recurring.length >= t.highRecurring ? w.high : recurring.length >= t.mediumRecurring ? w.medium : 0;
    if (score === 0) return emptyCandidate('POOR_LOCATION_ASSIGNMENT', 'INFERRED');

    return {
      type: 'POOR_LOCATION_ASSIGNMENT',
      category: 'INFERRED',
      score,
      evidence: [
        {
          field: 'poorLocationAssignment.recurringTaskCount',
          value: recurring.length,
          weight: score,
          supports: 'POOR_LOCATION_ASSIGNMENT',
        },
      ],
      explanationParts: [
        `Picker ${evidence.task.pickerId} has excessive-distance exceptions recorded on ${recurring.length} other task(s).`,
      ],
    };
  }
}
