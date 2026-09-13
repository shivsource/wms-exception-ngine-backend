import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  InventoryDiscrepancyEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { exceptionRepository } from '../repositories';
import { ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, scoreToConfidence } from './shared';

// Same real-data-verified set used by the PICKING_ERROR analyzer — SHORT_PICK/LOCATION_EMPTY
// are stock-related, consistent with a genuine count mismatch rather than a location mixup.
const STOCK_RELATED_ERROR_REASONS = new Set(['SHORT_PICK', 'LOCATION_EMPTY']);

interface RawPickingErrorEvidence {
  errors: { sku: string; location: string; errorReason: string }[];
}

export class InventoryDiscrepancyAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.INVENTORY_DISCREPANCY;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as InventoryDiscrepancyEvidence;

    const pickingError = await this.scorePickingError(evidence);
    const damaged = this.scoreDamagedInventory(evidence);
    const stockRecordError = this.scoreStockRecordError(evidence, damaged.score > 0, pickingError.score > 0);

    // Fixed declaration order keeps tie-breaking deterministic: specific, directly-evidenced
    // explanations are checked before the residual "no alternative explanation" default.
    const candidates = [damaged, pickingError, stockRecordError].filter((candidate) => candidate.score > 0);
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
        relationship: `Correlated with SKU ${evidence.product.sku} at ${evidence.discrepancy.location} (${exception.exceptionId}).`,
      }));

    const limitations: string[] = [];
    if (stockRecordError.score > 0) {
      limitations.push(
        'This schema has no receiving log or inventory-movement history, so a reservation mismatch not explained by damage or a picking error defaults to a generic record-keeping error rather than a more specific cause (e.g. misplacement, unrecorded movement, receiving error).',
      );
    }
    if (!primaryCause) {
      limitations.push(
        'Neither damage, a correlated picking error, nor an unexplained reservation mismatch was found for this location. The discrepancy may be due to a cause not yet modeled by this engine.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this inventory discrepancy is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this inventory discrepancy from currently available evidence.';

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

  /** OBSERVED: this is specifically the damage-exceeds-quantity variant of the mismatch. */
  private scoreDamagedInventory(evidence: InventoryDiscrepancyEvidence): CandidateResult {
    const w = thresholds.rootCause.inventoryDiscrepancy.weights.damagedInventory;
    const { discrepancy } = evidence;
    if (discrepancy.damagedQuantity <= discrepancy.quantity) return emptyCandidate('DAMAGED_INVENTORY', 'OBSERVED');

    let score = w.damageExceedsQuantity;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: 'discrepancy.damagedQuantity',
        value: discrepancy.damagedQuantity,
        weight: w.damageExceedsQuantity,
        supports: 'DAMAGED_INVENTORY',
      },
    ];
    const parts = [
      `At ${discrepancy.location}, damaged quantity (${discrepancy.damagedQuantity}) exceeds physical quantity (${discrepancy.quantity}).`,
    ];

    if (discrepancy.damagedQuantity > discrepancy.reservedQuantity) {
      score += w.damageExceedsReservation;
      parts.push('Damage is the larger contributor to the mismatch, ahead of reservation.');
      evidenceItems.push({
        field: 'discrepancy.damagedQuantity',
        value: discrepancy.damagedQuantity,
        weight: w.damageExceedsReservation,
        supports: 'DAMAGED_INVENTORY',
      });
    }

    const otherDamagedLocations = evidence.locations.filter(
      (loc) => loc.location !== discrepancy.location && loc.damagedQuantity > 0,
    );
    if (otherDamagedLocations.length > 0) {
      score += w.multipleLocationsDamaged;
      parts.push(`Damage is also recorded at ${otherDamagedLocations.length} other location(s) for this SKU.`);
      evidenceItems.push({
        field: 'locations.otherDamagedLocationCount',
        value: otherDamagedLocations.length,
        weight: w.multipleLocationsDamaged,
        supports: 'DAMAGED_INVENTORY',
      });
    }

    return { type: 'DAMAGED_INVENTORY', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED: a PICKING_ERROR exception recorded an error at this exact sku+location. */
  private async scorePickingError(evidence: InventoryDiscrepancyEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.inventoryDiscrepancy.weights.pickingError;
    const { sku } = evidence.product;
    const { location } = evidence.discrepancy;

    const pickingErrors = await exceptionRepository.findAllByType(ExceptionType.PICKING_ERROR);
    const matches: { exception: PersistedException; errorReason: string }[] = [];
    for (const exc of pickingErrors) {
      const raw = (exc.evidence ?? {}) as unknown as RawPickingErrorEvidence;
      const match = (raw.errors ?? []).find((e) => e.sku === sku && e.location === location);
      if (match) matches.push({ exception: exc, errorReason: match.errorReason });
    }
    if (matches.length === 0) return emptyCandidate('PICKING_ERROR', 'OBSERVED');

    let score = w.exactMatch;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: `pickingError.${matches[0].exception.exceptionId}`,
        value: matches[0].errorReason,
        weight: w.exactMatch,
        supports: 'PICKING_ERROR',
      },
    ];
    const parts = [
      `A picking error (${matches[0].exception.exceptionId}) was recorded at this exact SKU+location, reason ${matches[0].errorReason}.`,
    ];

    if (matches.some((m) => STOCK_RELATED_ERROR_REASONS.has(m.errorReason))) {
      score += w.stockRelatedReason;
      parts.push('The error reason is stock-related (SHORT_PICK/LOCATION_EMPTY), consistent with a genuine count mismatch.');
      evidenceItems.push({
        field: 'pickingError.errorReason',
        value: 'STOCK_RELATED',
        weight: w.stockRelatedReason,
        supports: 'PICKING_ERROR',
      });
    }

    if (matches.length > 1) {
      score += w.multipleMatches;
      parts.push(`${matches.length} picking errors reference this exact SKU+location.`);
      evidenceItems.push({
        field: 'pickingError.matchCount',
        value: matches.length,
        weight: w.multipleMatches,
        supports: 'PICKING_ERROR',
      });
    }

    return { type: 'PICKING_ERROR', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** INFERRED: the residual explanation for a reservation-only mismatch neither damage nor a picking error explains. */
  private scoreStockRecordError(
    evidence: InventoryDiscrepancyEvidence,
    hasDamageExplanation: boolean,
    hasPickingErrorExplanation: boolean,
  ): CandidateResult {
    const w = thresholds.rootCause.inventoryDiscrepancy.weights.stockRecordError;
    const { discrepancy } = evidence;
    if (discrepancy.reservedQuantity <= discrepancy.quantity || hasDamageExplanation) {
      return emptyCandidate('STOCK_RECORD_ERROR', 'INFERRED');
    }

    let score = w.reservationMismatchUnexplained;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: 'discrepancy.reservedQuantity',
        value: discrepancy.reservedQuantity,
        weight: w.reservationMismatchUnexplained,
        supports: 'STOCK_RECORD_ERROR',
      },
    ];
    const parts = [
      `Reserved quantity (${discrepancy.reservedQuantity}) exceeds physical quantity (${discrepancy.quantity}) at ${discrepancy.location}, with no damage explaining the gap.`,
    ];

    if (!hasPickingErrorExplanation) {
      score += w.noCompetingExplanation;
      parts.push('No correlated picking error was found either, so this defaults to a likely record-keeping error.');
      evidenceItems.push({
        field: 'diagnosis.noAlternativeExplanation',
        value: true,
        weight: w.noCompetingExplanation,
        supports: 'STOCK_RECORD_ERROR',
      });
    }

    return { type: 'STOCK_RECORD_ERROR', category: 'INFERRED', score, evidence: evidenceItems, explanationParts: parts };
  }
}
